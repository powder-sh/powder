import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeployStepError } from '../deploy-failure'

// What a failed deploy records and reports. git_sha stays "the commit that went live"
// (NULL before a swap); the commit the run built goes into built_sha, and the ops-hub
// event names the deploy's commit the way every display does (lib/deploy-commit.ts).
const H = vi.hoisted(() => ({
	finished: [] as Record<string, unknown>[],
	hq: [] as Record<string, unknown>[],
	finishResult: 'written' as 'written' | 'already-recorded' | 'reaped' | 'throw',
}))
const rebuild = vi.fn()

vi.mock('../db', () => ({
	and: () => null,
	eq: () => null,
	gte: () => null,
	appRepos: {},
	deploys: {},
	db: {
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'repo_1', containerName: 'shop' }] }) }) }),
		update: () => ({
			set: () => ({ where: () => Object.assign(Promise.resolve(), { returning: async () => [{ startedAt: new Date() }] }) }),
		}),
	},
}))
vi.mock('../app-domains', () => ({ applyDomainsToCompose: async () => {} }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../deploys', () => ({
	autoRollback: async () => ({ output: '', rolledBackTo: null, rollbackError: null, rollbackHealthy: null }),
	finishDeploy: async (_id: string, r: Record<string, unknown>) => {
		H.finished.push(r)
		if (H.finishResult === 'throw') throw new Error('the result write gave up')
		return H.finishResult
	},
	resolveHealthProbe: async () => null,
	rollbackSummary: (s: string) => s,
	verifyDeployHealth: async () => ({}),
	lastSuccessfulGitSha: async () => null,
	lastSuccessfulComposeHash: async () => null,
	lastSuccessfulComposeView: async () => null,
}))
vi.mock('../github-deployments', () => ({ notifyCommitPending: () => {}, notifyPreviewCommit: async () => {}, notifyDeploymentFinished: async () => {} }))
vi.mock('../hq', () => ({
	extractBuilderFallback: () => null,
	portsLeftPublicLines: () => [],
	reportDeployToHq: async (e: Record<string, unknown>) => void H.hq.push(e),
	reportDeployWarningsToHq: async () => {},
}))
vi.mock('../notifications', () => ({ notifyDeployFailed: async () => {}, notifyDeploySucceeded: async () => {} }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 'srv-1', host: 'h' }) }))
vi.mock('../ssh', () => ({
	inspectContainer: async () => ({
		state: 'running',
		compose: { configFile: '/a/c.yml', service: 'shop', workingDir: '/a', configFiles: [] },
	}),
	rebuildDeploy: (...a: unknown[]) => rebuild(...a),
	resolveSwapCheckPlan: () => ({ skip: 'x' }),
}))
vi.mock('../ssh/files', () => ({
	recordEnvRender: async () => {},
	backupEnvBeforeRender: async () => {},
	restoreEnvBeforeRender: async () => ({ restored: true, output: '' }),
	dropEnvPreRender: async () => {},
}))
vi.mock('../env-vars-db', () => ({ prepareEnvFileForDeploy: async () => ({ rendered: false }) }))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))

import { executeDeploy } from '../deploy-runner'

const BUILT = 'b'.repeat(40)
const REQUESTED = 'a'.repeat(40)
const deploy = (requestedSha: string | null) =>
	({ id: 'dep_1', serverId: 'srv-1', containerName: 'shop', kind: 'git_deploy', requestedSha, startedAt: new Date() }) as never

