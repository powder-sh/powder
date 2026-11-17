import { describe, expect, it } from 'vitest'
import { waitedLabel } from '../format'

describe('waitedLabel', () => {
	const t = (s: number) => new Date(1_700_000_000_000 + s * 1000).toISOString()
	it('null when wait is 30s or less', () => {
		expect(waitedLabel(t(0), t(30))).toBeNull()
		expect(waitedLabel(t(0), t(0))).toBeNull()
	})
	it('minutes / hours', () => {
		expect(waitedLabel(t(0), t(12 * 60))).toBe('waited 12m')
		expect(waitedLabel(t(0), t(3600 + 300))).toBe('waited 1h 5m')
	})
})
