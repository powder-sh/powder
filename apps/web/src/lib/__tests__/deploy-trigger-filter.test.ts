import { beforeEach, describe, expect, it, vi } from 'vitest'

// One parser for triggered_by: the "triggered by" label, the /deploys author filter and its
// dropdown. The filter used to match only `webhook:<login>`, hiding group pushes, catch-ups
// and manual deploys, and the dropdown offered commit-author logins that could never match.
const H = vi.hoisted(() => ({ triggers: [] as (string | null)[], queries: [] as string[], params: [] as unknown[][] }))

function flat(x: unknown, params: unknown[]): string {
	const o = x as { queryChunks?: unknown[]; value?: unknown } | null
	if (o && typeof o === 'object' && Array.isArray(o.queryChunks)) return o.queryChunks.map((c) => flat(c, params)).join('')
	if (o && typeof o === 'object' && Array.isArray(o.value)) return o.value.join('')
	params.push(x)
	return `$${params.length}`
}
vi.mock('@/lib/access', () => ({ requireUser: async () => ({ id: 'u1' }), hiddenSelfNames: () => [] }))
vi.mock('@/lib/integrations', () => ({ getGithubIntegration: async () => null }))
vi.mock('@/lib/db', async (orig) => {
	const real = (await orig()) as { sql: unknown }
	return {
		sql: real.sql,
		db: {
			execute: async (q: unknown) => {
				const params: unknown[] = []
				const text = flat(q, params)
				if (text.includes('SELECT DISTINCT d.triggered_by')) return H.triggers.map((t) => ({ triggered_by: t }))
				H.queries.push(text)
				H.params.push(params)
				return []
			},
		},
	}
})

import { GET } from '@/app/api/deploys-list/route'
import { authorOptions, parseTrigger, triggeredByLabel, triggersMatching } from '../deploy-status'

const STORED = [
	'webhook:alice',
	'webhook-group:alice',
	'webhook-catchup:alice',
	'webhook-group-catchup:alice',
	'webhook:bob',
	'webhook-group:bob',
	'manual:alice@example.com',
	'wizard:alice@example.com',
	'alice@example.com',
	'manual:bob@example.com',
	'reconcile',
	'webhook',
	null,
]

beforeEach(() => {
	H.triggers = STORED
	H.queries = []
	H.params = []
})

describe('parseTrigger', () => {
	it('every push-like prefix is a push by the login; manual and wizard are manual', () => {
		expect(parseTrigger('webhook-group:alice')).toMatchObject({ how: 'push', who: 'alice', filter: 'push:alice' })
		expect(parseTrigger('webhook-group-catchup:alice').filter).toBe('push:alice')
		expect(parseTrigger('wizard:alice@example.com')).toMatchObject({ how: 'manual', filter: 'manual:alice@example.com' })
		expect(parseTrigger('alice@example.com').filter).toBe('manual:alice@example.com')
		expect(parseTrigger('reconcile')).toMatchObject({ how: 'reconcile', who: null, filter: null })
		expect(parseTrigger(null).label).toBeNull()
	})
	it('the label is the same parse', () => {
		expect(triggeredByLabel('webhook-group:alice')).toBe('push · alice')
		expect(triggeredByLabel('manual:bob@example.com')).toBe('manual · bob@example.com')
	})
})

describe('author filter and dropdown', () => {
	it('a login matches every push-like prefix; a bare login (older links) too', () => {
		const push = ['webhook:alice', 'webhook-group:alice', 'webhook-catchup:alice', 'webhook-group-catchup:alice']
		expect(triggersMatching('push:alice', STORED)).toEqual(push)
		expect(triggersMatching('alice', STORED)).toEqual(push)
	})
	it('a manual user matches manual, wizard and older bare rows', () => {
		expect(triggersMatching('manual:alice@example.com', STORED)).toEqual([
			'manual:alice@example.com',
			'wizard:alice@example.com',
			'alice@example.com',
		])
	})
	it('the dropdown lists each person once, from the same parser', () => {
		expect(authorOptions(STORED)).toEqual([
			{ value: 'push:alice', label: 'alice' },
			{ value: 'manual:alice@example.com', label: 'alice@example.com (manual)' },
			{ value: 'push:bob', label: 'bob' },
			{ value: 'manual:bob@example.com', label: 'bob@example.com (manual)' },
		])
	})
	it('the route filters on every matching stored value and returns the dropdown', async () => {
		const res = await GET(new Request('http://x/api/deploys-list?author=push%3Abob'))
		const body = (await res.json()) as { authors: { value: string }[] }
		expect(H.queries[0]).toMatch(/d\.triggered_by IN \(\$\d+, \$\d+\)/)
		expect(H.params[0]).toEqual(expect.arrayContaining(['webhook:bob', 'webhook-group:bob']))
		expect(body.authors.map((a) => a.value)).toContain('manual:bob@example.com')
	})
	it('a person with no deploys matches nothing', async () => {
		await GET(new Request('http://x/api/deploys-list?author=push%3Anobody'))
		expect(H.queries[0]).toMatch(/FALSE/)
	})
})
