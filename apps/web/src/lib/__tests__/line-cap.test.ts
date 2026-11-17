// the long-line cap treats \r as a line break and keeps the head
// and the tail of a long line around the cut marker; the line is masked whole
// first (up to 64 KB), so the tail never carries half a secret.
import { describe, expect, it } from 'vitest'
import { LINE_MAX_CHARS, redactSecrets } from '../secret-text'

const filler = (n: number) => 'word '.repeat(Math.ceil(n / 5)).slice(0, n)

describe('long-line cap', () => {
	it('\\r ends a line: short \\r-separated segments are kept and masked one by one', () => {
		const seg = Array.from({ length: 400 }, (_, i) => `step ${i} 42% done`).join('\r')
		const text = `${seg}\rERROR: npm ci failed PGPASSWORD=hunter2hunter2 at the end\r`
		const out = redactSecrets(text)
		expect(out).toContain('ERROR: npm ci failed')
		expect(out).not.toContain('hunter2hunter2')
		expect(out).not.toContain('[line cut]')
		expect(out.split('\r').length).toBe(text.split('\r').length)
	})
	it('a long line keeps its tail (head + marker + tail), all masked', () => {
		const line = `${filler(10_000)} final error: Authorization: Bearer abcdefgh12345678zz done`
		const out = redactSecrets(line)
		expect(out).toContain('[line cut]')
		expect(out).toContain('final error')
		expect(out).toContain('done')
		expect(out).not.toContain('abcdefgh12345678zz')
		expect(out.length).toBeLessThanOrEqual(LINE_MAX_CHARS)
	})
	it('a tail window that starts between "Bearer" and its token still masks the token', () => {
		const token = 'q'.repeat(1990)
		const line = `${filler(6000)} Authorization: Bearer ${token}`
		const out = redactSecrets(line)
		expect(out).not.toContain('qqqqqqqqqqqqqqqqqqqq')
	})
	it('redacting twice is a no-op', () => {
		for (const t of [
			`${filler(10_000)} PGPASSWORD=xyzxyzxyzxyz tail`,
			`a\r${filler(9000)}\rb`,
			`${'x'.repeat(70_000)} tail`,
			`${filler(70_000)}\r\nok`,
		]) {
			const once = redactSecrets(t)
			expect(redactSecrets(once)).toBe(once)
		}
	})
})
