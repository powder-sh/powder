import { beforeEach, describe, expect, it, vi } from 'vitest'

// Deploy lists order, paginate and date by queued_at (the push), never by started_at,
// which the worker resets on claim. The wait is shown on its own; duration stays build time.
const H = vi.hoisted(() => ({ queries: [] as string[], params: [] as unknown[][], rows: [] as Record<string, unknown>[] }))

vi.mock('@/lib/access', () => ({ requireUser: async () => ({ id: 'u1' }), hiddenSelfNames: () => [] }))
vi.mock('@/lib/integrations', () => ({ getGithubIntegration: async () => null }))
// Flatten a drizzle SQL object to text, params as $n, collecting them.
function flat(x: unknown, params: unknown[]): string {
	const o = x as { queryChunks?: unknown[]; value?: unknown } | null
	if (o && typeof o === 'object' && Array.isArray(o.queryChunks)) return o.queryChunks.map((c) => flat(c, params)).join('')
	if (o && typeof o === 'object' && Array.isArray(o.value)) return o.value.join('')
	params.push(x)
	return `$${params.length}`
}
vi.mock('@/lib/db', async (orig) => {
	const real = (await orig()) as { sql: unknown }
	return {
		sql: real.sql,
		db: {
			execute: async (q: unknown) => {
				const params: unknown[] = []
				const text = flat(q, params)
				// the author dropdown's trigger read; only the list query is recorded
				if (text.includes('SELECT DISTINCT d.triggered_by')) return []
				H.queries.push(text)
				H.params.push(params)
				return H.rows
			},
		},
	}
})

import { GET } from '@/app/api/deploys-list/route'
import { deployEvent } from '../activity-feed'
import { deployListAt, encodeDeployCursor, parseDeployCursor } from '../deploy-order'
import { QUEUE_WAIT_SHOW_MS, waitedLabel } from '../format'

const row = (id: string, queued: string, started: string) => ({
	id,
	git_sha: null,
	built_sha: null,
	requested_sha: null,
	git_branch: null,
	status: 'success',
	kind: 'git_deploy',
	queued_at: new Date(queued),
	queued_us: String(new Date(queued).getTime() * 1000),
	started_at: new Date(started),
	finished_at: new Date(new Date(started).getTime() + 90_000),
	triggered_by: null,
	container_name: 'shop',
	server_id: 'srv-1',
	error_summary: null,
	not_before: null,
	app_repo_id: null,
	repo_url: null,
	default_branch: null,
})

beforeEach(() => {
	H.queries = []
	H.params = []
	H.rows = []
})

describe('/api/deploys-list order', () => {
	it('orders by queued_at with the id as tie-break, and pages with a queued_at + id cursor', async () => {
		H.rows = [row('dep_b', '2026-01-01T10:00:00Z', '2026-01-01T10:40:00Z'), row('dep_a', '2026-01-01T09:00:00Z', '2026-01-01T09:00:02Z')]
		const res = await GET(new Request('http://x/api/deploys-list?limit=1'))
		const body = (await res.json()) as { deploys: { id: string; durationMs: number }[]; nextCursor: string }
		expect(H.queries[0]).toMatch(/ORDER BY d\.queued_at DESC, d\.id DESC/)
		expect(H.queries[0]).not.toMatch(/ORDER BY d\.started_at/)
		expect(body.nextCursor).toBe(encodeDeployCursor(String(new Date('2026-01-01T10:00:00Z').getTime() * 1000), 'dep_b'))
		// duration stays build time, not wait + build
		expect(body.deploys[0]?.durationMs).toBe(90_000)
	})
	it('the cursor filters on (queued_at, id)', async () => {
		await GET(new Request(`http://x/api/deploys-list?cursor=${encodeURIComponent('1767261600000000~dep_b')}`))
		expect(H.queries[0]).toMatch(/\(d\.queued_at, d\.id\) < \(timestamptz 'epoch' \+ \$\d+::bigint \* interval '1 microsecond', \$\d+\)/)
		expect(H.params[0]).toEqual(expect.arrayContaining(['1767261600000000', 'dep_b']))
	})
	it('an old ISO cursor still works; junk is a 400', async () => {
		await GET(new Request('http://x/api/deploys-list?cursor=2026-01-01T10:00:00Z'))
		expect(H.queries[0]).toMatch(/d\.queued_at < \$\d+/)
		expect((await GET(new Request('http://x/api/deploys-list?cursor=nope'))).status).toBe(400)
	})
})

describe('deploy-order helpers', () => {
	it('lists date a deploy by its push', () => {
		expect(deployListAt({ queuedAt: '2026-01-01T09:00:00Z', startedAt: '2026-01-01T09:40:00Z' })).toBe('2026-01-01T09:00:00Z')
		expect(deployListAt({ queuedAt: null, startedAt: '2026-01-01T09:40:00Z' })).toBe('2026-01-01T09:40:00Z')
	})
	it('cursor round trip', () => {
		expect(parseDeployCursor(encodeDeployCursor('123', 'dep_x'))).toEqual({ micros: '123', id: 'dep_x' })
		expect(parseDeployCursor(null)).toBeNull()
		expect(parseDeployCursor('dep_x')).toBe('invalid')
	})
	it('the activity feed dates a deploy by its push', () => {
		const ev = deployEvent({
			id: 'dep_1',
			containerName: 'shop',
			kind: 'git_deploy',
			status: 'success',
			queuedAt: new Date('2026-01-01T09:00:00Z'),
			startedAt: new Date('2026-01-01T09:40:00Z'),
			triggeredBy: null,
			gitSha: null,
			errorSummary: null,
		})
		expect(ev.at).toEqual(new Date('2026-01-01T09:00:00Z'))
	})
})

describe('the queue wait label', () => {
	const t = (s: number) => new Date(1_700_000_000_000 + s * 1000).toISOString()
	it('shows from two minutes on, in whole minutes', () => {
		expect(QUEUE_WAIT_SHOW_MS).toBe(120_000)
		expect(waitedLabel(t(0), t(90))).toBeNull()
		expect(waitedLabel(t(0), t(120))).toBe('waited 2m')
		expect(waitedLabel(t(0), t(40 * 60))).toBe('waited 40m')
	})
})
