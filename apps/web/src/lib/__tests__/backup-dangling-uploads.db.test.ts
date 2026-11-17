import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Needs a migrated scratch database (every file in packages/db/drizzle applied):
//   createdb powder_test && for f in packages/db/drizzle/*.sql; do psql -d powder_test -f $f; done
//   POWDER_TEST_DATABASE_URL=postgres:///powder_test pnpm -C apps/web test
// Skipped without it. Never point it at a real powder database: it writes rows.
//
// A failed backup row that still holds s3_upload_id is a multipart upload nobody
// completes: the watchdog aborts it and clears the id, once. 0064's duplicate
// cleanup keeps an uploaded_pending_complete row over a newer running one.
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

const h = vi.hoisted(() => ({
	aborted: [] as string[],
	failFor: new Set<string>(),
	goneFor: new Set<string>(),
}))

vi.mock('minio', () => ({
	Client: class {
		async abortMultipartUpload(_bucket: string, _key: string, uploadId: string) {
			if (h.failFor.has(uploadId)) throw new Error('store unreachable')
			if (h.goneFor.has(uploadId)) throw Object.assign(new Error('gone'), { code: 'NoSuchUpload' })
			h.aborted.push(uploadId)
		}
	},
}))
vi.mock('../servers', () => ({ getServer: async () => null }))
vi.mock('../ssh', () => ({ runCommand: async () => ({ code: 0, stdout: '', stderr: '' }), writeFileViaSftp: async () => {} }))
vi.mock('../notifications', () => ({ notify: async () => {} }))
vi.mock('../hq', () => ({ reportCronToHq: async () => {} }))

describe.skipIf(!url)('dangling multipart uploads of failed backups (real postgres)', () => {
	let b: typeof import('../backups')
	let d: typeof import('../db')
	const tag = `du${Date.now()}`
	const server = `srv_${tag}`
	const row = (id: string, status: string, uploadId: string | null) => ({
		id: `bkp_${tag}_${id}`,
		serverId: server,
		containerName: `app_${tag}_${id}`,
		s3Key: `k/${tag}/${id}`,
		status,
		s3UploadId: uploadId,
	})
	const get = async (id: string) =>
		(await d.db.select().from(d.appBackups).where(d.eq(d.appBackups.id, `bkp_${tag}_${id}`)))[0]

	beforeAll(async () => {
		d = await import('../db')
		b = await import('../backups')
		await d.db.insert(d.appBackups).values([
			row('a', 'failed', `up_${tag}_a`),
			row('b', 'failed', `up_${tag}_b`),
			row('gone', 'failed', `up_${tag}_gone`),
			row('ok', 'success', `up_${tag}_ok`),
			row('run', 'running', `up_${tag}_run`),
			row('none', 'failed', null),
		] as never)
	})
	afterAll(async () => {
		await d.db.execute(d.sql`DELETE FROM app_backups WHERE server_id = ${server}`)
	})

	it('aborts and clears failed rows only; a failing abort keeps the id and is retried', async () => {
		h.failFor.add(`up_${tag}_b`)
		h.goneFor.add(`up_${tag}_gone`)
		await b.abortDanglingUploads()
		expect(h.aborted).toContain(`up_${tag}_a`)
		expect(h.aborted).not.toContain(`up_${tag}_ok`)
		expect(h.aborted).not.toContain(`up_${tag}_run`)
		expect((await get('a'))?.s3UploadId).toBeNull()
		expect((await get('gone'))?.s3UploadId).toBeNull()
		expect((await get('b'))?.s3UploadId).toBe(`up_${tag}_b`)
		expect((await get('ok'))?.s3UploadId).toBe(`up_${tag}_ok`)
		expect((await get('run'))?.s3UploadId).toBe(`up_${tag}_run`)

		h.failFor.clear()
		await b.abortDanglingUploads()
		expect((await get('b'))?.s3UploadId).toBeNull()
		// idempotent: nothing left for these rows, so nothing is aborted again
		const n = h.aborted.filter((u) => u.startsWith(`up_${tag}`)).length
		await b.abortDanglingUploads()
		expect(h.aborted.filter((u) => u.startsWith(`up_${tag}`)).length).toBe(n)
	})

	it("0064's cleanup keeps an uploaded_pending_complete row over a newer running one", async () => {
		const file = readFileSync(join(__dirname, '../../../../../packages/db/drizzle/0064_app_backups_in_flight.sql'), 'utf8')
		const update = file.slice(file.indexOf('UPDATE "app_backups"'), file.indexOf(';', file.indexOf('UPDATE "app_backups"')) + 1)
		expect(update).toContain('uploaded_pending_complete')
		const t = Date.now()
		const states = await d.db.transaction(async (tx) => {
			// a temp table shadows public.app_backups for this transaction only
			await tx.execute(d.sql`CREATE TEMP TABLE app_backups (LIKE public.app_backups INCLUDING DEFAULTS) ON COMMIT DROP`)
			const ins = (id: string, app: string, status: string, ageMin: number) =>
				tx.execute(
					d.sql`INSERT INTO pg_temp.app_backups (id, server_id, container_name, s3_key, status, started_at) VALUES (${id}, 's', ${app}, 'k', ${status}, ${new Date(t - ageMin * 60_000).toISOString()}::timestamptz)`,
				)
			await ins('p_old_upc', 'p', 'uploaded_pending_complete', 30)
			await ins('p_new_run', 'p', 'running', 5)
			await ins('q_old_run', 'q', 'running', 30)
			await ins('q_new_run', 'q', 'running', 5)
			await ins('r_old_upc', 'r', 'uploaded_pending_complete', 30)
			await ins('r_new_upc', 'r', 'uploaded_pending_complete', 5)
			await tx.execute(d.sql.raw(update))
			const res = await tx.execute(d.sql`SELECT id, status FROM pg_temp.app_backups ORDER BY id`)
			const list = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Array<{ id: string; status: string }>
			return Object.fromEntries(list.map((r) => [r.id, r.status]))
		})
		expect(states).toEqual({
			p_new_run: 'failed',
			p_old_upc: 'uploaded_pending_complete',
			q_new_run: 'running',
			q_old_run: 'failed',
			r_new_upc: 'uploaded_pending_complete',
			r_old_upc: 'failed',
		})
	})
})
