import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// live log streams had no concurrency cap, no lifetime and were authorized
// once; the deploy stream re-read the whole build log every 1.5 s.

const h = vi.hoisted(() => ({
	selects: [] as string[][],
	row: { status: 'running', serverId: 's1', output: 'abc', error: null as string | null },
	tokenValid: true,
	logStreams: 0,
}))

vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u1', viaToken: true, tokenId: 't1' }),
	requireServerForUser: async () => ({ id: 's1' }),
	requireContainerAccess: async (serverId: string) => ({
		user: { id: 'u1', viaToken: true, tokenId: 't1' },
		server: { id: serverId },
	}),
}))
vi.mock('@/lib/ssh', () => ({
	streamContainerLogs: async () => {
		h.logStreams++
		return {
			cancel: () => {
				h.logStreams--
			},
		}
	},
}))
vi.mock('@/lib/deploys', () => ({ deployWorkerEnabled: () => true }))
vi.mock('@/lib/admin-ids', () => ({ isAdminUserId: () => true }))
vi.mock('@/lib/db', async () => {
	const real = await vi.importActual<typeof import('@/lib/db')>('@/lib/db')
	const chain = (fields: Record<string, unknown> | undefined) => {
		h.selects.push(fields ? Object.keys(fields) : ['*'])
		const c: Record<string, unknown> = {}
		for (const k of ['from', 'where', 'innerJoin']) c[k] = () => c
		c.limit = async () => {
			if (fields && 'expiresAt' in fields) return h.tokenValid ? [{ expiresAt: null }] : []
			if (!fields) return [{ id: 'dep_1', ...h.row }]
			return [
				{ status: h.row.status, error: h.row.error, len: h.row.output.length, tail: h.row.output },
			]
		}
		return c
	}
	return { ...real, db: { select: (f?: Record<string, unknown>) => chain(f) } }
})

import {
	STREAMS_PER_SERVER,
	STREAMS_PER_USER,
	acquireStreamSlot,
	guardStream,
	resetStreamSlots,
	streamStillAuthorized,
} from '../stream-guard'

beforeEach(() => {
	resetStreamSlots()
	h.selects.length = 0
	h.tokenValid = true
	h.logStreams = 0
	h.row = { status: 'running', serverId: 's1', output: 'abc', error: null }
})
afterEach(() => vi.useRealTimers())

describe('slots', () => {
	it('caps per user and per server, release frees a slot once', () => {
		const held = Array.from({ length: STREAMS_PER_USER }, () => acquireStreamSlot('u1', 's1'))
		const sixth = acquireStreamSlot('u1', 's1')
		expect(sixth).toBeInstanceOf(Response)
		expect((sixth as Response).status).toBe(429)
		const first = held[0] as { release: () => void }
		first.release()
		first.release()
		expect(acquireStreamSlot('u1', 's1')).not.toBeInstanceOf(Response)
		expect(acquireStreamSlot('u1', 's1')).toBeInstanceOf(Response)
		resetStreamSlots()
		for (let i = 0; i < STREAMS_PER_SERVER; i++) acquireStreamSlot(`u${i}`, 's2')
		expect(acquireStreamSlot('other', 's2')).toBeInstanceOf(Response)
		expect(acquireStreamSlot('other', 's3')).not.toBeInstanceOf(Response)
	})
})

