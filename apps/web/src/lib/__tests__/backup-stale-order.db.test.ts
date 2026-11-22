import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { needTool } from './need-tool'
import { initdbArgs, pg, PG_BIN, pgEnv } from './pg-cluster'

// The backup staleness check runs AFTER the tick's fire step, against a real
// postgres (initdb in a temp dir, every migration applied, removed afterwards).
// A check started before the fire step read app_backups before the tick wrote an
// app's first-ever row and alerted "NO successful backup on record" for an app
// whose first backup started the same second.
//   - first-ever backup fired in this tick: no stale report
//   - the fire throws before any row exists: still reported
//   - last success older than 36h: still reported
//   - a previous tick still running (stuck): the check runs at once anyway

const hasPg = needTool('backup-stale-order.db', PG_BIN !== null, 'initdb is not installed (no postgres server binaries)')
const migrations = join(__dirname, '../../../../../packages/db/drizzle')
const port = String(20000 + Math.floor(Math.random() * 20000))
const conn = `postgres://postgres@127.0.0.1:${port}/postgres`
// Before anything imports ../db (it reads DATABASE_URL once); the modules under
// test are imported dynamically for the same reason.
if (hasPg) {
	process.env.DATABASE_URL = conn
	process.env.POWDER_ENCRYPTION_KEY = 'ab'.repeat(32)
	process.env.BACKUP_S3_ENDPOINT = 'https://s3.invalid'
	process.env.BACKUP_S3_BUCKET = 'b'
	process.env.BACKUP_S3_ACCESS_KEY_ID = 'k'
	process.env.BACKUP_S3_SECRET_ACCESS_KEY = 's'
	process.env.POWDER_BACKUP_KEY = 'p'
}

const h = vi.hoisted(() => ({
	reports: [] as { job: string; error?: string }[],
	// 'ok': a server; 'missing': getServer returns null (fire throws before any row);
	// 'hang': getServer waits for release() (a stuck tick).
	server: 'ok' as 'ok' | 'missing' | 'hang',
	release: null as null | (() => void),
}))
vi.mock('minio', () => ({
	Client: class {
		async initiateNewMultipartUpload() {
			return 'upload_1'
		}
		async presignedUrl() {
			return 'https://s3.invalid/part'
		}
		async abortMultipartUpload() {}
	},
}))
vi.mock('../servers', () => ({
	getServer: async (id: string) => {
		if (h.server === 'missing') return null
		if (h.server === 'hang') await new Promise<void>((r) => (h.release = r))
		return { id, host: '127.0.0.1', port: 22, user: 'root' }
	},
}))
vi.mock('../ssh', () => ({
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
	writeFileViaSftp: async () => {},
}))
vi.mock('../notifications', () => ({ notify: async () => {} }))
vi.mock('../hq', () => ({
	reportCronToHq: async (r: { job: string; error?: string }) => {
		h.reports.push({ job: r.job, error: r.error })
	},
}))

function run(cmd: string, args: string[]) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv() })
	if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}${r.stdout}`)
	return r.stdout
}

const NOW = new Date('2026-11-21T14:25:44.000Z')

describe.skipIf(!hasPg)('backup stale check runs after the fire step (own postgres)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'backup-stale-pg-'))
	const psql = (args: string[]) => run('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-q', ...args])
	let b: typeof import('../backups')
	let d: typeof import('../db')
	const stale = () => h.reports.filter((r) => r.job.startsWith('backup-stale:'))
	const addApp = (name: string) =>
		d.db.insert(d.appRepos).values({
			id: `repo_${name}`,
			serverId: 'srv',
			containerName: name,
			repoUrl: `git@example.com:example/${name}.git`,
			webhookToken: `tok_${name}`,
			webhookSecretEncrypted: 'x',
			deployKeyPub: 'x',
			deployKeyPrivEncrypted: 'x',
			hasPostgres: true,
		} as never)

	beforeAll(async () => {
		run(pg('initdb'), initdbArgs(join(dir, 'data')))
		run(pg('pg_ctl'), [
			'-D',
			join(dir, 'data'),
			'-o',
			`-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`,
			'-l',
			join(dir, 'log'),
			'-w',
			'start',
		])
		for (const f of readdirSync(migrations)
			.filter((f) => /^\d{4}_.*\.sql$/.test(f))
			.sort())
			psql(['-f', join(migrations, f)])
		d = await import('../db')
		b = await import('../backups')
	}, 120_000)
	afterAll(async () => {
		await (d?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end?.()
		spawnSync(pg('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})
	beforeEach(async () => {
		// Only Date: postgres and the tick's deadlines keep real timers.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		h.reports.length = 0
		h.server = 'ok'
		h.release = null
		await d.db.delete(d.appBackups)
		await d.db.delete(d.appRepos)
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('first-ever backup fired in this tick: no stale report', async () => {
		await addApp('newapp')
		await b.backupTick()
		const rows = await d.db.select().from(d.appBackups)
		expect(rows.map((r) => [r.containerName, r.status])).toEqual([['newapp', 'running']])
		expect(stale()).toEqual([])
	})

	it('the fire throws before any row exists: still reported', async () => {
		await addApp('noserver')
		h.server = 'missing'
		await b.backupTick()
		expect(await d.db.select().from(d.appBackups)).toEqual([])
		expect(stale()).toHaveLength(1)
		expect(stale()[0]?.job).toBe('backup-stale:noserver')
		expect(stale()[0]?.error).toMatch(/NO successful backup on record/)
	})

	it('last success older than 36h: reported even while the new backup runs', async () => {
		await addApp('oldapp')
		await d.db.insert(d.appBackups).values({
			id: 'bkp_old',
			serverId: 'srv',
			containerName: 'oldapp',
			s3Key: 'k/old',
			status: 'success',
			startedAt: new Date(NOW.getTime() - 40 * 3600_000),
			finishedAt: new Date(NOW.getTime() - 40 * 3600_000 + 60_000),
		} as never)
		await b.backupTick()
		expect(stale()).toHaveLength(1)
		expect(stale()[0]?.error).toMatch(/last successful backup 40h ago/)
	})

	it('a previous tick is stuck: the next tick still runs the stale check', async () => {
		await addApp('stuckapp')
		h.server = 'hang'
		const stuck = b.backupTick()
		// wait until the first tick is parked inside its fire step
		for (let i = 0; i < 200 && !h.release; i++) await new Promise((r) => setTimeout(r, 10))
		expect(h.release).not.toBeNull()
		await b.backupTick()
		expect(stale().map((r) => r.job)).toEqual(['backup-stale:stuckapp'])
		h.server = 'ok'
		h.release?.()
		await stuck
	})
})
