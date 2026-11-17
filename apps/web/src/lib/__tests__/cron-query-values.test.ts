import { describe, expect, it } from 'vitest'
import { parseCrontab } from '../crons'
import { mapHostCron } from '../managed-crons'

// the cron import also drops a query parameter whose VALUE looks like a token
// (20+ chars of base64url / hex), whatever the parameter is called.

function map(line: string) {
	const [c] = parseCrontab(line)
	if (!c) throw new Error('no cron line')
	return mapHostCron(c.schedule, c.command, 'demoapp', c.comment)
}

describe('cron import: token-looking query values', () => {
	it('drops a hex / base64url value under an innocent name, with the same note', () => {
		const r = map('*/5 * * * * curl -fsS "http://127.0.0.1:3000/api/cron/run?job=digest&k=3f9a1c0be47d22a8c6f1e0b9d4a7c3e2&s=Zm9vYmFyYmF6cXV4cXV1eF9fLQ&page=2"')
		expect(r.ok).toBe(true)
		if (!r.ok) return
		expect(r.draft.urlPath).toBe('/api/cron/run?job=digest&page=2')
		expect(r.warnings.join(' ')).toContain('k, s dropped')
		expect(r.warnings.join(' ')).toContain('bearer')
	})
	it('keeps ordinary values (short, or with characters a token does not have)', () => {
		const r = map('0 * * * * curl "http://127.0.0.1:3000/api/tick?job=nightly-digest&date=2026-11-09&q=hello%20world%20from%20cron&n=1234567890123456789"')
		expect(r.ok && r.draft.urlPath).toBe('/api/tick?job=nightly-digest&date=2026-11-09&q=hello%20world%20from%20cron&n=1234567890123456789')
	})
})
