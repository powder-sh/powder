// The watchdog's GitHub closes against a GitHub that never answers (stubbed fetch):
// the reap returns within the overall limit and nothing throws.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../hq', () => ({ reportSwapCheckLeftoverToHq: async () => {} }))
vi.mock('../servers', () => ({ listAllServers: async () => [], getServer: async () => null }))
vi.mock('../ssh', () => ({ runCommand: async () => ({}) }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../integrations', () => ({ getAdminGithubIntegration: async () => ({ token: 'tok-watchdog', username: null, source: 'pat' }) }))
vi.mock('../repos', () => ({
	getRepoFor: async () => ({ id: 'app_1', serverId: 's', containerName: 'web', ownerUserId: 'u', repoUrl: 'git@github.com:acme/web.git' }),
}))
vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const chain = { from: () => chain, where: async () => [{ githubDeploymentId: '42' }] }
	return { ...real, db: { select: () => chain } }
})

import { closeOnGithub } from '../deploy-watchdog'

// closeOnGithub imports these lazily; load them once up front so a cold import under
// a busy test run does not eat the time limit under test.
beforeAll(async () => {
	await Promise.all([import('../github-deployments'), import('../repos'), import('../secret-text')])
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('watchdog GitHub closes with a hung GitHub', () => {
	it('returns after the overall limit, every row started in parallel', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const started: string[] = []
		// never answers and ignores the abort: the worst case
		vi.stubGlobal('fetch', (url: string) => {
			started.push(url)
			return new Promise<Response>(() => {})
		})
		const row = (id: string) => ({ id, serverId: 's', containerName: 'web', kind: 'git_deploy', gitSha: null, requestedSha: 'f'.repeat(40), claimed: true })
		const t0 = Date.now()
		await closeOnGithub([row('dep_1'), row('dep_2'), row('dep_3')], 300)
		expect(Date.now() - t0).toBeLessThan(2_000)
		// one Deployment status call per row went out at once (none waited for another)
		expect(started.filter((u) => u.endsWith('/deployments/42/statuses'))).toHaveLength(3)
	})
	it('a reaped deploy that built B for a requested A: failure on B, A closed as error', async () => {
		vi.stubEnv('BETTER_AUTH_URL', 'https://powder.example')
		const posted: { sha: string; context: string; state: string }[] = []
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const m = url.match(/\/statuses\/([0-9a-f]{40})$/)
			if (m) {
				const b = JSON.parse(String(init.body))
				posted.push({ sha: m[1] ?? '', context: b.context, state: b.state })
			}
			return new Response('{}', { status: 201 })
		})
		const A = 'a'.repeat(40)
		const B = 'b'.repeat(40)
		await closeOnGithub([{ id: 'dep_r', serverId: 's', containerName: 'web', kind: 'git_deploy', gitSha: B, requestedSha: A, claimed: true }], 2_000)
		// (calls still running from the hung-GitHub case above post on another commit)
		const mine = posted.filter((p) => p.sha === A || p.sha === B)
		expect(mine).toEqual(
			expect.arrayContaining([
				{ sha: B, context: 'powder/deploy', state: 'failure' },
				{ sha: A, context: 'powder/deploy', state: 'error' },
			]),
		)
		expect(mine).toHaveLength(2)
		vi.unstubAllEnvs()
	})
})
