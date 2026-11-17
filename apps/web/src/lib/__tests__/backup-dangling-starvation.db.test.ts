import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The dangling-upload watchdog (abortDanglingUploads) against its own postgres
// (initdb in a temp dir, every migration applied, removed afterwards): the
// watchdog reads every failed row, so a database shared with other test files
// would let their watchdog runs abort these rows. Skipped where initdb is not
// installed.
//   - 51 failed rows whose 50 oldest can never be aborted: each failure counts
//     in abort_attempts (0065); after 5 the id is cleared with a logged error, and
//     the 51st row, starved until then, is aborted on the next tick.
//   - NoSuchBucket / AccessDenied: no retry can fix those, the id is cleared at once.

const hasPg = spawnSync('initdb', ['--version']).status === 0
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
	aborted: [] as string[],
	failFor: new Set<string>(),
	codeFor: new Map<string, string>(),
}))
vi.mock('minio', () => ({
	Client: class {
		async abortMultipartUpload(_bucket: string, _key: string, uploadId: string) {
			if (h.failFor.has(uploadId)) throw new Error('store unreachable')
			const code = h.codeFor.get(uploadId)
			if (code) throw Object.assign(new Error(code), { code })
			h.aborted.push(uploadId)
		}
	},
}))
vi.mock('../servers', () => ({ getServer: async () => null }))
vi.mock('../ssh', () => ({ runCommand: async () => ({ code: 0, stdout: '', stderr: '' }), writeFileViaSftp: async () => {} }))
vi.mock('../notifications', () => ({ notify: async () => {} }))
vi.mock('../hq', () => ({ reportCronToHq: async () => {} }))

// LC_ALL=C: the hermetic env drops LANG/LC_*, and on macOS initdb then refuses the
// locale and the postmaster stops with "became multithreaded during startup"
function run(cmd: string, args: string[]) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
	if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}${r.stdout}`)
	return r.stdout
}

describe.skipIf(!hasPg)('dangling upload watchdog cannot starve (own postgres)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dangling-pg-'))
	const psql = (args: string[]) => run('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-q', ...args])
	let b: typeof import('../backups')
	let d: typeof import('../db')
	const row = (id: string, uploadId: string, finishedAt: Date | null) => ({
		id,
		serverId: 'srv',
		containerName: `app_${id}`,
		s3Key: `k/${id}`,
		status: 'failed',
		s3UploadId: uploadId,
		finishedAt,
	})
	const get = async (id: string) => (await d.db.select().from(d.appBackups).where(d.eq(d.appBackups.id, id)))[0]

	beforeAll(async () => {
		run('initdb', ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8'])
		run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', join(dir, 'log'), '-w', 'start'])
		for (const f of readdirSync(migrations)
			.filter((f) => /^\d{4}_.*\.sql$/.test(f))
			.sort())
			psql(['-f', join(migrations, f)])
		d = await import('../db')
		b = await import('../backups')
	}, 120_000)
	afterAll(async () => {
		await (d?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end?.()
		spawnSync('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})

	it('51 rows, the 50 oldest never abort: given up after 5 attempts, then the 51st is aborted', async () => {
		const t = Date.now() - 3600_000
		const ids = Array.from({ length: 51 }, (_, i) => `st${String(i).padStart(2, '0')}`)
		await d.db.insert(d.appBackups).values(ids.map((id, i) => row(id, `up_${id}`, new Date(t + i * 1000))) as never)
		for (const id of ids.slice(0, 50)) h.failFor.add(`up_${id}`)
		const last = ids[50] as string
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		for (let tick = 1; tick <= 5; tick++) {
			const r = await b.abortDanglingUploads()
			expect(r.errors).toBe(50)
			expect(r.givenUp).toBe(tick === 5 ? 50 : 0)
			// the newest row waits behind the 50 older ones while they are retried
			expect((await get(last))?.s3UploadId).toBe(`up_${last}`)
		}
		for (const id of ids.slice(0, 50)) {
			const r = await get(id)
			expect(r?.s3UploadId).toBeNull()
			expect(r?.abortAttempts).toBe(5)
		}
		expect(errors).toHaveBeenCalledTimes(50)
		expect(String(errors.mock.calls[0]?.[0])).toMatch(/gave up aborting the dangling upload up_st00 .* after 5 attempt/)
		expect(await b.abortDanglingUploads()).toEqual({ aborted: 1, errors: 0, givenUp: 0 })
		expect((await get(last))?.s3UploadId).toBeNull()
		expect(h.aborted).toEqual([`up_${last}`])
		vi.restoreAllMocks()
	})

	it('NoSuchBucket / AccessDenied: given up at once, not retried', async () => {
		await d.db.insert(d.appBackups).values([row('nsb', 'up_nsb', null), row('ad', 'up_ad', null)] as never)
		h.codeFor.set('up_nsb', 'NoSuchBucket')
		h.codeFor.set('up_ad', 'AccessDenied')
		vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(await b.abortDanglingUploads()).toEqual({ aborted: 0, errors: 2, givenUp: 2 })
		for (const id of ['nsb', 'ad']) {
			const r = await get(id)
			expect(r?.s3UploadId).toBeNull()
			expect(r?.abortAttempts).toBe(1)
		}
		vi.restoreAllMocks()
	})
})
