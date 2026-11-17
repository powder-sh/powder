// The observed cron snippet is masked on the full command, then cut to 240
// chars: cutting first left a token fragment too short for any rule, raw.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({ db: {}, cronRuns: {}, createId: () => 'x', prefixes: {} }))
vi.mock('../ssh', () => ({ runCommand: async () => ({ code: 1, stdout: '' }) }))

import { snippetFor } from '../cron-observer'

describe('snippetFor', () => {
	it('a token crossing the 240-char cut is not stored partly raw', () => {
		const token = `ghp_${'A1b2C3d4'.repeat(5)}`
		// The token starts at char 230, so a cut-first snippet ends in its first 10 chars.
		const cmd = `/usr/bin/curl ${'x'.repeat(215)} ${token} https://api.example`
		const s = snippetFor(cmd)
		expect(s.length).toBeLessThanOrEqual(240)
		expect(s).not.toContain(token.slice(0, 8))
		expect(s).toContain('[redacted]')
	})
})
