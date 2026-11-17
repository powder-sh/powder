import { describe, expect, it } from 'vitest'
import { isBlockedTargetError } from '../uptime'

// the uptime probe recognises the private-address refusal (logged once per app).
describe('uptime EBLOCKED', () => {
	it('matches the guard error directly and as a fetch cause', () => {
		expect(isBlockedTargetError(Object.assign(new Error('x'), { code: 'EBLOCKED' }))).toBe(true)
		expect(
			isBlockedTargetError(
				Object.assign(new TypeError('fetch failed'), { cause: { code: 'EBLOCKED' } }),
			),
		).toBe(true)
		expect(isBlockedTargetError(new Error('ECONNREFUSED'))).toBe(false)
		expect(isBlockedTargetError(null)).toBe(false)
	})
})
