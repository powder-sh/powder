import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Needs a migrated scratch database (every file in packages/db/drizzle applied):
//   createdb powder_test && for f in packages/db/drizzle/*.sql; do psql -d powder_test -f $f; done
//   POWDER_TEST_DATABASE_URL=postgres:///powder_test pnpm -C apps/web test
// Skipped without it. Never point it at a real powder database: it writes rows.
//
// A token scoped to POST /api/projects/*/backups must not be able to wipe backup
// history: a manual success prunes manual backups only (BACKUP_KEEP_MANUAL_PER_APP),
// manual backups run one at a time per app, are rate limited per app for tokens
// and capped per app per day for every caller but an admin browser session.
// SSH and S3 are stubbed; the rows are real.
const url = process.env.POWDER_TEST_DATABASE_URL
if (url) {
	process.env.DATABASE_URL = url
	process.env.POWDER_ENCRYPTION_KEY ??= 'ab'.repeat(32)
	process.env.BACKUP_KEEP_PER_APP = '2'
	process.env.BACKUP_KEEP_MANUAL_PER_APP = '3'
	process.env.BACKUP_S3_ENDPOINT = 'https://s3.invalid'
	process.env.BACKUP_S3_BUCKET = 'b'
	process.env.BACKUP_S3_ACCESS_KEY_ID = 'k'
	process.env.BACKUP_S3_SECRET_ACCESS_KEY = 's'
	process.env.POWDER_BACKUP_KEY = 'p'
}

const h = vi.hoisted(() => ({
	removed: [] as string[],
	repo: null as null | Record<string, unknown>,
	user: { id: 'u', isAdmin: true, viaToken: true, tokenId: 't' } as Record<string, unknown>,
}))

vi.mock('minio', () => ({
	Client: class {
		async initiateNewMultipartUpload() {
			return 'upload-1'
		}
		async presignedUrl() {
			return 'https://s3.invalid/part'
		}
		async removeObject(_bucket: string, key: string) {
			h.removed.push(key)
		}
		async completeMultipartUpload() {}
		async abortMultipartUpload() {}
		async statObject() {
			return null
		}
	},
}))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 'srv', host: 'h', name: 'srv' }) }))
// Every SSH call succeeds; a poll reads a finished (single-PUT) status file.
vi.mock('../ssh', () => ({
	runCommand: async () => ({ code: 0, stdout: 'status=success\nsize=1000\n', stderr: '' }),
	writeFileViaSftp: async () => {},
}))
vi.mock('../notifications', () => ({ notify: async () => {} }))
vi.mock('../hq', () => ({ reportCronToHq: async () => {} }))
vi.mock('@/lib/access', () => ({
	requireProjectAccess: async () => ({ user: h.user, repo: h.repo }),
}))
vi.mock('@/lib/backup-restore', () => ({ listRestoresForApp: async () => [], restoreUrlHint: async () => null }))

