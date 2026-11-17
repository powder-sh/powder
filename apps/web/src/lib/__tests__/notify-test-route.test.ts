import { afterEach, describe, expect, it, vi } from 'vitest'

// the "send test" route is not a port-scan oracle. Every failure
// gets the same body and is padded to the send timeout.

vi.mock('@/lib/access', () => ({ requireUser: async () => ({ id: 'u', isAdmin: true }) }))
vi.mock('@/lib/db', () => {
	const rows = [{ id: 'ntf_1', kind: 'webhook', urlEncrypted: 'x' }]
	return {
		db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) },
		eq: () => null,
		notificationTargets: { id: 'id' },
	}
})
vi.mock('@/lib/notifications', () => ({ sendTestNotification: async () => false }))

import { POST } from '../../app/api/notification-targets/test/route'

afterEach(() => vi.useRealTimers())

describe('notification test route', () => {
	it('answers a failure generically and only after the send timeout', async () => {
		vi.useFakeTimers()
		let done = false
		const p = POST(
			new Request('http://x/api/notification-targets/test?id=ntf_1', { method: 'POST' }),
		).then((r) => {
			done = true
			return r
		})
		await vi.advanceTimersByTimeAsync(4000)
		expect(done).toBe(false)
		await vi.advanceTimersByTimeAsync(1100)
		const r = await p
		expect(r.status).toBe(502)
		expect(await r.json()).toEqual({ ok: false, error: 'send failed, check the powder log' })
	})
})
