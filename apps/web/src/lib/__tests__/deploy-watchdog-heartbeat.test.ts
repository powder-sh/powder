import { describe, expect, it, vi } from 'vitest'

vi.mock('../hq', () => ({ reportSwapCheckLeftoverToHq: async () => {} }))
vi.mock('../servers', () => ({ listAllServers: async () => [] }))
vi.mock('../ssh', () => ({ runCommand: async () => ({}) }))

import { runningReapCondition } from '../deploy-watchdog'

// Flatten a drizzle SQL object to text (string chunks, column names, params as ?).
function flat(x: unknown): string {
	if (x == null) return '?'
	const o = x as { queryChunks?: unknown[]; value?: unknown; name?: string }
	if (Array.isArray(o.queryChunks)) return o.queryChunks.map(flat).join('')
	if (Array.isArray(o.value)) return o.value.join('')
	if (typeof o.name === 'string') return `"${o.name}"`
	return '?'
}

// Bug 7: the no-output rule must skip rows whose heartbeat is fresh.
describe('watchdog no-output rule', () => {
	it('only reaps a silent row when its heartbeat is missing or stale', () => {
		const text = flat(runningReapCondition())
		const i = text.indexOf('"output" IS NULL')
		expect(i).toBeGreaterThan(-1)
		const silent = text.slice(i)
		expect(silent).toMatch(/"heartbeat_at" IS NULL OR "heartbeat_at" < now\(\)/)
	})
})
