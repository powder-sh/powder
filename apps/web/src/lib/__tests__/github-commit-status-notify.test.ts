// The deploy-facing commit status calls (lib/github-deployments.ts): which deploys
// post, that a missing token / non-GitHub repo / off switch posts nothing, and
// that no GitHub failure throws. fetch is stubbed: nothing reaches GitHub.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
	row: { githubDeploymentId: null as string | null },
	token: 'tok-NotifyTestTokenValue0123456789abcdef' as string | null,
	failDb: false,
}))

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const chain = {
		from: () => chain,
		where: async () => {
			if (H.failDb) throw new Error('db down')
			return [H.row]
		},
	}
	return { ...real, db: { select: () => chain } }
})
vi.mock('../integrations', () => ({
	getAdminGithubIntegration: async () => (H.token ? { token: H.token, username: null, source: 'pat' } : null),
}))
vi.mock('../servers', () => ({ getServer: async () => null }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))

import type { AppRepo } from '../db'
import { type CommitCheckFacts, notifyCommitPending, notifyDeploymentFinished, notifyPreviewCommit } from '../github-deployments'
import { redactSecrets } from '../secret-text'

const SHA = 'c'.repeat(40)
const repo = {
	id: 'app_1',
	serverId: 'srv',
	containerName: 'web',
	repoUrl: 'git@github.com:acme/web.git',
	ownerUserId: 'usr_1',
} as unknown as AppRepo
const check = (over: Partial<CommitCheckFacts> = {}): CommitCheckFacts => ({
	kind: 'git_deploy',
	requestedSha: SHA,
	sha: SHA,
	failedStep: null,
	testGate: 'passed',
	...over,
})

let calls: { url: string; body: Record<string, unknown> }[] = []
// order in which GitHub ANSWERED (a status counts from its answer, not its send)
let answered: string[] = []
let reply: () => Promise<Response> = async () => new Response('{}', { status: 201 })

beforeEach(() => {
	calls = []
	answered = []
	reply = async () => new Response('{}', { status: 201 })
	H.row = { githubDeploymentId: null }
	H.token = 'tok-NotifyTestTokenValue0123456789abcdef'
	H.failDb = false
	vi.stubEnv('BETTER_AUTH_URL', 'https://powder.example')
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body ?? '{}'))
		calls.push({ url, body })
		const r = await reply()
		if (url.includes('/statuses/')) answered.push(String(body.state))
		return r
	})
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const statusCalls = () => calls.filter((c) => c.url.includes('/statuses/'))

describe('terminal commit statuses', () => {
	it('a successful git deploy posts powder/deploy and powder/test-gate, even with no GitHub Deployment', async () => {
		await notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('deployed'), check())
		expect(statusCalls().map((c) => [c.url, c.body.context, c.body.state, c.body.target_url])).toEqual([
			[`https://api.github.com/repos/acme/web/statuses/${SHA}`, 'powder/deploy', 'success', 'https://powder.example/deploys/dep_1'],
			[`https://api.github.com/repos/acme/web/statuses/${SHA}`, 'powder/test-gate', 'success', 'https://powder.example/deploys/dep_1'],
		])
	})
	it('the Deployment status and the commit statuses both go out when a Deployment exists', async () => {
		H.row = { githubDeploymentId: '42' }
		await notifyDeploymentFinished(repo, 'dep_1', 'failure', redactSecrets('x'), check({ failedStep: 'test gate', testGate: 'failed' }))
		expect(calls.some((c) => c.url.endsWith('/deployments/42/statuses'))).toBe(true)
		expect(statusCalls().map((c) => [c.body.context, c.body.state])).toEqual([
			['powder/deploy', 'failure'],
			['powder/test-gate', 'failure'],
		])
	})
	it('no check facts (rollback route, cancelled held push): no commit status', async () => {
		H.row = { githubDeploymentId: '42' }
		await notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('rolled back'))
		expect(statusCalls()).toHaveLength(0)
	})
	it('a rollback never posts, even when handed facts', async () => {
		await notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('x'), check({ kind: 'rollback' }))
		expect(calls).toHaveLength(0)
	})
	it('no token, a non-GitHub repo, no owner or the off switch: nothing is sent', async () => {
		H.token = null
		await notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('x'), check())
		H.token = 'tok-NotifyTestTokenValue0123456789abcdef'
		await notifyDeploymentFinished({ ...repo, repoUrl: 'git@gitlab.com:acme/web.git' } as AppRepo, 'dep_1', 'success', redactSecrets('x'), check())
		await notifyDeploymentFinished({ ...repo, ownerUserId: null } as AppRepo, 'dep_1', 'success', redactSecrets('x'), check())
		vi.stubEnv('POWDER_GITHUB_COMMIT_STATUS', 'off')
		await notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('x'), check())
		expect(calls).toHaveLength(0)
	})
	it('no public URL configured: the status has no link', async () => {
		vi.stubEnv('BETTER_AUTH_URL', '')
		vi.stubEnv('NODE_ENV', 'production')
		await notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('x'), check({ testGate: null }))
		expect(statusCalls()).toHaveLength(1)
		expect(statusCalls()[0]?.body).not.toHaveProperty('target_url')
	})
	it('GitHub refusing (403), failing (500) or powder DB down never throws and never logs the token', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		reply = async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 })
		await expect(notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('x'), check())).resolves.toBeUndefined()
		reply = async () => new Response('boom', { status: 500 })
		H.row = { githubDeploymentId: '42' }
		await expect(notifyDeploymentFinished(repo, 'dep_1', 'failure', redactSecrets('x'), check({ failedStep: 'build' }))).resolves.toBeUndefined()
		H.failDb = true
		await expect(notifyDeploymentFinished(repo, 'dep_1', 'failure', redactSecrets('x'), check())).resolves.toBeUndefined()
		const logged = log.mock.calls.flat().map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join('\n')
		expect(logged).not.toContain(H.token)
	})
})

