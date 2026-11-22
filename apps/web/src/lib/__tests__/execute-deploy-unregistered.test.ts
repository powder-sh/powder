import { beforeEach, describe, expect, it, vi } from 'vitest'

// A deploy row for a name with no app_repos row, no preview row and no container (a
// push queued while the app was deleted) must not guess /opt/apps/<name> and build.
const h = vi.hoisted(() => ({ repoRows: [] as unknown[], previewRows: [] as unknown[], inspectError: null as Error | null }))
const rebuildDeploy = vi.fn()
const finishDeploy = vi.fn(async (_id: string, _r: { status: string; errorSummary?: string }) => {})
vi.mock('../db', () => {
	const rows = (r: () => unknown[]) => ({ limit: async () => r() })
	return {
		and: () => null,
		eq: () => null,
		gte: () => null,
		appRepos: {},
		previewDeploys: {},
		deploys: {},
		db: {
			select: () => ({
				from: () => ({
					where: () => rows(() => h.repoRows),
					innerJoin: () => ({ where: () => rows(() => h.previewRows) }),
				}),
			}),
			update: () => ({
				set: () => ({ where: () => Object.assign(Promise.resolve(), { returning: async () => [{ id: 'dep_1' }] }) }),
			}),
		},
	}
})
vi.mock('../app-domains', () => ({ applyDomainsToCompose: async () => {} }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../deploys', () => ({
	autoRollback: async () => ({}),
	finishDeploy: (id: string, r: { status: string }) => finishDeploy(id, r),
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
	inspectContainer: async () => {
		if (h.inspectError) throw h.inspectError
		return { state: 'running', compose: { configFile: '/a/c.yml', service: 'app', workingDir: '/a', configFiles: [] } }
	},
	rebuildDeploy: (...a: unknown[]) => rebuildDeploy(...a),
	resolveSwapCheckPlan: () => ({ skip: 'x' }),
}))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))

import { resolveComposeFacts, executeDeploy } from '../deploy-runner'

const srv = { id: 's', host: 'h' } as never

beforeEach(() => {
	h.repoRows = []
	h.previewRows = []
	h.inspectError = new Error('Error: No such object: gone')
	rebuildDeploy.mockClear()
	finishDeploy.mockClear()
})

describe('unregistered app without a container', () => {
	it('resolveComposeFacts refuses the /opt/apps fallback unless the name is registered', async () => {
		await expect(resolveComposeFacts(srv, 'gone', false)).rejects.toThrow(/not a registered app or preview/)
		await expect(resolveComposeFacts(srv, 'gone', true)).resolves.toMatchObject({ workingDir: '/opt/apps/gone', project: null })
	})
	it('an existing container still resolves from its labels (git deploy of an adopted container)', async () => {
		h.inspectError = null
		await expect(resolveComposeFacts(srv, 'gone', false)).resolves.toMatchObject({ workingDir: '/a' })
	})
	it('executeDeploy fails the row with the reason and builds nothing', async () => {
		await executeDeploy({ id: 'dep_1', serverId: 's', containerName: 'gone', kind: 'git_deploy', startedAt: new Date() } as never)
		expect(rebuildDeploy).not.toHaveBeenCalled()
		expect(finishDeploy).toHaveBeenCalledTimes(1)
		const [, r] = finishDeploy.mock.calls[0] as [string, { status: string; errorSummary?: string }]
		expect(r.status).toBe('failed')
		expect(r.errorSummary).toMatch(/not a registered app or preview/)
	})
	it('a preview row counts as registered: the first-deploy fallback applies', async () => {
		h.previewRows = [{ id: 'pv_1' }]
		await executeDeploy({ id: 'dep_2', serverId: 's', containerName: 'gone', kind: 'git_deploy', startedAt: new Date() } as never)
		const r = finishDeploy.mock.calls[0]?.[1] as { errorSummary?: string } | undefined
		expect(r?.errorSummary ?? '').not.toMatch(/not a registered app or preview/)
	})
})