describe.skipIf(!url)('token-triggered backups vs retention (real postgres)', () => {
	let b: typeof import('../backups')
	let d: typeof import('../db')
	let route: typeof import('../../app/api/projects/[id]/backups/route')
	const tag = `bt${Date.now()}`
	const server = `srv_${tag}`
	const app = `app_${tag}`
	const seeded = ['seed1', 'seed2', 'seed3'].map((s) => `bkp_${tag}_${s}`)

	const rows = () =>
		d.db
			.select()
			.from(d.appBackups)
			.where(d.and(d.eq(d.appBackups.serverId, server), d.eq(d.appBackups.containerName, app)))
	const post = async () =>
		(await route.POST(new Request('http://x', { method: 'POST' }), {
			params: Promise.resolve({ id: 'rep_x' }),
		})) as Response
	async function waitForRunning(n: number) {
		for (let i = 0; i < 100; i++) {
			if ((await rows()).filter((r) => r.source === 'manual').length >= n) return
			await new Promise((res) => setTimeout(res, 20))
		}
		throw new Error('manual backup row never appeared')
	}

	beforeAll(async () => {
		d = await import('../db')
		b = await import('../backups')
		route = await import('../../app/api/projects/[id]/backups/route')
		h.repo = { id: `rep_${tag}`, serverId: server, containerName: app, hasPostgres: true }
		const day = 24 * 3600_000
		await d.db.insert(d.appBackups).values(
			seeded.map((id, i) => ({
				id,
				serverId: server,
				containerName: app,
				s3Key: `key/${id}`,
				status: 'success' as const,
				sizeBytes: 1000,
				startedAt: new Date(Date.now() - (10 - i) * day),
				finishedAt: new Date(Date.now() - (10 - i) * day),
			})),
		)
	})
	afterAll(async () => {
		await d.db.execute(d.sql`DELETE FROM app_backups WHERE server_id LIKE ${`srv_${tag}%`}`)
	})

	it('KEEP=2, 3 older successes, two token triggers: the seeded rows are not pruned', async () => {
		expect((await post()).status).toBe(202)
		await waitForRunning(1)
		// a second trigger while the first runs is refused
		expect((await post()).status).toBe(409)
		await b.pollPendingBackups()

		expect((await post()).status).toBe(202)
		await waitForRunning(2)
		await b.pollPendingBackups()

		const all = await rows()
		expect(all.filter((r) => r.source === 'manual' && r.status === 'success')).toHaveLength(2)
		for (const id of seeded) expect(all.find((r) => r.id === id)?.prunedAt).toBeNull()
		expect(h.removed).toEqual([])
		// third token trigger in the window: rate limited
		expect((await post()).status).toBe(429)
	})

	it('the next scheduled success prunes scheduled backups only, never the manual ones', async () => {
		await b.runBackupForApp(h.repo as never, { source: 'scheduled' })
		await b.pollPendingBackups()
		const all = await rows()
		// scheduled: 3 seeded + 1 new, keep 2 -> the 2 oldest seeded go
		expect(h.removed.sort()).toEqual([`key/${seeded[0]}`, `key/${seeded[1]}`].sort())
		expect(all.find((r) => r.id === seeded[2])?.prunedAt).toBeNull()
		for (const r of all.filter((x) => x.source === 'manual')) expect(r.prunedAt).toBeNull()
	})

	it('KEEP_MANUAL=3: after 5 manual successes the 2 oldest manual go, scheduled ones stay', async () => {
		const before = new Set(h.removed)
		for (let i = 0; i < 3; i++) {
			await b.runBackupForApp(h.repo as never, { source: 'manual' })
			await b.pollPendingBackups()
		}
		const all = await rows()
		const manual = all
			.filter((r) => r.source === 'manual' && r.status === 'success')
			.sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())
		expect(manual).toHaveLength(5)
		expect(manual.filter((r) => r.prunedAt === null)).toHaveLength(3)
		expect(manual.slice(0, 2).every((r) => r.prunedAt !== null)).toBe(true)
		expect(h.removed.filter((k) => !before.has(k)).sort()).toEqual(manual.slice(0, 2).map((r) => r.s3Key).sort())
		// scheduled pool untouched by manual retention: still the newest 2
		const scheduled = all.filter((r) => r.source === 'scheduled' && r.status === 'success' && r.prunedAt === null)
		expect(scheduled).toHaveLength(2)
	})

	it('daily cap: a non-admin session is refused at 12 manual rows in 24h, older rows do not count', async () => {
		const other = `${app}_cap`
		h.repo = { ...(h.repo as object), containerName: other }
		h.user = { id: 'u2', isAdmin: false, viaToken: false }
		const mk = (n: number, ageMs: number) =>
			Array.from({ length: n }, (_, i) => ({
				id: `bkp_${tag}_cap_${ageMs}_${i}`,
				serverId: server,
				containerName: other,
				s3Key: `k/cap/${ageMs}/${i}`,
				status: 'failed' as const,
				source: 'manual',
				startedAt: new Date(Date.now() - ageMs - i * 1000),
			}))
		await d.db.insert(d.appBackups).values([...mk(11, 3600_000), ...mk(5, 25 * 3600_000)])
		expect((await post()).status).toBe(202)
		for (let i = 0; i < 100 && !(await b.liveInFlightBackup(server, other)); i++) {
			await new Promise((res) => setTimeout(res, 20))
		}
		await b.pollPendingBackups()
		expect(await b.liveInFlightBackup(server, other)).toBeNull()
		const r = await post()
		expect(r.status).toBe(429)
		expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0)
		h.repo = { ...(h.repo as object), containerName: app }
		h.user = { id: 'u', isAdmin: true, viaToken: true, tokenId: 't' }
	})

	it('the partial unique index refuses a second in-flight row', async () => {
		const other = `${app}_idx`
		await d.db.insert(d.appBackups).values({ id: `bkp_${tag}_i1`, serverId: server, containerName: other, s3Key: 'k', status: 'running' })
		await expect(
			d.db.insert(d.appBackups).values({ id: `bkp_${tag}_i2`, serverId: server, containerName: other, s3Key: 'k', status: 'running' }),
		).rejects.toThrow()
		const repo = { ...(h.repo as object), containerName: other } as never
		await expect(b.runBackupForApp(repo)).rejects.toBeInstanceOf(b.BackupInFlightError)
	})

	it('a stale in-flight row (crashed run, past the URL expiry) is reaped and the new run goes ahead', async () => {
		const other = `${app}_stale`
		const staleId = `bkp_${tag}_stale`
		await d.db.insert(d.appBackups).values({
			id: staleId,
			serverId: server,
			containerName: other,
			s3Key: 'k',
			status: 'running',
			startedAt: new Date(Date.now() - 25 * 3600_000),
		})
		expect(await b.liveInFlightBackup(server, other)).toBeNull()
		const repo = { ...(h.repo as object), containerName: other } as never
		const fresh = await b.runBackupForApp(repo)
		expect(fresh.status).toBe('running')
		expect(fresh.source).toBe('manual')
		const [stale] = await d.db.select().from(d.appBackups).where(d.eq(d.appBackups.id, staleId))
		expect(stale?.status).toBe('failed')
		expect(stale?.error).toMatch(/\[watchdog\] still in flight/)
	})
})
