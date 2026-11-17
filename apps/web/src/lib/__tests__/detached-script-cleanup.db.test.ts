import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The backup and restore scripts hold the backup passphrase and presigned URLs.
// When the fire after the SFTP write fails, the script file is removed again.
// The live restore log handed to the dashboard is redacted like the saved one.
//
// Needs a migrated scratch database (every file in packages/db/drizzle applied):
//   POWDER_TEST_DATABASE_URL=postgres:///powder_test pnpm -C apps/web test
// Skipped without it. Never point it at a real powder database: it writes rows.
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
	commands: [] as string[],
	written: [] as string[],
	pollOut: '',
}))

vi.mock('minio', () => ({
	Client: class {
		async initiateNewMultipartUpload() {
			return 'upload-1'
		}
		async presignedUrl() {
			return 'https://s3.invalid/part'
		}
		async presignedGetObject() {
			return 'https://s3.invalid/object'
		}
		async statObject() {
			return { size: 1000 }
		}
		async removeObject() {}
		async completeMultipartUpload() {}
		async abortMultipartUpload() {}
	},
}))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 'srv', host: 'h', name: 'srv' }) }))
// The fire commands fail; every other command succeeds.
vi.mock('../ssh', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		h.commands.push(cmd)
		if (cmd.includes('fired')) return { code: 1, stdout: '', stderr: 'no space left' }
		if (cmd.includes('---powder-log---')) return { code: 0, stdout: h.pollOut, stderr: '' }
		return { code: 0, stdout: '', stderr: '' }
	},
	writeFileViaSftp: async (_s: unknown, path: string) => {
		h.written.push(path)
	},
}))
vi.mock('../notifications', () => ({ notify: async () => {} }))
vi.mock('../hq', () => ({ reportCronToHq: async () => {} }))

describe.skipIf(!url)('detached script cleanup and log redaction (real postgres)', () => {
	let d: typeof import('../db')
	const tag = `dsc${Date.now()}`
	const server = `srv_${tag}`
	const app = `app_${tag}`
	const repo = { id: `rep_${tag}`, serverId: server, containerName: app, hasPostgres: true }

	beforeAll(async () => {
		d = await import('../db')
	})
	afterAll(async () => {
		await d.db.execute(d.sql`DELETE FROM app_backup_restores WHERE server_id = ${server}`)
		await d.db.execute(d.sql`DELETE FROM app_backups WHERE server_id = ${server}`)
	})

	it('a backup whose fire fails removes its script', async () => {
		const b = await import('../backups')
		h.commands.length = 0
		h.written.length = 0
		await expect(b.runBackupForApp(repo as never, { source: 'manual' })).rejects.toThrow(/failed to fire/)
		const path = h.written.find((p) => p.startsWith('/tmp/powder-backup-'))
		expect(path).toBeTruthy()
		expect(h.commands).toContain(`rm -f -- '${path}'`)
	})

	it('a restore whose fire fails removes its script', async () => {
		const r = await import('../backup-restore')
		const bkpId = `bkp_${tag}_ok`
		await d.db.insert(d.appBackups).values({
			id: bkpId,
			serverId: server,
			containerName: app,
			s3Key: `k/${bkpId}`,
			status: 'success',
			sizeBytes: 1000,
			finishedAt: new Date(),
		})
		h.commands.length = 0
		h.written.length = 0
		await expect(r.startRestore(repo as never, bkpId, 'verify', 'u1')).rejects.toThrow(/failed to start restore/)
		const path = h.written.find((p) => p.startsWith('/tmp/powder-restore-'))
		expect(path).toBeTruthy()
		expect(h.commands).toContain(`rm -f -- '${path}'`)
	})

	it('pollRestore returns the live log redacted', async () => {
		const r = await import('../backup-restore')
		const { redactSecrets } = await import('../secret-text')
		const secret = 'postgres://app:hunter2secret@db:5432/app'
		expect(redactSecrets(secret)).not.toContain('hunter2secret')
		const [row] = await d.db
			.insert(d.appBackupRestores)
			.values({
				id: `brs_${tag}_live`,
				kind: 'restore',
				backupId: `bkp_${tag}_ok`,
				serverId: server,
				containerName: `${app}_live`,
				targetDb: 'app_restore_20261112_1000',
				status: 'running',
				requestedBy: 'u1',
			})
			.returning()
		h.pollOut = `ALIVE\n---powder-status---\nMISSING\n---powder-log---\nconnecting to ${secret}\n`
		const polled = await r.pollRestore(row as never)
		expect(polled.log).toContain('connecting to')
		expect(polled.log).not.toContain('hunter2secret')
	})
})