describe('links', () => {
	it('statuses and the Deployment log link go to the dashboard deploy page, which exists', async () => {
		H.row = { githubDeploymentId: '42' }
		await notifyDeploymentFinished(repo, 'dep_1', 'success', redactSecrets('x'), check())
		const dep = calls.find((c) => c.url.endsWith('/deployments/42/statuses'))
		expect(dep?.body.log_url).toBe('https://powder.example/deploys/dep_1')
		expect(statusCalls()[0]?.body.target_url).toBe('https://powder.example/deploys/dep_1')
		expect(existsSync(join(__dirname, '../../app/(dashboard)/deploys/[id]/page.tsx'))).toBe(true)
	})
})

describe('the requested commit is not the one built', () => {
	const B = 'e'.repeat(40)
	const posted = () => statusCalls().map((c) => [c.url.slice(-40), c.body.context, c.body.state, c.body.description])
	it('success: the result goes on the built commit, the requested one is closed as error', async () => {
		await notifyDeploymentFinished(repo, 'dep_7', 'success', redactSecrets('x'), check({ sha: B, testGate: 'passed' }))
		expect(posted()).toEqual(
			expect.arrayContaining([
				[B, 'powder/deploy', 'success', 'deployed eeeeeee'],
				[B, 'powder/test-gate', 'success', '.powder/test.sh passed'],
				[SHA, 'powder/deploy', 'error', 'not deployed: a newer commit was built (eeeeeee)'],
			]),
		)
		expect(posted()).toHaveLength(3)
	})
	it('failure after the swap: failure on the built commit, error on the requested one', async () => {
		await notifyDeploymentFinished(repo, 'dep_8', 'failure', redactSecrets('x'), check({ sha: B, failedStep: 'health check', errorSummary: redactSecrets('unhealthy'), testGate: 'passed' }))
		expect(posted()).toEqual(
			expect.arrayContaining([
				[B, 'powder/deploy', 'failure', 'failed at health check: unhealthy'],
				[SHA, 'powder/deploy', 'error', 'not deployed: a newer commit was built (eeeeeee)'],
			]),
		)
	})
	it('a pre-swap test gate failure on B: failure on B for both contexts, A closed as error, nothing else on A', async () => {
		await notifyDeploymentFinished(repo, 'dep_10', 'failure', redactSecrets('x'), check({ sha: B, failedStep: 'test gate', errorSummary: redactSecrets('2 failed'), testGate: 'failed' }))
		expect(posted()).toEqual(
			expect.arrayContaining([
				[B, 'powder/deploy', 'failure', 'failed at test gate: 2 failed'],
				[B, 'powder/test-gate', 'failure', '.powder/test.sh failed: 2 failed'],
				[SHA, 'powder/deploy', 'error', 'not deployed: a newer commit was built (eeeeeee)'],
			]),
		)
		expect(posted()).toHaveLength(3)
	})
	it('a failed preview spin that built B: the failure goes on B, the pushed A is closed as error', async () => {
		await notifyPreviewCommit(repo, SHA, { phase: 'done', ok: false, builtSha: B, failedStep: 'test gate', errorSummary: redactSecrets('1 failed'), testGate: 'failed' })
		expect(posted().filter((p) => p[0] === SHA)).toEqual([[SHA, 'powder/deploy', 'error', 'not deployed: a newer commit was built (eeeeeee)']])
		expect(posted().filter((p) => p[0] === B).map((p) => p[1])).toEqual(expect.arrayContaining(['powder/deploy', 'powder/test-gate']))
	})
	it('a preview that built a newer head closes the pushed commit the same way', async () => {
		await notifyPreviewCommit(repo, SHA, { phase: 'done', ok: true, builtSha: B, failedStep: null, errorSummary: null, testGate: 'none' })
		expect(posted()).toEqual(
			expect.arrayContaining([
				[B, 'powder/deploy', 'success', 'deployed eeeeeee'],
				[SHA, 'powder/deploy', 'error', 'not deployed: a newer commit was built (eeeeeee)'],
			]),
		)
		expect(posted()).toHaveLength(2)
	})
	it('the same commit built: nothing extra', async () => {
		await notifyDeploymentFinished(repo, 'dep_9', 'success', redactSecrets('x'), check({ testGate: 'none' }))
		expect(posted()).toEqual([[SHA, 'powder/deploy', 'success', 'deployed ccccccc']])
	})
})

