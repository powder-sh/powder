// Commit statuses (lib/github-commit-status.ts): what is posted for which deploy, and
// that a failing, hanging or refusing GitHub never throws and never logs the token.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deployFailureFromError } from '../deploy-failure'
import {
	COMMIT_STATUS_TIMEOUT_MS,
	DEPLOY_CONTEXT,
	DESCRIPTION_MAX,
	TEST_GATE_CONTEXT,
	commitStatusEnabled,
	commitStatusSha,
	cutDescription,
	failureReason,
	postCommitStatuses,
	terminalCommitStatuses,
	supersededPendingStatus,
	testGateCommitState,
} from '../github-commit-status'
import { redactSecrets } from '../secret-text'

const SHA = 'a'.repeat(40)
const TOKEN = 'tok-SuperSecretTokenValue1234567890abcd'
const target = { token: TOKEN, owner: 'acme', repo: 'web' }

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('commitStatusSha', () => {
	it('posts only for git deploys with a full sha', () => {
		expect(commitStatusSha({ kind: 'git_deploy', requestedSha: SHA })).toBe(SHA)
		expect(commitStatusSha({ kind: 'git_deploy', gitSha: SHA, requestedSha: null })).toBe(SHA)
		for (const kind of ['rollback', 'env_change', 'restart', 'stop', 'delete', 'manual_apply', 'image_update'])
			expect(commitStatusSha({ kind, gitSha: SHA, requestedSha: SHA })).toBeNull()
	})
	it('the built commit wins over the requested one', () => {
		expect(commitStatusSha({ kind: 'git_deploy', gitSha: 'b'.repeat(40), requestedSha: SHA })).toBe('b'.repeat(40))
	})
	it('no sha, a short sha, a non-hex value or the all-zero sha posts nothing', () => {
		expect(commitStatusSha({ kind: 'git_deploy', gitSha: null, requestedSha: null })).toBeNull()
		expect(commitStatusSha({ kind: 'git_deploy', requestedSha: 'abc1234' })).toBeNull()
		expect(commitStatusSha({ kind: 'git_deploy', requestedSha: '../../x'.padEnd(40, 'a') })).toBeNull()
		expect(commitStatusSha({ kind: 'git_deploy', requestedSha: '0'.repeat(40) })).toBeNull()
	})
})

describe('commitStatusEnabled', () => {
	it('is on by default and off only with POWDER_GITHUB_COMMIT_STATUS=off', () => {
		expect(commitStatusEnabled({})).toBe(true)
		expect(commitStatusEnabled({ POWDER_GITHUB_COMMIT_STATUS: 'on' })).toBe(true)
		expect(commitStatusEnabled({ POWDER_GITHUB_COMMIT_STATUS: ' OFF ' })).toBe(false)
	})
})

describe('powder/test-gate comes from the stored result only', () => {
	it('passed -> success, failed -> failure, none or not recorded -> no status', () => {
		expect(testGateCommitState('passed')).toBe('success')
		expect(testGateCommitState('failed')).toBe('failure')
		expect(testGateCommitState('none')).toBeNull()
		expect(testGateCommitState(null)).toBeNull()
		expect(testGateCommitState(undefined)).toBeNull()
	})
	it('the module has no log search any more', async () => {
		const m = (await import('../github-commit-status')) as Record<string, unknown>
		expect(m.testGatePassedInOutput).toBeUndefined()
		expect(m.testGateState).toBeUndefined()
	})
})

describe('supersededPendingStatus', () => {
	it('closes the requested commit as error when another commit was built', () => {
		const s = supersededPendingStatus(SHA, 'b'.repeat(40))
		expect(s).toEqual({ context: DEPLOY_CONTEXT, state: 'error', description: 'not deployed: a newer commit was built (bbbbbbb)' })
	})
	it('nothing to close when the same commit was built or none was requested', () => {
		expect(supersededPendingStatus(SHA, SHA)).toBeNull()
		expect(supersededPendingStatus(null, SHA)).toBeNull()
	})
})

