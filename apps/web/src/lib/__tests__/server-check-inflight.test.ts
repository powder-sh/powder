// Repeated syncs must not pile up SSH checks: one run per server at a time, and a
// failed background attempt waits before the next.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: 0, fail: false, release: () => {} }))

vi.mock('../domain-ownership', () => ({}))
vi.mock('../servers', () => ({ saveServerCheck: async () => {} }))
vi.mock('../server-helpers', () => ({ shippedHelperShas: () => ({}), shippedHelper: () => null }))
vi.mock('../ssh', () => ({
	writeFileViaSftp: async () => {},
	runCommand: () => {
		state.calls++
		return new Promise((resolve) => {
			state.release = () =>
				resolve(
					state.fail
						? { code: 1, stdout: '', stderr: 'boom' }
						: { code: 0, stdout: 'uid=0\n', stderr: '' },
				)
		})
	},
}))

import {
	BACKGROUND_RETRY_MS,
	maybeBackgroundCheck,
	runBootstrapCheck,
} from '../server-bootstrap-run'

const server = (id: string) => ({
	id,
	name: id,
	host: 'h',
	user: 'root',
	port: 22,
	kind: 'compose' as const,
	proxy: 'nginx' as const,
	lastCheck: null,
})

beforeEach(() => {
	state.calls = 0
	state.fail = false
})

describe('server check runs', () => {
	it('concurrent checks for one server share one SSH run', async () => {
		const s = server('a')
		const p1 = runBootstrapCheck(s)
		const p2 = runBootstrapCheck(s)
		expect(maybeBackgroundCheck(s)).toBeNull()
		expect(state.calls).toBe(1)
		state.release()
		await Promise.all([p1, p2])
		expect(state.calls).toBe(1)
	})
	it('a failed background attempt is not retried on every sync', async () => {
		state.fail = true
		const s = server('b')
		const now = Date.now()
		const p = maybeBackgroundCheck(s, now)
		expect(p).not.toBeNull()
		state.release()
		await expect(p).rejects.toThrow('boom')
		expect(maybeBackgroundCheck(s, now + 1000)).toBeNull()
		expect(state.calls).toBe(1)
		const later = maybeBackgroundCheck(s, now + BACKGROUND_RETRY_MS + 1)
		expect(later).not.toBeNull()
		state.release()
		await later?.catch(() => {})
		expect(state.calls).toBe(2)
	})
})
