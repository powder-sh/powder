import { describe, expect, it, vi } from 'vitest'

const stream = vi.fn()
vi.mock('@/lib/access', () => ({ requireContainerAccess: async () => ({ server: { id: 's' }, user: { id: 'u' } }) }))
vi.mock('@/lib/ssh', () => ({ streamContainerLogs: (...a: unknown[]) => stream(...a) }))

import { GET } from '../../app/api/servers/[id]/containers/[name]/logs/stream/route'
import { parseLogTail } from '../log-tail'

const ctx = { params: Promise.resolve({ id: 's', name: 'web' }) }
const mkReq = (q = '') => {
	const url = `http://x/api/logs?${q}`
	return Object.assign(new Request(url), { nextUrl: new URL(url) }) as never
}

describe('parseLogTail', () => {
	it('accepts integers 1..5000, else the default', () => {
		expect(parseLogTail('50')).toBe(50)
		expect(parseLogTail('5000')).toBe(5000)
		for (const bad of [null, '', 'NaN', '0', '-5', '5001', '1.5', '10;rm', '1e3', 'abc']) expect(parseLogTail(bad)).toBe(200)
	})
})

describe('logs stream cancel during handshake', () => {
	it('cancels the late handle when the client left before it arrived', async () => {
		let resolveHandshake!: (h: { cancel: () => void }) => void
		stream.mockImplementation(() => new Promise((r) => (resolveHandshake = r)))
		const res = await GET(mkReq('tail=abc'), ctx)
		expect(stream.mock.calls[0]?.[2].tail).toBe(200)
		await res.body?.cancel() // client disconnects mid-handshake
		const cancel = vi.fn()
		resolveHandshake({ cancel })
		await new Promise((r) => setTimeout(r, 10))
		expect(cancel).toHaveBeenCalledTimes(1)
	})
})
