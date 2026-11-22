// The ci tab route: the checks part reads the database only, and a failing GitHub
// never breaks or empties the checks. Invented names only, no network, no DB.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	ghCalls: [] as string[],
	selects: [] as unknown[],
	runsThrow: false,
	repo: {
		id: 'r1',
		serverId: 'boxa',
		containerName: 'zorbweb',
		repoUrl: 'git@github.com:zorbco/zorbweb.git',
		branch: 'main',
		ownerUserId: 'u1',
	},
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/access', () => ({
	requireProjectAccess: async () => ({ repo: h.repo, user: { id: 'u1', isAdmin: true } }),
}))
vi.mock('@/lib/integrations', () => ({
	getAdminGithubIntegration: async () => ({ token: 'tok', username: 'a', source: 'pat' }),
}))
vi.mock('@/lib/github-ci', () => ({
	CI_GH_TIMEOUT_MS: 5000,
	parseGitHubRepo: () => ({ owner: 'zorbco', repo: 'zorbweb' }),
	listRunsForRepo: async () => {
		h.ghCalls.push('runs')
		if (h.runsThrow) throw new Error('boom')
		return null
	},
	listWorkflowsForRepo: async () => {
		h.ghCalls.push('workflows')
		return null
	},
	getCommitBySha: async () => {
		h.ghCalls.push('commit')
		return null
	},
	getRunFailureTail: async () => {
		h.ghCalls.push('log')
		return ''
	},
}))
const FAILED_ROW = {
	id: 'dep_b',
	kind: 'git_deploy',
	status: 'failed',
	gitSha: 'b'.repeat(40),
	startedAt: new Date('2026-03-10T12:00:00Z'),
	finishedAt: new Date('2026-03-10T12:03:00Z'),
	failedStep: 'superseded',
	exitCode: null,
	errorSummary: 'superseded by a newer deploy',
	testGate: null,
}
vi.mock('@/lib/db', () => {
	const chain = (rows: unknown[]) =>
		Object.assign(Promise.resolve(rows), {
			orderBy: () => ({ limit: async () => rows }),
			groupBy: async () => [{ status: 'failed', failedStep: 'superseded', count: 1 }],
		})
	return {
		sql: () => ({}),
		and: (...a: unknown[]) => ({ and: a }),
		eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
		desc: (c: unknown) => ({ desc: c }),
		gte: (c: unknown, v: unknown) => ({ gte: [c, v] }),
		inArray: (c: unknown, v: unknown) => ({ inArray: [c, v] }),
		isNotNull: (c: unknown) => ({ isNotNull: c }),
		deploys: new Proxy({}, { get: (_t, k) => `deploys.${String(k)}` }),
		db: {
			select: (cols: unknown) => {
				h.selects.push(cols)
				return { from: () => ({ where: () => chain([FAILED_ROW]) }) }
			},
		},
	}
})

import { GET } from '../../app/api/projects/[id]/ci/route'

const call = (q: string) =>
	GET(new Request(`http://x/api/projects/r1/ci${q}`), { params: Promise.resolve({ id: 'r1' }) })

beforeEach(() => {
	h.ghCalls = []
	h.selects = []
	h.runsThrow = false
})

describe('ci route parts', () => {
	it('?part=checks reads no GitHub at all', async () => {
		const res = await call('?part=checks')
		const body = (await res.json()) as {
			checks: { rows: { superseded: boolean }[]; summary: string }
		}
		expect(res.status).toBe(200)
		expect(h.ghCalls).toEqual([])
		expect(body.checks.rows[0]?.superseded).toBe(true)
		// superseded counts neither as a deploy nor as a failure
		expect(body.checks.summary).toBe('30 days: no deploys')
	})
	it('the gate comes from deploys.test_gate, never from the deploy log', async () => {
		const res = await call('?part=checks')
		const body = (await res.json()) as {
			checks: { rows: { testGate: string; gateBadge: unknown; failedAt: unknown }[] }
		}
		const columns = h.selects.flatMap((c) => (c ? Object.values(c as object) : []))
		expect(columns).toContain('deploys.testGate')
		expect(columns).not.toContain('deploys.output')
		expect(columns).not.toContain('deploys.error')
		// NULL test_gate on a superseded row: unknown, no badge, not a failure
		expect(body.checks.rows[0]).toMatchObject({
			testGate: 'unknown',
			gateBadge: null,
			failedAt: null,
		})
	})
	it('GitHub unreadable reads as "unknown", never as no workflows', async () => {
		const body = (await (await call('?part=github')).json()) as {
			workflows: string
			runs: unknown[]
		}
		expect(body.workflows).toBe('unknown')
		expect(body.runs).toEqual([])
	})
	it('a GitHub reader that throws does not break the checks', async () => {
		h.runsThrow = true
		const res = await call('')
		const body = (await res.json()) as { checks?: unknown; workflows: string }
		expect(res.status).toBe(200)
		expect(body.checks).toBeTruthy()
		expect(body.workflows).toBe('unknown')
	})
})
