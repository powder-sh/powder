import { beforeEach, describe, expect, it, vi } from 'vitest'

// ?limit=abc reached SQL as `LIMIT NaN` (500), a junk ?cursor= reached it as
// a timestamp literal (500), and ?sinceDays= was unbounded; the log search had no
// time bound.

const h = vi.hoisted(() => ({
	executed: [] as string[],
	txStatements: [] as string[],
	fail: null as Error | null,
	rows: [] as unknown[],
}))

vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u1' }),
	visibleRepos: async () => [{ serverId: 's1', containerName: 'shop' }],
	hiddenSelfNames: () => [],
}))
vi.mock('@/lib/integrations', () => ({ getGithubIntegration: async () => null }))
vi.mock('@/lib/db', async () => {
	// The real module: its postgres client is lazy and never connects here.
	const real = await vi.importActual<typeof import('@/lib/db')>('@/lib/db')
	const dialect = (
		real.db as unknown as {
			dialect: { sqlToQuery: (q: unknown) => { sql: string; params: unknown[] } }
		}
	).dialect
	const render = (q: unknown) => {
		const r = dialect.sqlToQuery(q)
		return `${r.sql} | ${JSON.stringify(r.params)}`
	}
	const tx = {
		execute: async (q: unknown) => {
			h.txStatements.push(render(q))
			return []
		},
		select: () => {
			const c: Record<string, unknown> = {}
			for (const k of ['from', 'where', 'orderBy']) c[k] = () => c
			c.limit = async (n: number) => {
				h.txStatements.push(`limit ${n}`)
				if (h.fail) throw h.fail
				return h.rows
			}
			return c
		},
	}
	return {
		...real,
		db: {
			execute: async (q: unknown) => {
				h.executed.push(render(q))
				return []
			},
			transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
		},
	}
})

import { parseListCursor, parseListLimit, parseSinceDays } from '../list-params'

beforeEach(() => {
	h.executed.length = 0
	h.txStatements.length = 0
	h.fail = null
})

describe('parsers', () => {
	it('limit: junk and missing give the default, numbers are clamped', () => {
		expect(parseListLimit(null)).toBe(50)
		expect(parseListLimit('abc')).toBe(50)
		expect(parseListLimit('')).toBe(50)
		expect(parseListLimit('0')).toBe(1)
		expect(parseListLimit('7.9')).toBe(7)
		expect(parseListLimit('5000')).toBe(200)
		expect(parseListLimit('Infinity')).toBe(50)
	})
	it('cursor: an ISO timestamp is normalised, junk is invalid', () => {
		expect(parseListCursor(null)).toBeNull()
		expect(parseListCursor('2026-11-07T10:00:00Z')).toBe('2026-11-07T10:00:00.000Z')
		expect(parseListCursor('yesterday')).toBe('invalid')
		expect(parseListCursor("1'; drop")).toBe('invalid')
	})
	it('sinceDays: 1..90, default 30', () => {
		expect(parseSinceDays(null)).toBe(30)
		expect(parseSinceDays('nope')).toBe(30)
		expect(parseSinceDays('-4')).toBe(1)
		expect(parseSinceDays('100000')).toBe(90)
	})
})

describe('GET /api/deploys-list', () => {
	it('limit=abc queries the default page size, not LIMIT NaN', async () => {
		const { GET } = await import('@/app/api/deploys-list/route')
		const r = await GET(new Request('http://x/api/deploys-list?limit=abc'))
		expect(r.status).toBe(200)
		expect(h.executed[0]).toMatch(/LIMIT \$1\s*\| \[51\]$/)
	})
	it('a cursor that is not a timestamp is a 400', async () => {
		const { GET } = await import('@/app/api/deploys-list/route')
		const r = await GET(new Request('http://x/api/deploys-list?cursor=yesterday'))
		expect(r.status).toBe(400)
		expect(h.executed).toEqual([])
	})
})

describe('GET /api/logs/search', () => {
	it('runs under a statement timeout with a row limit, sinceDays clamped', async () => {
		const { GET } = await import('@/app/api/logs/search/route')
		const r = await GET(new Request('http://x/api/logs/search?q=error&sinceDays=99999'))
		expect(r.status).toBe(200)
		expect(h.txStatements[0]).toMatch(/^SET LOCAL statement_timeout = \d+/)
		expect(h.txStatements).toContain('limit 50')
	})
	it('drops a row whose only match is inside a masked secret (no search oracle)', async () => {
		const { GET } = await import('@/app/api/logs/search/route')
		const base = {
			serverId: 's1',
			containerName: 'shop',
			kind: 'git',
			status: 'failed',
			startedAt: new Date(0),
			gitSha: null,
			gitBranch: null,
		}
		h.rows = [
			{
				...base,
				id: 'd1',
				error: null,
				output: 'boot DATABASE_URL=postgres://app:hunter2secretvalue@db/app',
			},
			{ ...base, id: 'd2', error: 'hunter2 mentioned in plain text', output: null },
		]
		try {
			const r = await GET(new Request('http://x/api/logs/search?q=hunter2'))
			const j = (await r.json()) as { results: Array<{ id: string; snippet: string }> }
			expect(j.results.map((x) => x.id)).toEqual(['d2'])
		} finally {
			h.rows = []
		}
	})
	it('a timed-out search answers 503 with a hint', async () => {
		const { GET } = await import('@/app/api/logs/search/route')
		h.fail = new Error('canceling statement due to statement timeout')
		const r = await GET(new Request('http://x/api/logs/search?q=error'))
		expect(r.status).toBe(503)
	})
})
