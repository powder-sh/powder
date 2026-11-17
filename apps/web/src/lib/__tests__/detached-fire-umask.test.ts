import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDetachedFireCommand } from '../backup-script'

// Backup and restore logs (and the status file the script writes) can carry
// psql error context with row data: they must not be world-readable.
describe('detached fire command', () => {
	it('creates the log and the files the script writes 0600 (umask 077)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'powder-fire-'))
		const bin = join(dir, 'bin')
		execFileSync('mkdir', [bin])
		// macOS has no setsid; the real one just starts a new session.
		writeFileSync(join(bin, 'setsid'), '#!/bin/bash\nexec "$@"\n')
		chmodSync(join(bin, 'setsid'), 0o755)
		const script = join(dir, 'job.sh')
		const status = join(dir, 'job.status')
		const log = join(dir, 'job.log')
		writeFileSync(
			script,
			`echo "COPY t, line 1: secret row"\nprintf 'status=success\\n' > ${JSON.stringify(status)}\n`,
		)
		const out = execFileSync(
			'bash',
			['-c', `umask 022; ${buildDetachedFireCommand(script, log, 'fired')}`],
			{
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			},
		).toString()
		expect(out.trim()).toBe('fired')
		for (let i = 0; i < 50 && !existsSync(status); i++) await new Promise((r) => setTimeout(r, 50))
		expect(statSync(log).mode & 0o777).toBe(0o600)
		expect(statSync(status).mode & 0o777).toBe(0o600)
		// The script removes itself.
		for (let i = 0; i < 50 && existsSync(script); i++) await new Promise((r) => setTimeout(r, 50))
		expect(existsSync(script)).toBe(false)
	})
})
