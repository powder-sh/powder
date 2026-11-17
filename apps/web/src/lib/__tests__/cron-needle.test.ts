// The /crons page posts the command as GET /api/crons returned it: masked. The
// logs grep needle stops at the first mask token so it still matches the real
// command in the journal.
import { describe, expect, it } from 'vitest'
import { grepNeedle } from '../cron-needle'
import { redactSecrets } from '../secret-text'

describe('grepNeedle on masked commands', () => {
	it('cuts at the first mask token', () => {
		const masked = redactSecrets(
			'/usr/local/bin/backup --s3 https://u:hunter2pw@s3.example/b && echo ok',
		)
		const needle = grepNeedle(masked)
		expect(needle).toBe('/usr/local/bin/backup --s3 https://')
		expect(needle).not.toContain('[redacted]')
		const real = '/usr/local/bin/backup --s3 https://u:hunter2pw@s3.example/b && echo ok'
		expect(real.includes(needle)).toBe(true)
	})
	it('a masked leading VAR=value is still stripped', () => {
		expect(grepNeedle(redactSecrets('PGPASSWORD=pw123456 pg_dump app'))).toBe('pg_dump app')
	})
	it('unmasked commands are unchanged from before', () => {
		expect(grepNeedle("bash -c 'cd /opt/app && node job.js'")).toBe('node job.js')
	})
})
