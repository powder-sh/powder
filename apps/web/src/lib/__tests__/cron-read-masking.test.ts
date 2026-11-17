// Cron text is masked at read too (rows stored before write-time masking), and
// a masked host command cannot be imported as a managed job unchanged.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeJob } from '../cron-job-view'
import { parseJobInput } from '../managed-crons'

describe('serializeJob masks stored run text', () => {
	it('lastRunError and runs error/output', () => {
		const job = serializeJob(
			{ id: 'c', lastRunError: 'curl: PGPASSWORD=oldraw111 failed', runningSince: null } as never,
			[{ id: 'r', error: 'DB_PASSWORD=oldraw222', output: 'token GH_TOKEN=oldraw333' } as never],
		)
		const s = JSON.stringify(job)
		for (const raw of ['oldraw111', 'oldraw222', 'oldraw333']) expect(s).not.toContain(raw)
	})
})

describe('importing a masked host command', () => {
	it('is refused with a clear message', () => {
		const r = parseJobInput({
			schedule: '0 6 * * *',
			kind: 'exec',
			execArgv: ['sh', '-c', 'PGPASSWORD=[redacted] pg_dump'],
		})
		expect(r.ok).toBe(false)
		expect(r.ok === false && r.error).toContain('[redacted]')
	})
})

describe('container crons route', () => {
	it('masks hostJobs commands', () => {
		const src = readFileSync(
			join(__dirname, '../../app/api/servers/[id]/containers/[name]/crons/route.ts'),
			'utf8',
		)
		expect(src).toContain(
			'hostJobs: matchedHost.map((h) => ({ ...h, command: redactSecrets(h.command) }))',
		)
	})
})
