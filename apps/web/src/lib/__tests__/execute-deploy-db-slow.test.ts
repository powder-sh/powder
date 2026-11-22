import { beforeEach, describe, expect, it, vi } from 'vitest'

// A deploy whose swap succeeded stays a success when powder's own DB is slow afterwards
// (a post-swap write that hits the statement timeout must not let the catch-all record a
// live update as failed, with the query as summary).
const finishDeploy = vi.fn(async (..._a: unknown[]) => {})
let failGitShaWrites = 0
let failImageTagWrites = 0
let failSuccessFinishes = 0
let gitShaPermanentError = false
let healthThrows = false
let containerState = 'running'
let gitShaAttempts = 0
let pushDecisionThrows = false
// what rebuildDeploy reports: the gate's outcome, or a thrown failure
let builtTestGate: string | null = null
let rebuildThrows: Error | null = null
const rollbacks = vi.fn()
const notified = vi.fn()
const warningsReported = vi.fn()

// What drizzle 0.45 throws for a postgres statement timeout.
function statementTimeout(query: string, params: string): Error {
	const cause = Object.assign(new Error('canceling statement due to statement timeout'), { name: 'PostgresError', code: '57014' })
	return Object.assign(new Error(`Failed query: ${query}\nparams: ${params}`), { cause })
}

vi.mock('../db', () => ({
	and: () => null,
	eq: () => null,
	gte: () => null,
	appRepos: {},
	previewDeploys: {},
	deploys: {},
	db: {
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'repo_1', containerName: 'app' }] }) }) }),
		update: () => ({
			set: (v: Record<string, unknown>) => ({
				where: () => {
					let p: Promise<unknown> = Promise.resolve()
					if ('gitSha' in v) gitShaAttempts++
					if ('gitSha' in v && (gitShaPermanentError || failGitShaWrites-- > 0)) {
						p = Promise.reject(
							gitShaPermanentError
								? new Error('Failed query: update "deploys" set "git_sha" = $1\nparams: abc123,main,dep_1')
								: statementTimeout('update "deploys" set "git_sha" = $1, "git_branch" = $2 where "deploys"."id" = $3', 'abc123,main,dep_1'),
						)
					} else if ('imageTag' in v && failImageTagWrites-- > 0) {
						p = Promise.reject(statementTimeout('update "deploys" set "image_tag" = $1', 'app:deploy-dep_1,dep_1'))
					}
					p.catch(() => {})
					return Object.assign(p, { returning: async () => [{ startedAt: new Date() }] })
				},
			}),
		}),
	},
}))
vi.mock('../deploy-bookkeeping', async (orig) => {
	const real = await orig<typeof import('../deploy-bookkeeping')>()
	return {
		...real,
		// no real waiting between retries
		recordAfterSwap: (id: string, label: string, write: () => Promise<unknown>, opts?: object) =>
			real.recordAfterSwap(id, label, write, { ...opts, sleep: async () => {}, log: () => {} }),
	}
})
vi.mock('../app-domains', () => ({ applyDomainsToCompose: async () => {}, routeHostsFor: async () => [] }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../deploys', () => ({
	autoRollback: async (...a: unknown[]) => {
		rollbacks(...a)
		return { output: '', rolledBackTo: null, rollbackError: null, rollbackHealthy: null }
	},
	finishDeploy: async (...a: unknown[]) => {
		await finishDeploy(...a)
		const r = a[1] as { status: string }
		if (r.status === 'success' && failSuccessFinishes-- > 0) throw statementTimeout('update "deploys" set "status" = $1', 'success,dep_1')
	},
	resolveHealthProbe: async () => null,
	rollbackSummary: (s: string) => s,
	// resolveHealthProbe inside the real gate, failing past its retries
	verifyDeployHealth: async () => {
		if (healthThrows) throw statementTimeout('select "id", "health_url" from "app_repos"', 's,app,1')
		return { healthy: true, output: '' }
	},
	lastSuccessfulGitSha: async () => null,
	lastSuccessfulComposeHash: async () => null,
	lastSuccessfulComposeView: async () => null,
}))
// a DB read after the gate passed and the readback matched (stands in for any post-gate DB throw)
vi.mock('../deploy-push', () => ({
	loadDeployPushDecision: async () => {
		if (pushDecisionThrows) throw statementTimeout('select * from "powder_meta"', 'deploy_push_cutoff')
		return { push: false }
	},
}))
vi.mock('../github-deployments', () => ({ notifyCommitPending: () => {}, notifyPreviewCommit: async () => {}, notifyDeploymentFinished: async (...a: unknown[]) => notified(...a) }))
vi.mock('../hq', () => ({
	extractBuilderFallback: () => null,
	healthUrlState: () => null,
	portsLeftPublicLines: () => [],
	reportDeployToHq: async () => {},
	reportDeployWarningsToHq: async (...a: unknown[]) => warningsReported(...a),
}))
vi.mock('../notifications', () => ({ notifyDeployFailed: async () => {}, notifyDeploySucceeded: async () => {} }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 's', host: 'h' }) }))
vi.mock('../ssh', () => ({
	inspectContainer: async () => ({ state: containerState, compose: { configFile: '/a/c.yml', service: 'app', workingDir: '/a', configFiles: [] } }),
	rebuildDeploy: async () => {
		if (rebuildThrows) throw rebuildThrows
		return { output: 'swap-check: removed app-next\n── normalize ──\n── resolve image ──\n', sha: 'abc123', branch: 'main', image: 'app:latest', testGate: builtTestGate }
	},
	resolveSwapCheckPlan: () => ({ skip: 'x' }),
	verifyRunningImage: async () => ({ match: true, detail: 'ok' }),
	removeLeakedBridges: async () => '',
	tagDeployImage: async () => ({ imageTag: 'app:deploy-dep_1', output: 'tagged' }),
	snapshotEnvForDeploy: async () => {},
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
}))
vi.mock('../ssh/files', () => ({ backupEnvBeforeRender: async () => {}, recordEnvRender: async () => {}, restoreEnvBeforeRender: async () => ({ output: '' }), dropEnvPreRender: async () => {} }))
vi.mock('../env-vars-db', () => ({ prepareEnvFileForDeploy: async () => ({ rendered: false, reason: 'db_mode_off' }) }))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))

