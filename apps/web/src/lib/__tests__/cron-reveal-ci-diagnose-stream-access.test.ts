// The per-app cron token is revealed only when the call minted it and only to
// an admin browser session, the CI diagnose answer masks the raw Actions log, the
// deploy stream uses the per-container access check. Invented names.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const h = vi.hoisted(() => ({
	user: null as unknown,
	minted: true,
	containerAccess: null as Response | null,
	serverForUserCalls: 0,
	log: '',
	pattern: true,
	row: { id: 'dep_1', serverId: 'boxa', containerName: 'zorbweb', status: 'success', output: 'ok' },
}))
const sessionAdmin = { id: 'u1', email: 'a@zorb.example', name: 'a', isAdmin: true }
const tokenAdmin = { ...sessionAdmin, viaToken: true, tokenScopes: null }

vi.mock('@/lib/access', () => ({
	requireUser: async () => h.user,
	requireProjectAccess: async () => ({
		user: h.user,
		repo: { id: 'p1', containerName: 'zorbweb', repoUrl: 'git@github.com:zorb/zorbweb.git', ownerUserId: 'u1' },
	}),
	requireContainerAccess: async () =>
		h.containerAccess ?? { user: h.user, server: { id: 'boxa', host: 'h', kind: 'compose' } },
	requireServerForUser: async () => {
		h.serverForUserCalls++
		return { id: 'boxa' }
	},
}))
vi.mock('@/lib/cron-scheduler', () => ({
	ensureAppCronToken: async () => ({ token: 'zorbcrontoken0123456789abcdefghij', minted: h.minted }),
}))
vi.mock('@/lib/db', () => {
	const q = () => {
		const c = Object.assign(Promise.resolve().then(() => [h.row]), {}) as Promise<unknown> & Record<string, unknown>
		for (const k of ['from', 'where', 'orderBy', 'limit']) c[k] = () => c
		return c
	}
	return {
		createId: () => 'cron_1',
		prefixes: { cronJob: 'cron' },
		cronJobs: {},
		cronJobRuns: {},
		deploys: {},
		and: () => 0,
		eq: () => 0,
		desc: () => 0,
		inArray: () => 0,
		sql: () => 0,
		db: { insert: () => ({ values: async () => undefined }), select: () => q() },
	}
})
vi.mock('@/lib/ssh', () => ({
	getRootCrontab: async () => '',
	inspectContainer: async () => ({ ports: [] }),
	extractHostPorts: () => [],
}))
vi.mock('@/lib/app-hosts', () => ({ defaultHostFor: () => 'zorbweb.example.test' }))
vi.mock('@/lib/github-ci', () => ({
	parseGitHubRepo: () => ({ owner: 'zorb', repo: 'zorbweb' }),
	getRunFailureTail: async () => h.log,
}))
vi.mock('@/lib/integrations', () => ({ getAdminGithubIntegration: async () => ({ token: 'gh' }) }))
vi.mock('@/lib/ci-translate', () => ({
	translateFailure: () => (h.pattern ? { source: 'pattern', title: 't' } : { source: 'none' }),
	diagnoseFailureWithLlm: async () => ({ source: 'llm', title: 't' }),
}))

import { POST as diagnose } from '../../app/api/projects/[id]/ci/[runId]/diagnose/route'
import { GET as stream } from '../../app/api/deploys/[deployId]/stream/route'
import { POST as createCron } from '../../app/api/servers/[id]/containers/[name]/crons/route'
import { cronTokenField } from '../cron-token-reveal'

beforeEach(() => {
	h.user = sessionAdmin
	h.minted = true
	h.containerAccess = null
	h.serverForUserCalls = 0
	h.pattern = true
})

describe('cron token reveal', () => {
	it('cronTokenField: only a newly minted token, only to an admin browser session', () => {
		const t = { value: 'zorbtok', minted: true }
		expect(cronTokenField(t, sessionAdmin)).toEqual({ cronToken: 'zorbtok' })
		expect(cronTokenField(t, tokenAdmin)).toEqual({ cronTokenSet: true })
		expect(cronTokenField(t, { isAdmin: false })).toEqual({ cronTokenSet: true })
		expect(cronTokenField({ value: 'zorbtok', minted: false }, sessionAdmin)).toEqual({ cronTokenSet: true })
		expect(cronTokenField(null, sessionAdmin)).toEqual({})
	})
	const create = () =>
		createCron(
			new Request('http://x', {
				method: 'POST',
				body: JSON.stringify({ schedule: '0 6 * * *', kind: 'http', urlPath: '/api/cron/zorb' }),
			}),
			{ params: Promise.resolve({ id: 'boxa', name: 'zorbweb' }) },
		)
	it('create route: plaintext once for the session admin that minted it, never again, never to a token', async () => {
		let body = (await (await create()).json()) as Record<string, unknown>
		expect(body.cronToken).toBe('zorbcrontoken0123456789abcdefghij')
		h.minted = false
		body = (await (await create()).json()) as Record<string, unknown>
		expect(body.cronToken).toBeUndefined()
		expect(body.cronTokenSet).toBe(true)
		h.minted = true
		h.user = tokenAdmin
		body = (await (await create()).json()) as Record<string, unknown>
		expect(JSON.stringify(body)).not.toContain('zorbcrontoken')
		expect(body.cronTokenSet).toBe(true)
	})
})

describe('CI diagnose masks the raw log', () => {
	const run = async () =>
		(await (
			await diagnose(new Request('http://x', { method: 'POST' }), {
				params: Promise.resolve({ id: 'p1', runId: '42' }),
			})
		).json()) as { logTail: string }
	it('pattern hit and LLM path both mask a secret the log printed', async () => {
		h.log = 'step failed\ncurl -H "Authorization: Bearer zorbsecretvalue123456789" https://x\n'
		expect((await run()).logTail).not.toContain('zorbsecretvalue123456789')
		h.pattern = false
		const r = await run()
		expect(r.logTail).not.toContain('zorbsecretvalue123456789')
		expect(r.logTail).toContain('step failed')
	})
})

describe('deploy stream uses the per-container access check', () => {
	it('refuses with the container check answer and never falls back to the server-only check', async () => {
		h.containerAccess = Response.json({ error: 'unknown container' }, { status: 404 })
		const res = await stream(new Request('http://x/api/deploys/dep_1/stream') as never, {
			params: Promise.resolve({ deployId: 'dep_1' }),
		})
		expect(res.status).toBe(404)
		expect(h.serverForUserCalls).toBe(0)
	})
})
