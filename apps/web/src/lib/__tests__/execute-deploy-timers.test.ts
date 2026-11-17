import { afterEach, describe, expect, it, vi } from 'vitest'

// Bug 6: a DB error early in executeDeploy (the app_repos select) must not leak
// the heartbeat + flush intervals, and the row must still be failed.

const finishDeploy = vi.fn(async () => {})
vi.mock('../db', () => {
	const rejecting = () => {
		throw new Error('db down')
	}
	return {
		and: () => null,
		eq: () => null,
		gte: () => null,
		appRepos: {},
		deploys: {},
		db: {
			select: rejecting,
			update: () => ({ set: () => ({ where: async () => {} }) }),
		},
	}
})
vi.mock('../app-domains', () => ({ applyDomainsToCompose: async () => {} }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../deploys', () => ({
	autoRollback: async () => ({}),
	finishDeploy: (...a: unknown[]) => (finishDeploy as unknown as (...x: unknown[]) => unknown)(...a),
	resolveHealthProbe: async () => null,
	rollbackSummary: (s: string) => s,
	verifyDeployHealth: async () => ({}),
}))
vi.mock('../github-deployments', () => ({ notifyDeploymentFinished: async () => {} }))
vi.mock('../hq', () => ({ extractBuilderFallback: () => null, portsLeftPublicLines: () => [], reportDeployToHq: async () => {}, reportDeployWarningsToHq: async () => {} }))
vi.mock('../notifications', () => ({ notifyDeployFailed: () => {}, notifyDeploySucceeded: async () => {} }))
vi.mock('../servers', () => ({ getServer: async () => null }))
vi.mock('../ssh', () => ({}))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))

import { executeDeploy } from '../deploy-runner'

afterEach(() => vi.restoreAllMocks())

describe('executeDeploy timers', () => {
	it('clears both intervals and fails the row when the app_repos select throws', async () => {
		const set = vi.spyOn(globalThis, 'setInterval')
		const clear = vi.spyOn(globalThis, 'clearInterval')
		await executeDeploy({ id: 'dep_1', serverId: 's', containerName: 'app', kind: 'git_deploy', startedAt: new Date() } as never)
		const started = set.mock.results.length
		const cleared = clear.mock.calls.length
		expect(cleared).toBe(started)
		expect(finishDeploy).toHaveBeenCalledWith('dep_1', expect.objectContaining({ status: 'failed' }))
	})
})