beforeEach(() => {
	H.finished = []
	H.hq = []
	H.finishResult = 'written'
	vi.spyOn(console, 'error').mockImplementation(() => {})
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a failed deploy records the commit it built', () => {
	it('pre-swap failure: built_sha is the built commit, git_sha stays unset, the event carries it', async () => {
		rebuild.mockRejectedValueOnce(new DeployStepError('── build ──\nboom\n__POWDER_FAIL__ step=build code=1').withBuiltSha(BUILT))
		await executeDeploy(deploy(REQUESTED))
		expect(H.finished).toHaveLength(1)
		expect(H.finished[0]).toMatchObject({ status: 'failed', builtSha: BUILT })
		expect(H.finished[0]?.gitSha).toBeUndefined()
		expect(H.hq[0]).toMatchObject({ status: 'failure', sha: BUILT, shaSource: 'built' })
	})
	it('nothing built recorded: the event names the requested commit, labelled as requested', async () => {
		rebuild.mockRejectedValueOnce(new DeployStepError('── preflight ──\nno\n__POWDER_FAIL__ step=preflight code=1'))
		await executeDeploy(deploy(REQUESTED))
		expect(H.finished[0]?.builtSha ?? null).toBeNull()
		expect(H.hq[0]).toMatchObject({ status: 'failure', sha: REQUESTED, shaSource: 'requested' })
	})
	it('a step failure whose log is in the output stores only the tail in error', async () => {
		const log = `── build ──\n${Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')}\nError: boom\n__POWDER_FAIL__ step=build code=1\n`
		rebuild.mockImplementationOnce(async (...a: unknown[]) => {
			const onChunk = a[5] as (c: string) => void
			onChunk(log)
			throw new DeployStepError(log)
		})
		await executeDeploy(deploy(REQUESTED))
		const row = H.finished[0] as { error: string; output: string }
		expect(row.output).toContain('line 0')
		expect(row.error.length).toBeLessThanOrEqual(8 * 1024)
		expect(row.error).toContain('Error: boom')
		expect(row.error).not.toContain('line 0\n')
	})
	it('the summary and the event are read from the whole log, never from the stored tail', async () => {
		// the cause sits about 200 lines above the end: in the summary and the event, not in the stored tail
		const step = 'docker compose build (local build)'
		const log = [
			`── ${step} ──`,
			'#14 [builder 6/8] RUN npm run build',
			"#14 1.002 src/lib/cart.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
			...Array.from({ length: 200 }, (_, i) => `#14 2.${i} emitting chunk ${i} ${'x'.repeat(60)}`),
			'#14 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 2',
			`__POWDER_FAIL__ step=${step} code=17`,
			'',
		].join('\n')
		rebuild.mockImplementationOnce(async (...a: unknown[]) => {
			const onChunk = a[5] as (c: string) => void
			onChunk(log)
			throw new DeployStepError(log)
		})
		await executeDeploy(deploy(REQUESTED))
		const row = H.finished[0] as { error: string; errorSummary: string }
		expect(row.errorSummary).toContain('error TS2322')
		expect(String(H.hq[0]?.error)).toContain('error TS2322')
		expect(row.error).not.toContain('error TS2322')
	})
	it('the row was reaped by the watchdog first: no event from the runner (the reap sent it)', async () => {
		H.finishResult = 'reaped'
		rebuild.mockRejectedValueOnce(new DeployStepError('x\n__POWDER_FAIL__ step=build code=1'))
		await executeDeploy(deploy(REQUESTED))
		expect(H.finished).toHaveLength(1)
		expect(H.hq).toHaveLength(0)
	})
	it('the failed-result write gave up: no event from the runner (the watchdog reap sends it)', async () => {
		H.finishResult = 'throw'
		rebuild.mockRejectedValueOnce(new DeployStepError('x\n__POWDER_FAIL__ step=build code=1'))
		await executeDeploy(deploy(REQUESTED))
		expect(H.finished).toHaveLength(1)
		expect(H.hq).toHaveLength(0)
	})
	it('its own earlier write landed (reply lost, the retry finds the row terminal): exactly one event', async () => {
		H.finishResult = 'already-recorded'
		rebuild.mockRejectedValueOnce(new DeployStepError('x\n__POWDER_FAIL__ step=build code=1'))
		await executeDeploy(deploy(REQUESTED))
		expect(H.hq).toHaveLength(1)
	})
	it('the write landed: exactly one event', async () => {
		rebuild.mockRejectedValueOnce(new DeployStepError('x\n__POWDER_FAIL__ step=build code=1'))
		await executeDeploy(deploy(REQUESTED))
		expect(H.hq).toHaveLength(1)
	})
	it('no commit known at all: sha null', async () => {
		rebuild.mockRejectedValueOnce(new DeployStepError('x\n__POWDER_FAIL__ step=preflight code=1'))
		await executeDeploy(deploy(null))
		expect(H.hq[0]).toMatchObject({ sha: null, shaSource: null })
	})
})