describe('pending', () => {
	it('posts pending for a claimed git deploy with a known commit, before the terminal status', async () => {
		let release: () => void = () => {}
		const gate = new Promise<void>((r) => {
			release = r
		})
		let first = true
		reply = async () => {
			if (first) {
				first = false
				await gate
			}
			return new Response('{}', { status: 201 })
		}
		notifyCommitPending(repo, { id: 'dep_2', kind: 'git_deploy', requestedSha: SHA })
		const done = notifyDeploymentFinished(repo, 'dep_2', 'success', redactSecrets('x'), check({ testGate: null }))
		await new Promise((r) => setTimeout(r, 10))
		release()
		await done
		expect(answered).toEqual(['pending', 'success'])
	})
	it('no requested commit, another kind or the off switch: no pending', async () => {
		notifyCommitPending(repo, { id: 'dep_3', kind: 'git_deploy', requestedSha: null })
		notifyCommitPending(repo, { id: 'dep_4', kind: 'rollback', requestedSha: SHA })
		vi.stubEnv('POWDER_GITHUB_COMMIT_STATUS', 'off')
		notifyCommitPending(repo, { id: 'dep_5', kind: 'git_deploy', requestedSha: SHA })
		await new Promise((r) => setTimeout(r, 10))
		expect(calls).toHaveLength(0)
	})
	it('a hung or failing GitHub never throws out of notifyCommitPending', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		reply = async () => {
			throw new TypeError('fetch failed')
		}
		expect(() => notifyCommitPending(repo, { id: 'dep_6', kind: 'git_deploy', requestedSha: SHA })).not.toThrow()
		await new Promise((r) => setTimeout(r, 10))
	})
})

describe('preview deploys', () => {
	it('post the same contexts on the pushed commit, linked to the app page', async () => {
		await notifyPreviewCommit(repo, SHA, { phase: 'pending' })
		await notifyPreviewCommit(repo, SHA, { phase: 'done', ok: false, builtSha: null, failedStep: 'test gate', errorSummary: redactSecrets('1 failed'), testGate: 'failed' })
		expect(statusCalls().map((c) => [c.body.context, c.body.state, c.body.target_url])).toEqual([
			['powder/deploy', 'pending', 'https://powder.example/projects/app_1'],
			['powder/deploy', 'failure', 'https://powder.example/projects/app_1'],
			['powder/test-gate', 'failure', 'https://powder.example/projects/app_1'],
		])
	})
	it('no pushed sha: nothing', async () => {
		await notifyPreviewCommit(repo, null, { phase: 'pending' })
		expect(calls).toHaveLength(0)
	})
})
