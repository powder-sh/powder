import { describe, expect, it, vi } from 'vitest'
import { DeployStepError } from '../deploy-failure'

// Env is rendered before the build. A failure at a pre-swap step must put the
// previous env file back (the old container still serves); a post-swap step must not.
const calls: string[] = []
let claimed = true
const rebuild = vi.fn()

vi.mock('../db', () => ({
	and: () => null,
	eq: () => null,
	gte: () => null,
	appRepos: {},
	deploys: {},
	db: {
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'repo_1', containerName: 'app' }] }) }) }),
		update: () => ({
			set: () => ({ where: () => Object.assign(Promise.resolve(), { returning: async () => (claimed ? [{ startedAt: new Date() }] : []) }) }),
		}),
	},
}))
vi.mock('../app-domains', () => ({ applyDomainsToCompose: async () => {} }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../deploys', () => ({
	autoRollback: async () => ({ output: '', rolledBackTo: null, rollbackError: null, rollbackHealthy: null }),
	finishDeploy: async () => {},
	resolveHealthProbe: async () => null,
	rollbackSummary: (s: string) => s,
	verifyDeployHealth: async () => ({}),
	lastSuccessfulGitSha: async () => null,
	lastSuccessfulComposeHash: async () => null,
	lastSuccessfulComposeView: async () => null,
}))
vi.mock('../github-deployments', () => ({ notifyCommitPending: () => {}, notifyPreviewCommit: async () => {}, notifyDeploymentFinished: async () => {} }))
vi.mock('../hq', () => ({ extractBuilderFallback: () => null, portsLeftPublicLines: () => [], reportDeployToHq: async () => {}, reportDeployWarningsToHq: async () => {} }))
vi.mock('../notifications', () => ({ notifyDeployFailed: async () => {}, notifyDeploySucceeded: async () => {} }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 's', host: 'h' }) }))
vi.mock('../ssh', () => ({
	inspectContainer: async () => ({
		state: 'running',
		compose: { configFile: '/a/c.yml', service: 'app', workingDir: '/a', configFiles: [] },
	}),
	rebuildDeploy: (...a: unknown[]) => rebuild(...a),
	resolveSwapCheckPlan: () => ({ skip: 'x' }),
}))
vi.mock('../ssh/files', () => ({
	recordEnvRender: async () => {},
	backupEnvBeforeRender: async (_s: unknown, p: string) => void calls.push(`backup ${p}`),
	restoreEnvBeforeRender: async (_s: unknown, p: string) => {
		calls.push(`restore ${p}`)
		return { restored: true, output: '[env] restored\n' }
	},
	dropEnvPreRender: async (_s: unknown, p: string) => void calls.push(`drop ${p}`),
}))
vi.mock('../env-vars-db', () => ({
	prepareEnvFileForDeploy: async (_s: unknown, _r: unknown, _sc: unknown, hooks: { beforeWrite?: (p: string) => Promise<void> }) => {
		await hooks.beforeWrite?.('/opt/apps/app.env')
		return { rendered: true, path: '/opt/apps/app.env', bytes: 1 }
	},
}))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))

import { executeDeploy, shouldRestoreEnv } from '../deploy-runner'

const deploy = { id: 'dep_1', serverId: 's', containerName: 'app', kind: 'git_deploy', startedAt: new Date() } as never

describe('env restore on pre-swap failure', () => {
	it('classifies steps', () => {
		expect(shouldRestoreEnv('test gate')).toBe(true)
		expect(shouldRestoreEnv('db migrate')).toBe(true)
		expect(shouldRestoreEnv('docker compose up')).toBe(false)
		expect(shouldRestoreEnv(null)).toBe(false)
		expect(shouldRestoreEnv('superseded')).toBe(false)
	})
	it('rebuildDeploy fails at the test gate: the env is restored', async () => {
		calls.length = 0
		rebuild.mockRejectedValueOnce(new DeployStepError('x\n__POWDER_FAIL__ step=test gate code=1'))
		await executeDeploy(deploy)
		expect(calls).toEqual(['backup /opt/apps/app.env', 'restore /opt/apps/app.env', 'drop /opt/apps/app.env'])
	})
	it('a row that is no longer running restores the env before returning', async () => {
		calls.length = 0
		claimed = false
		try {
			await executeDeploy(deploy)
		} finally {
			claimed = true
		}
		expect(calls).toEqual(['backup /opt/apps/app.env', 'restore /opt/apps/app.env', 'drop /opt/apps/app.env'])
	})
	it('a post-swap failure keeps the new env', async () => {
		calls.length = 0
		rebuild.mockRejectedValueOnce(new DeployStepError('x\n__POWDER_FAIL__ step=docker compose up code=1'))
		await executeDeploy(deploy)
		expect(calls).toEqual(['backup /opt/apps/app.env', 'drop /opt/apps/app.env'])
	})
})
