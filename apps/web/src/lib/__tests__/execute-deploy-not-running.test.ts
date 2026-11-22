import { describe, expect, it, vi } from 'vitest'

// A row reaped while waiting for the per-server slot must not touch the server.
const rebuildDeploy = vi.fn()
const finishDeploy = vi.fn(async () => {})
vi.mock('../db', () => ({
	and: () => null,
	eq: () => null,
	gte: () => null,
	appRepos: {},
	previewDeploys: {},
	deploys: {},
	db: {
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [] }), innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }),
		}),
		update: () => ({
			set: () => ({ where: () => Object.assign(Promise.resolve(), { returning: async () => [] }) }),
		}),
	},
}))
vi.mock('../app-domains', () => ({ applyDomainsToCompose: async () => {} }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../deploys', () => ({
	autoRollback: async () => ({}),
	finishDeploy: (...a: unknown[]) => (finishDeploy as unknown as (...x: unknown[]) => unknown)(...a),
	resolveHealthProbe: async () => null,
	rollbackSummary: (s: string) => s,
	verifyDeployHealth: async () => ({}),
	lastSuccessfulGitSha: async () => null,
	lastSuccessfulComposeHash: async () => null,
	lastSuccessfulComposeView: async () => null,
}))
vi.mock('../github-deployments', () => ({ notifyCommitPending: () => {}, notifyPreviewCommit: async () => {}, notifyDeploymentFinished: async () => {} }))
vi.mock('../hq', () => ({ extractBuilderFallback: () => null, portsLeftPublicLines: () => [], reportDeployToHq: async () => {}, reportDeployWarningsToHq: async () => {} }))
vi.mock('../notifications', () => ({ notifyDeployFailed: () => {}, notifyDeploySucceeded: async () => {} }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 's', host: 'h' }) }))
vi.mock('../ssh', () => ({
	inspectContainer: async () => ({ compose: { configFile: '/a/c.yml', service: 'app', workingDir: '/a', configFiles: [] } }),
	rebuildDeploy: (...a: unknown[]) => rebuildDeploy(...a),
	resolveSwapCheckPlan: () => ({ skip: 'x' }),
}))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))

import { executeDeploy } from '../deploy-runner'

describe('executeDeploy', () => {
	it('skips the work when the row is no longer running', async () => {
		await executeDeploy({ id: 'dep_1', serverId: 's', containerName: 'app', kind: 'git_deploy', startedAt: new Date() } as never)
		expect(rebuildDeploy).not.toHaveBeenCalled()
		expect(finishDeploy).not.toHaveBeenCalled()
	})
})
