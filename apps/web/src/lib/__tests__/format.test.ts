import { afterEach, describe, expect, it, vi } from 'vitest'
import { fmtBytes, timeAgo, timeAgoDays } from '../format'

const NOW = new Date('2026-10-31T12:00:00Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const S = 1000
const H = 3600 * S
const D = 24 * H

afterEach(() => vi.useRealTimers())

describe('timeAgo / timeAgoDays', () => {
	it.each([
		[5 * S, '5s ago', '5s ago'],
		[3 * 60 * S, '3m ago', '3m ago'],
		[5 * H, '5h ago', '5h ago'],
		[29 * D, '29d ago', '29d ago'],
		[45 * D, '1mo ago', '45d ago'],
		[400 * D, '1y ago', '400d ago'],
	])('%i ms', (ms, rolled, capped) => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		expect(timeAgo(ago(ms))).toBe(rolled)
		expect(timeAgoDays(ago(ms))).toBe(capped)
	})
	it('timeAgo shows a dash for empty input', () => {
		expect(timeAgo(null)).toBe('-')
	})
})

describe('fmtBytes', () => {
	it.each([
		[null, '-'],
		[512, '512 B'],
		[2048, '2.0 KiB'],
		[5 * 1024 * 1024, '5.0 MiB'],
		[3 * 1024 ** 3, '3.00 GiB'],
	])('%s', (n, want) => {
		expect(fmtBytes(n)).toBe(want)
	})
})
