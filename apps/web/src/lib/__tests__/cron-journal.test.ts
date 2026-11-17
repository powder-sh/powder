// cron runs are read only from the cron daemon's own journal entries, not
// from anything that logs with the syslog tag CRON (a container's journald driver
// with tag CRON, logger -t CRON).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('cron journal filter', () => {
	it('matches the sending process, not only the tag', () => {
		const src = readFileSync(join(__dirname, '..', 'cron-observer.ts'), 'utf8')
		const cmd = src.match(/const cmd = `journalctl[^`]*`/)?.[0] ?? ''
		expect(cmd).toContain('-t CRON')
		expect(cmd).toContain('_COMM=cron')
	})
	it('the crons log view filters the same way', () => {
		const src = readFileSync(join(__dirname, '..', '..', 'app/api/crons/logs/route.ts'), 'utf8')
		for (const line of src.split('\n').filter((l) => /journalctl --no-pager[^`]*-t CRON/.test(l)))
			expect(line).toContain('_COMM=cron')
	})
})
