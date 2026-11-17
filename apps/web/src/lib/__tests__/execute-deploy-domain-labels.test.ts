import { beforeEach, describe, expect, it, vi } from 'vitest'

// A normal deploy needs zero post-deploy recreates: the labels are written to the
// compose file (file only) BEFORE the build, so the script's own `up` carries them.
const order: string[] = []
const applyCalls: Array<{ facts: unknown; opts: unknown }> = []
let failPre: false | 'plain' | 'unsafe' = false
const finishDeploy = vi.fn(async () => {})

vi.mock('../db', () => ({
	and: () => null,
	eq: () => null,
	gte: () => null,
	appRepos: {},
	deploys: {},
	db: {
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'repo_1', containerName: 'app' }] }) }) }),
		update: () => ({
			set: () => ({ where: () => Object.assign(Promise.resolve(), { returning: async () => [{ startedAt: new Date() }] }) }),
		}),
	},
}))
vi.mock('../app-domains', async (orig) => ({
	...(await orig<typeof import('../app-domains')>()),
	routeHostsFor: async () => ['app.example.com'],
	applyDomainsToCompose: async (_r: unknown, facts: unknown, opts: unknown) => {
		order.push(opts ? 'labels-file-only' : 'labels-sync')
		applyCalls.push({ facts, opts })
		if (failPre && opts) {
			if (failPre === 'unsafe') throw new (await import('../compose-override-io')).UnsafeOverrideError('unsafe compose')
			throw new Error('compose invalid')
		}
	},
}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../deploys', () => ({
	autoRollback: async () => ({ output: '', rolledBackTo: null, rollbackError: null, rollbackHealthy: null }),
	finishDeploy: (...a: unknown[]) => (finishDeploy as unknown as (...x: unknown[]) => unknown)(...a),
	resolveHealthProbe: async () => null,
	rollbackSummary: (s: string) => s,
	verifyDeployHealth: async () => {
		order.push('health')
		return { healthy: true, output: '' }
	},
	lastSuccessfulGitSha: async () => null,
	lastSuccessfulComposeHash: async () => null,
	lastSuccessfulComposeView: async () => null,
}))
vi.mock('../github-deployments', () => ({ notifyDeploymentFinished: async () => {} }))
vi.mock('../hq', () => ({ extractBuilderFallback: () => null, portsLeftPublicLines: () => [], reportDeployToHq: async () => {}, reportDeployWarningsToHq: async () => {} }))
vi.mock('../notifications', () => ({ notifyDeployFailed: async () => {}, notifyDeploySucceeded: async () => {} }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 's', host: 'h' }) }))
vi.mock('../ssh', () => ({
	inspectContainer: async () => ({ state: 'running', compose: { configFile: '/a/c.yml', service: 'app', workingDir: '/a', configFiles: [] } }),
	rebuildDeploy: async () => {
		order.push('build')
		return { output: 'ok', sha: null, branch: null, image: 'app:latest' }
	},
	resolveSwapCheckPlan: () => ({ skip: 'x' }),
	verifyRunningImage: async () => ({ match: true, detail: 'ok' }),
	removeLeakedBridges: async () => '',
	tagDeployImage: async () => ({ imageTag: null, output: '' }),
	snapshotEnvForDeploy: async () => {},
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
}))
vi.mock('../ssh/files', () => ({ backupEnvBeforeRender: async () => {}, recordEnvRender: async () => {}, restoreEnvBeforeRender: async () => ({ output: '' }), dropEnvPreRender: async () => {} }))
vi.mock('../env-vars-db', () => ({ prepareEnvFileForDeploy: async () => ({ rendered: false, reason: 'db_mode_off' }) }))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))

import { renderLabelsBlock } from '../app-domains'
import { executeDeploy } from '../deploy-runner'


const deploy = { id: 'dep_1', serverId: 's', containerName: 'app', kind: 'git_deploy', startedAt: new Date() } as never

describe('domain labels before the build', () => {
	beforeEach(() => {
		order.length = 0
		applyCalls.length = 0
		failPre = false
		finishDeploy.mockClear()
	})
	it('writes labels (file only) before the build; the post-deploy sync gets identical facts', async () => {
		await executeDeploy(deploy)
		expect(order).toEqual(['labels-file-only', 'build', 'labels-sync', 'health'])
		expect(applyCalls[0]?.opts).toEqual({ fileOnly: true })
		expect(applyCalls[1]?.opts).toBeUndefined()
		// no per-deploy value reaches the labels: pre and post facts are identical and the
		// rendered block is byte-identical for two different deploys
		expect(applyCalls[1]?.facts).toEqual(applyCalls[0]?.facts)
		expect(JSON.stringify(applyCalls[0]?.facts)).not.toContain('dep_1')
		const args = { containerName: 'app', hosts: ['a.example.com'], containerPort: 3000, redirects: { redirects: [], rewrites: [], headers: {} } as never }
		expect(renderLabelsBlock(args)).toBe(renderLabelsBlock({ ...args }))
	})
	it('a failing pre-build rewrite is best effort: noted, the build runs, the post-build sync is the safety net', async () => {
		failPre = 'plain'
		await executeDeploy(deploy)
		expect(order).toEqual(['labels-file-only', 'build', 'labels-sync', 'health'])
		expect(finishDeploy).toHaveBeenCalledWith('dep_1', expect.objectContaining({ status: 'success', output: expect.stringContaining('domain labels (pre) FAILED: compose invalid') }))
	})
	it('an UNSAFE rewrite refusal stays fatal and stops the deploy before the build', async () => {
		failPre = 'unsafe'
		await executeDeploy(deploy)
		expect(order).toEqual(['labels-file-only'])
		expect(finishDeploy).toHaveBeenCalledWith('dep_1', expect.objectContaining({ status: 'failed', failedStep: 'domain labels' }))
	})
})