describe('terminalCommitStatuses', () => {
	it('success with a passed gate posts both contexts', () => {
		const s = terminalCommitStatuses({ ok: true, sha: SHA, failedStep: null, testGate: 'passed' })
		expect(s.map((x) => [x.context, x.state])).toEqual([
			[DEPLOY_CONTEXT, 'success'],
			[TEST_GATE_CONTEXT, 'success'],
		])
		expect(s[0]?.description).toBe('deployed aaaaaaa')
	})
	it('success without .powder/test.sh posts no test-gate status', () => {
		const s = terminalCommitStatuses({ ok: true, sha: SHA, failedStep: null, testGate: 'none' })
		expect(s.map((x) => x.context)).toEqual([DEPLOY_CONTEXT])
	})
	it('a test gate failure fails both contexts, with the step and summary', () => {
		const s = terminalCommitStatuses({ ok: false, sha: SHA, failedStep: 'test gate', errorSummary: redactSecrets('2 tests failed'), testGate: 'failed' })
		expect(s).toEqual([
			{ context: DEPLOY_CONTEXT, state: 'failure', description: 'failed at test gate: 2 tests failed' },
			{ context: TEST_GATE_CONTEXT, state: 'failure', description: '.powder/test.sh failed: 2 tests failed' },
		])
	})
	it('a failure before the gate posts no test-gate status', () => {
		const s = terminalCommitStatuses({ ok: false, sha: SHA, failedStep: 'build', errorSummary: redactSecrets('npm ci failed'), testGate: null })
		expect(s.map((x) => x.context)).toEqual([DEPLOY_CONTEXT])
		expect(s[0]?.description).toBe('failed at build: npm ci failed')
	})
	it('a deploy that passed the gate and then failed at db migrate: deploy failure, test gate success', () => {
		const s = terminalCommitStatuses({ ok: false, sha: SHA, failedStep: 'db migrate', errorSummary: redactSecrets('relation exists'), testGate: 'passed' })
		expect(s.map((x) => [x.context, x.state])).toEqual([
			[DEPLOY_CONTEXT, 'failure'],
			[TEST_GATE_CONTEXT, 'success'],
		])
	})
	it('a superseded deploy closes powder/deploy as error, never as a failure of the commit', () => {
		const s = terminalCommitStatuses({ ok: false, sha: SHA, failedStep: 'superseded', errorSummary: redactSecrets('x'), testGate: 'passed' })
		expect(s).toHaveLength(1)
		expect(s[0]?.state).toBe('error')
	})
	it('descriptions are cut to 140 characters', () => {
		const long = redactSecrets('x'.repeat(500))
		const s = terminalCommitStatuses({ ok: false, sha: SHA, failedStep: 'test gate', errorSummary: long, testGate: 'failed' })
		for (const x of s) expect(x.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
		expect(cutDescription('y'.repeat(141))).toHaveLength(DESCRIPTION_MAX)
	})
	it('a credential in the failure output never reaches the description (error_summary is masked)', () => {
		const fail = deployFailureFromError(
			new Error("clone failed: fatal: unable to access 'https://x-access-token:S3cretCloneTokenValueXYZ0123456789@github.com/acme/web/'\nDATABASE_URL=postgres://app:Sup3rS3cret@db:5432/app\n__POWDER_FAIL__ step=preflight code=1"),
		)
		const s = terminalCommitStatuses({ ok: false, sha: SHA, failedStep: fail.failedStep, errorSummary: fail.errorSummary, testGate: fail.testGate })
		const text = JSON.stringify(s)
		expect(text).not.toContain('S3cretCloneTokenValueXYZ0123456789')
		expect(text).not.toContain('Sup3rS3cret')
	})
})

describe('postCommitStatuses', () => {
	it('POSTs the status to the commit with the context, description and link', async () => {
		const calls: { url: string; init: RequestInit }[] = []
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			calls.push({ url, init })
			return new Response('{}', { status: 201 })
		})
		const timeout = vi.spyOn(AbortSignal, 'timeout')
		await postCommitStatuses(target, SHA, terminalCommitStatuses({ ok: true, sha: SHA, failedStep: null, testGate: null }), 'https://powder.example/servers/s/web/deploys/dep_1')
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toBe(`https://api.github.com/repos/acme/web/statuses/${SHA}`)
		expect(calls[0]?.init.method).toBe('POST')
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			state: 'success',
			context: DEPLOY_CONTEXT,
			description: 'deployed aaaaaaa',
			target_url: 'https://powder.example/servers/s/web/deploys/dep_1',
		})
		expect(timeout).toHaveBeenCalledWith(COMMIT_STATUS_TIMEOUT_MS)
	})
	it('no public URL: no target_url', async () => {
		let body = ''
		vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
			body = String(init.body)
			return new Response('{}', { status: 201 })
		})
		await postCommitStatuses(target, SHA, terminalCommitStatuses({ ok: true, sha: SHA, failedStep: null, testGate: null }), null)
		expect(JSON.parse(body)).not.toHaveProperty('target_url')
	})
	for (const [name, fetchImpl, reason] of [
		['403 (token lacks the commit statuses permission)', async () => new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 }), 'github 403'],
		['404 (repo gone or no access)', async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }), 'github 404'],
		['500', async () => new Response('oops', { status: 500 }), 'github 500'],
		['a network error', async () => { throw new TypeError(`fetch failed for ${TOKEN}`) }, 'error'],
	] as const) {
		it(`${name}: resolves, logs one line without the token or the API path`, async () => {
			vi.stubGlobal('fetch', fetchImpl)
			const log = vi.spyOn(console, 'error').mockImplementation(() => {})
			await expect(postCommitStatuses(target, SHA, terminalCommitStatuses({ ok: true, sha: SHA, failedStep: null, testGate: null }).slice(0, 1), null)).resolves.toBeUndefined()
			expect(log).toHaveBeenCalledTimes(1)
			const line = log.mock.calls.flat().map(String).join(' ')
			expect(line).toBe(`[gh-status] powder/deploy success not posted (${reason})`)
			expect(line).not.toContain(TOKEN)
			expect(line).not.toContain('/repos/')
		})
	}
	it('a hung GitHub is cut off at the time limit and resolves', async () => {
		vi.stubGlobal('fetch', (_u: string, init?: RequestInit) =>
			new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
		)
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		const post = vi.fn(async (...a: Parameters<typeof import('../github').createCommitStatus>) => {
			const { createCommitStatus } = await import('../github')
			return createCommitStatus(a[0], a[1], a[2], a[3], { ...a[4], timeoutMs: 20 })
		})
		const started = Date.now()
		await postCommitStatuses(target, SHA, terminalCommitStatuses({ ok: true, sha: SHA, failedStep: null, testGate: null }).slice(0, 1), null, post)
		expect(Date.now() - started).toBeLessThan(2_000)
		expect(String(log.mock.calls[0]?.[0])).toBe('[gh-status] powder/deploy success not posted (timeout)')
	})
	it('the per-call cap is a few seconds', () => {
		expect(COMMIT_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
	})
	it('failureReason never carries the message text', () => {
		expect(failureReason(new Error('github 422: Validation Failed'))).toBe('github 422')
		expect(failureReason('x')).toBe('error')
	})
})