describe('guardStream', () => {
	it('ends at the lifetime cap', () => {
		vi.useFakeTimers()
		const end = vi.fn()
		guardStream({ recheck: async () => true, end, lifetimeMs: 1000, recheckMs: 600_000 })
		vi.advanceTimersByTime(999)
		expect(end).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(end).toHaveBeenCalledWith('expired', expect.stringContaining('lifetime'))
	})
	it('ends when a recheck fails, once', async () => {
		vi.useFakeTimers()
		const end = vi.fn()
		let ok = true
		guardStream({ recheck: async () => ok, end, lifetimeMs: 600_000, recheckMs: 100 })
		await vi.advanceTimersByTimeAsync(250)
		expect(end).not.toHaveBeenCalled()
		ok = false
		await vi.advanceTimersByTimeAsync(300)
		expect(end).toHaveBeenCalledTimes(1)
		expect(end).toHaveBeenCalledWith('revoked', expect.stringContaining('sign in again'))
	})
	it('a recheck that rejects fails closed, without an unhandled rejection', async () => {
		vi.useFakeTimers()
		const seen: unknown[] = []
		const onUnhandled = (r: unknown) => seen.push(r)
		process.on('unhandledRejection', onUnhandled)
		try {
			const end = vi.fn()
			const stop = guardStream({
				recheck: () => Promise.reject(new Error('db down')),
				end,
				lifetimeMs: 600_000,
				recheckMs: 100,
			})
			await vi.advanceTimersByTimeAsync(150)
			stop()
			expect(end).toHaveBeenCalledWith('revoked', expect.stringContaining('sign in again'))
			vi.useRealTimers()
			for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
			expect(seen).toEqual([])
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
	})
	it('a revoked token no longer holds', async () => {
		expect(
			await streamStillAuthorized({ id: 'u1', viaToken: true, tokenId: 't1' }, new Headers()),
		).toBe(true)
		h.tokenValid = false
		expect(
			await streamStillAuthorized({ id: 'u1', viaToken: true, tokenId: 't1' }, new Headers()),
		).toBe(false)
	})
})

describe('routes', () => {
	const req = (u: string) => new Request(u) as unknown as import('next/server').NextRequest
	it('container logs: the sixth concurrent stream of a user is a 429; cancel frees it', async () => {
		const { GET } = await import('@/app/api/servers/[id]/containers/[name]/logs/stream/route')
		const ctx = { params: Promise.resolve({ id: 's1', name: 'shop' }) }
		const open: Response[] = []
		for (let i = 0; i < STREAMS_PER_USER; i++) {
			const r = await GET(
				Object.assign(req('http://x/logs/stream'), { nextUrl: new URL('http://x/logs/stream') }),
				ctx,
			)
			expect(r.status).toBe(200)
			open.push(r)
		}
		const r6 = await GET(
			Object.assign(req('http://x/logs/stream'), { nextUrl: new URL('http://x/logs/stream') }),
			ctx,
		)
		expect(r6.status).toBe(429)
		await open[0]?.body?.cancel()
		const r7 = await GET(
			Object.assign(req('http://x/logs/stream'), { nextUrl: new URL('http://x/logs/stream') }),
			ctx,
		)
		expect(r7.status).toBe(200)
		for (const r of [...open.slice(1), r7]) await r.body?.cancel()
	})
	it('deploy stream polls status and the new output only, never the whole row', async () => {
		vi.useFakeTimers()
		const { GET } = await import('@/app/api/deploys/[deployId]/stream/route')
		const r = await GET(req('http://x/api/deploys/dep_1/stream'), {
			params: Promise.resolve({ deployId: 'dep_1' }),
		})
		expect(r.status).toBe(200)
		await vi.advanceTimersByTimeAsync(3100)
		// the first select is the access lookup; every poll names its columns
		const polls = h.selects.slice(1)
		expect(polls.length).toBeGreaterThanOrEqual(2)
		for (const f of polls) {
			expect(f).not.toContain('*')
			expect(f).not.toContain('output')
			expect(f).toContain('tail')
		}
		await r.body?.cancel()
	})
	it('a finished deploy does not take a slot', async () => {
		h.row = { status: 'success', serverId: 's1', output: 'done', error: null }
		for (let i = 0; i < STREAMS_PER_USER; i++) acquireStreamSlot('u1', 's9')
		const { GET } = await import('@/app/api/deploys/[deployId]/stream/route')
		const r = await GET(req('http://x/api/deploys/dep_1/stream'), {
			params: Promise.resolve({ deployId: 'dep_1' }),
		})
		expect(r.status).toBe(200)
	})
})
