import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Needs a migrated scratch database (every file in packages/db/drizzle applied):
//   createdb powder_test && for f in packages/db/drizzle/*.sql; do psql -d powder_test -f $f; done
//   POWDER_TEST_DATABASE_URL=postgres:///powder_test pnpm -C apps/web test
// The DB part is skipped without it. Never point it at a real powder database.
//
// The admin prune route never prunes across retention pools: scheduled and
// manual backups are counted and pruned separately (pruneBackupPools), so newer
// manual backups can never push older scheduled ones out.
const url = process.env.POWDER_TEST_DATABASE_URL
if (url) {
	process.env.DATABASE_URL = url
	process.env.POWDER_ENCRYPTION_KEY ??= 'ab'.repeat(32)
	process.env.BACKUP_S3_ENDPOINT = 'https://s3.invalid'
	process.env.BACKUP_S3_BUCKET = 'b'
	process.env.BACKUP_S3_ACCESS_KEY_ID = 'k'
	process.env.BACKUP_S3_SECRET_ACCESS_KEY = 's'
	process.env.POWDER_BACKUP_KEY = 'p'
}

const h = vi.hoisted(() => ({ removed: [] as string[] }))
vi.mock('server-only', () => ({}))
vi.mock('minio', () => ({
	Client: class {
		async removeObject(_bucket: string, key: string) {
			h.removed.push(key)
		}
	},
}))
vi.mock('../hq', () => ({ reportCronToHq: async () => {} }))
vi.mock('../notifications', () => ({ notify: async () => {} }))
vi.mock('@/lib/access', () => ({ requireUser: async () => ({ id: 'u', isAdmin: true }) }))

const SRC = join(__dirname, '../..')
function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p)
		return /\.(ts|tsx)$/.test(name) ? [p] : []
	})
}

describe('one prune authority', () => {
	it('only lib/backups.ts calls pruneBackupsForApp; the prune route uses pruneBackupPools', () => {
		const callers = sourceFiles(SRC)
			.filter((f) => /pruneBackupsForApp\s*\(/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(SRC, f))
		expect(callers).toEqual(['lib/backups.ts'])
		const route = readFileSync(join(SRC, 'app/api/internal/backups/prune/route.ts'), 'utf8')
		expect(route).toContain('pruneBackupPools(')
	})
})

describe.skipIf(!url)('admin prune route keeps the pools apart (real postgres)', () => {
	let d: typeof import('../db')
	let route: typeof import('../../app/api/internal/backups/prune/route')
	const tag = `bpp${Date.now()}`
	const server = `srv_${tag}`
	const app = `app_${tag}`

	beforeAll(async () => {
		d = await import('../db')
		route = await import('../../app/api/internal/backups/prune/route')
		const day = 24 * 3600_000
		// 7 scheduled backups, all older than the 3 manual ones.
		const rows = [
			...Array.from({ length: 7 }, (_, i) => ({ id: `bkp_${tag}_s${i}`, source: 'scheduled', age: 20 - i })),
			...Array.from({ length: 3 }, (_, i) => ({ id: `bkp_${tag}_m${i}`, source: 'manual', age: 3 - i })),
		]
		await d.db.insert(d.appBackups).values(
			rows.map((r) => ({
				id: r.id,
				serverId: server,
				containerName: app,
				s3Key: `key/${r.id}`,
				status: 'success' as const,
				source: r.source,
				sizeBytes: 1000,
				startedAt: new Date(Date.now() - r.age * day),
				finishedAt: new Date(Date.now() - r.age * day),
			})),
		)
	})
	afterAll(async () => {
		await d.db.execute(d.sql`DELETE FROM app_backups WHERE server_id = ${server}`)
	})

	const post = async (body: unknown) =>
		(await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }))) as Response

	it('7 scheduled older + 3 manual newer, keep 7, dryRun: 0 scheduled to prune, both pools listed', async () => {
		const res = await post({ dryRun: true, apps: [{ server, app, keep: 7 }] })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { results: { pool: string; kept: number; pruned: number }[] }
		const byPool = Object.fromEntries(body.results.map((r) => [r.pool, r]))
		expect(Object.keys(byPool).sort()).toEqual(['manual', 'scheduled'])
		expect(byPool.scheduled).toMatchObject({ kept: 7, pruned: 0 })
		expect(byPool.manual).toMatchObject({ kept: 3, pruned: 0 })
		expect(h.removed).toEqual([])
	})

	it('a real run with keep 7 deletes nothing; keep 5 deletes the 2 oldest scheduled only', async () => {
		vi.stubEnv('POWDER_TOKEN_BACKUP_PRUNE', '1')
		expect((await post({ dryRun: false, apps: [{ server, app, keep: 7 }] })).status).toBe(200)
		expect(h.removed).toEqual([])
		expect((await post({ dryRun: false, apps: [{ server, app, keep: 5 }] })).status).toBe(200)
		expect(h.removed.sort()).toEqual([`key/bkp_${tag}_s0`, `key/bkp_${tag}_s1`])
		vi.unstubAllEnvs()
	})
})
