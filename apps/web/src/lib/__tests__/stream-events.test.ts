import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// a stream that hit its lifetime cap or lost its credentials sent
// `event: end`, which every client reads as "the deploy finished" (one page then
// showed success for a deploy still running). Those stops are now their own
// events, `expired` and `revoked`, and the clients reconnect or ask for sign-in.

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
	REVOKED_MESSAGE,
	dedupeResumedLines,
	deployEndStatus,
	deployStreamUrl,
	streamChars,
} from '../stream-events'
import { resetStreamSlots } from '../stream-guard'

beforeEach(() => {
	resetStreamSlots()
	h.tokenValid = true
	h.row = { status: 'running', serverId: 's1', output: 'abc', error: null }
})
afterEach(() => vi.useRealTimers())

async function readAll(r: Response): Promise<string> {
	if (!r.body) throw new Error('no response body')
	const reader = r.body.getReader()
	const dec = new TextDecoder()
	let out = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) return out
		out += dec.decode(value)
	}
}
type NextReq = import('next/server').NextRequest
const req = (u: string) =>
	Object.assign(new Request(u), { nextUrl: new URL(u) }) as unknown as NextReq

describe('routes send expired / revoked, never end, for a guard stop', () => {
	it('deploy stream at the lifetime cap: event expired', async () => {
		vi.useFakeTimers()
		const { GET } = await import('@/app/api/deploys/[deployId]/stream/route')
		const r = await GET(req('http://x/api/deploys/dep_1/stream'), {
			params: Promise.resolve({ deployId: 'dep_1' }),
		})
		const text = readAll(r)
		await vi.advanceTimersByTimeAsync(30 * 60_000 + 10)
		const body = await text
		expect(body).toContain('event: expired')
		expect(body).not.toContain('event: end')
	})
	it('deploy stream with a revoked token: event revoked', async () => {
		vi.useFakeTimers()
		const { GET } = await import('@/app/api/deploys/[deployId]/stream/route')
		const r = await GET(req('http://x/api/deploys/dep_1/stream'), {
			params: Promise.resolve({ deployId: 'dep_1' }),
		})
		const text = readAll(r)
		h.tokenValid = false
		await vi.advanceTimersByTimeAsync(60_000 + 10)
		const body = await text
		expect(body).toContain('event: revoked')
		expect(body).not.toContain('event: end')
	})
	it('container log stream at the lifetime cap: event expired', async () => {
		vi.useFakeTimers()
		const { GET } = await import('@/app/api/servers/[id]/containers/[name]/logs/stream/route')
		const r = await GET(req('http://x/logs/stream'), {
			params: Promise.resolve({ id: 's1', name: 'shop' }),
		})
		const text = readAll(r)
		await vi.advanceTimersByTimeAsync(30 * 60_000 + 10)
		const body = await text
		expect(body).toContain('event: expired')
		expect(body).not.toContain('event: end')
	})
})

describe('client helpers', () => {
	it('an end without a final status is not success', () => {
		expect(deployEndStatus('"success"')).toBe('success')
		expect(deployEndStatus('"failed"')).toBe('failed')
		expect(deployEndStatus('{"status":"failed"}')).toBe('failed')
		expect(deployEndStatus('"stream lifetime reached; reconnecting"')).toBeNull()
		expect(deployEndStatus('')).toBeNull()
		expect(deployEndStatus(undefined)).toBeNull()
	})
	it('resume URL and character count match the server (code points)', () => {
		expect(deployStreamUrl('dep_1')).toBe('/api/deploys/dep_1/stream')
		expect(deployStreamUrl('dep_1', 42)).toBe('/api/deploys/dep_1/stream?from=42')
		expect(streamChars('ab\u{1F680}c')).toBe(4)
	})
	it('a resumed log stream drops the repeated line only', () => {
		expect(dedupeResumedLines('t1 a', ['t1 a', 't2 b'])).toEqual(['t2 b'])
		expect(dedupeResumedLines('t1 a', ['t2 b'])).toEqual(['t2 b'])
		expect(dedupeResumedLines(undefined, ['t1 a'])).toEqual(['t1 a'])
	})
	it('every live-stream client handles expired and revoked, and never defaults to success', () => {
		const root = resolve(__dirname, '../../app/(dashboard)')
		for (const f of [
			'deploys/[id]/page.tsx',
			'projects/[id]/deployments/page.tsx',
			'servers/[id]/[name]/page.tsx',
		]) {
			const t = readFileSync(resolve(root, f), 'utf8')
			expect(t, f).toContain('addEventListener(STREAM_EXPIRED')
			expect(t, f).toContain('addEventListener(STREAM_REVOKED')
			expect(t, f).toContain('REVOKED_MESSAGE')
			expect(t, f).not.toMatch(/final[^=\n]*=\s*'success'/)
		}
		expect(REVOKED_MESSAGE).toContain('sign in again')
	})
})