import { POWDER_DB_SLOW_SUMMARY } from '../deploy-bookkeeping'
import { executeDeploy } from '../deploy-runner'

const deploy = { id: 'dep_1', serverId: 's', containerName: 'app', kind: 'git_deploy', startedAt: new Date(0) } as never
const statuses = () => finishDeploy.mock.calls.map((c) => (c[1] as { status: string }).status)

describe('post-swap bookkeeping never fails a live deploy', () => {
	beforeEach(() => {
		finishDeploy.mockClear()
		failGitShaWrites = 0
		failImageTagWrites = 0
		failSuccessFinishes = 0
		gitShaPermanentError = false
		healthThrows = false
		containerState = 'running'
		gitShaAttempts = 0
		pushDecisionThrows = false
		builtTestGate = null
		rebuildThrows = null
		rollbacks.mockClear()
		notified.mockClear()
		warningsReported.mockClear()
	})
	it('the git sha write before the gate is one try (finishDeploy re-states it); a timeout is a warning, the deploy a success', async () => {
		failGitShaWrites = 1
		await executeDeploy(deploy)
		expect(gitShaAttempts).toBe(1)
		expect(statuses()).toEqual(['success'])
		const r = finishDeploy.mock.calls[0]?.[1] as { output: string; imageTag: string; finishedAt: Date }
		expect(r.output).toContain('could not record the commit sha/branch')
		// re-stated so a lost image_tag write cannot hide this deploy from auto-rollback
		expect(r.imageTag).toBe('app:deploy-dep_1')
		expect(r.finishedAt).toBeInstanceOf(Date)
	})
	it('a git sha write that keeps timing out still yields success, with a warning line and the sha re-stated', async () => {
		failGitShaWrites = 99
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['success'])
		const r = finishDeploy.mock.calls[0]?.[1] as { output: string; gitSha: string; gitBranch: string; errorSummary?: string }
		expect(r.output).toContain('[powder] warning: could not record the commit sha/branch')
		expect(r.output).not.toContain('params:')
		expect(r.gitSha).toBe('abc123')
		expect(r.gitBranch).toBe('main')
	})
	it('a non-transient DB error on the git sha write also does not fail the deploy', async () => {
		gitShaPermanentError = true
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['success'])
	})
	it('an image tag write that keeps timing out yields success with a warning', async () => {
		failImageTagWrites = 99
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['success'])
		expect((finishDeploy.mock.calls[0]?.[1] as { output: string }).output).toContain('could not record the image tag app:deploy-dep_1')
	})
	it('a success write that times out is retried, never turned into failed', async () => {
		failSuccessFinishes = 1
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['success', 'success'])
	})
	it('a success write that never lands is not turned into failed either', async () => {
		failSuccessFinishes = 3
		await executeDeploy(deploy)
		expect(statuses()).not.toContain('failed')
	})
	it('a DB error that throws out of the health gate itself stays a failure: no verdict, no success', async () => {
		healthThrows = true
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['failed'])
		const r = finishDeploy.mock.calls[0]?.[1] as { errorSummary: string; output: string }
		expect(r.errorSummary).toBe(POWDER_DB_SLOW_SUMMARY)
		expect(r.errorSummary).not.toContain('params:')
		expect(r.output).not.toContain("powder's own database was slow after the swap")
		expect(notified.mock.calls.map((c) => c[2])).not.toContain('success')
	})
	it('the same DB error with the app not running stays a failure (the outage still alerts)', async () => {
		healthThrows = true
		containerState = 'exited'
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['failed'])
		const r = finishDeploy.mock.calls[0]?.[1] as { errorSummary: string }
		expect(r.errorSummary).toBe(POWDER_DB_SLOW_SUMMARY)
	})
	it('gate passed and readback matched, then a DB call throws: success, no rollback, same notices as a normal success', async () => {
		pushDecisionThrows = true
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['success'])
		const out = (finishDeploy.mock.calls[0]?.[1] as { output: string }).output
		expect(out).toContain("powder's own database was slow after the swap")
		expect(out).not.toContain('params:')
		expect(rollbacks).not.toHaveBeenCalled()
		expect(notified.mock.calls.map((c) => c[2])).toEqual(['success'])
		expect(warningsReported).toHaveBeenCalledTimes(1)
	})
	it('the same post-gate DB error with a success write that times out once is retried success, never failed', async () => {
		pushDecisionThrows = true
		failSuccessFinishes = 1
		await executeDeploy(deploy)
		expect(statuses()).toEqual(['success', 'success'])
		expect(rollbacks).not.toHaveBeenCalled()
	})
	it('a normal success sends the HQ warnings report and the GitHub success status once', async () => {
		await executeDeploy(deploy)
		expect(notified.mock.calls.map((c) => c[2])).toEqual(['success'])
		expect(warningsReported).toHaveBeenCalledTimes(1)
	})
	it('the GitHub success carries the commit facts (built sha, the stored gate result) for the commit statuses', async () => {
		await executeDeploy(deploy)
		expect(notified.mock.calls[0]?.[4]).toMatchObject({ kind: 'git_deploy', sha: 'abc123', failedStep: null, testGate: null })
	})
	it('the test gate outcome is stored on success and handed to the commit statuses', async () => {
		builtTestGate = 'passed'
		await executeDeploy(deploy)
		expect(finishDeploy.mock.calls[0]?.[1]).toMatchObject({ status: 'success', testGate: 'passed' })
		expect(notified.mock.calls[0]?.[4]).toMatchObject({ testGate: 'passed' })
	})
	it('passed the gate, then failed at db migrate: the failed row stores passed', async () => {
		const { DeployStepError } = await import('../deploy-failure')
		rebuildThrows = new DeployStepError('── db migrate ──\nERROR: boom\n__POWDER_FAIL__ step=db migrate code=1').withTestGate('passed')
		await executeDeploy(deploy)
		expect(finishDeploy.mock.calls[0]?.[1]).toMatchObject({ status: 'failed', failedStep: 'db migrate', testGate: 'passed' })
		expect(notified.mock.calls[0]?.[4]).toMatchObject({ failedStep: 'db migrate', testGate: 'passed' })
	})
	it('a builder test failure on a newer commit: the failure facts carry the built commit, not the requested one', async () => {
		const { DeployStepError } = await import('../deploy-failure')
		const A = 'a'.repeat(40)
		const B = 'b'.repeat(40)
		rebuildThrows = new DeployStepError('__POWDER_FAIL__ step=test gate code=1').withTestGate('failed').withBuiltSha(B)
		await executeDeploy({ ...(deploy as object), requestedSha: A } as never)
		expect(notified.mock.calls[0]?.[4]).toMatchObject({ requestedSha: A, sha: B, failedStep: 'test gate', testGate: 'failed' })
	})
	it('a target-side failure before the swap (db migrate) on a newer commit: same', async () => {
		const { DeployStepError } = await import('../deploy-failure')
		const A = 'a'.repeat(40)
		const B = 'b'.repeat(40)
		rebuildThrows = new DeployStepError('__POWDER_FAIL__ step=db migrate code=1').withTestGate('passed').withBuiltSha(B)
		await executeDeploy({ ...(deploy as object), requestedSha: A } as never)
		expect(notified.mock.calls[0]?.[4]).toMatchObject({ requestedSha: A, sha: B, failedStep: 'db migrate', testGate: 'passed' })
		// the built commit goes into built_sha (0070); git_sha stays "what went live", unset here
		expect(finishDeploy.mock.calls[0]?.[1]).toMatchObject({ builtSha: B })
		expect(finishDeploy.mock.calls[0]?.[1]).not.toHaveProperty('gitSha')
	})
	it('the built commit is the requested one: unchanged', async () => {
		const { DeployStepError } = await import('../deploy-failure')
		const A = 'a'.repeat(40)
		rebuildThrows = new DeployStepError('__POWDER_FAIL__ step=test gate code=1').withTestGate('failed').withBuiltSha(A)
		await executeDeploy({ ...(deploy as object), requestedSha: A } as never)
		expect(notified.mock.calls[0]?.[4]).toMatchObject({ requestedSha: A, sha: A })
	})
	it('the GitHub failure carries the failed step and summary for the commit statuses', async () => {
		healthThrows = true
		await executeDeploy(deploy)
		expect(notified.mock.calls.map((c) => c[2])).toEqual(['failure'])
		expect(notified.mock.calls[0]?.[4]).toMatchObject({ kind: 'git_deploy', errorSummary: POWDER_DB_SLOW_SUMMARY })
	})
})
