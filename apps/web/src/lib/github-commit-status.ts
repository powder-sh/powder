// GitHub commit statuses: the one authority for what powder posts on a commit
// (and so on its pull request) about its own checks. Two contexts:
//   powder/deploy     pending when a deploy of the commit is claimed, then
//                     success or failure when it ends
//   powder/test-gate  from the deploy's recorded gate result only (the deploy
//                     script's nonced mark, the value the deploy also writes to
//                     deploys.test_gate; never a log search): success when .powder/test.sh ran and
//                     passed, failure when the deploy failed at the test gate, and
//                     NO status when the app has no .powder/test.sh or the deploy
//                     died before the gate (a missing check is honest)
// When a deploy built another commit than the one `pending` went to, that commit is
// closed as `error` (supersededPendingStatus).
//
// Only git deploys (kind git_deploy) and preview deploys have a commit to post
// on. Rollbacks, env changes, restarts, stops and deletes never post.
//
// Everything here is best-effort: postCommitStatuses never throws, each call is
// capped at COMMIT_STATUS_TIMEOUT_MS, and a failure logs one short line (no
// token, no API path). The token lookup and the HTTP wrapper are shared with
// the Deployments API code (github-deployments.ts githubTarget, github.ts ghFetch).

import type { TestGate } from '@powder/db/schema'
import { isTestGateStep } from './deploy-failure'
import { type GhCommitState, createCommitStatus } from './github'
import { safeFailedStep, summaryBeyondStep } from './notify-text'
import { type SafeText, redactSecrets } from './secret-text'

export const DEPLOY_CONTEXT = 'powder/deploy'
export const TEST_GATE_CONTEXT = 'powder/test-gate'

/** GitHub's limit on a status description. */
export const DESCRIPTION_MAX = 140

/** Time limit of one status call: a slow GitHub must not hold the deploy runner. */
export const COMMIT_STATUS_TIMEOUT_MS = 4_000

export interface CommitStatus {
	context: string
	state: GhCommitState
	description: SafeText
}

/** Off with POWDER_GITHUB_COMMIT_STATUS=off. Default on (it still needs a GitHub token). */
export function commitStatusEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return (env.POWDER_GITHUB_COMMIT_STATUS ?? '').trim().toLowerCase() !== 'off'
}

const SHA_RE = /^[0-9a-f]{40}$/

/** The commit a deploy may post on, or null: git deploys only (a rollback re-deploys
 *  an old commit and is left out), a full 40-hex sha, never the all-zero one. */
export function commitStatusSha(d: {
	kind: string
	gitSha?: string | null
	requestedSha?: string | null
}): string | null {
	if (d.kind !== 'git_deploy') return null
	const sha = d.gitSha || d.requestedSha || null
	if (!sha || !SHA_RE.test(sha) || /^0+$/.test(sha)) return null
	return sha
}

/** Cut to GitHub's 140-character limit. */
export function cutDescription(text: string): SafeText {
	const t = text.replace(/\s+/g, ' ').trim()
	return redactSecrets(t.length > DESCRIPTION_MAX ? `${t.slice(0, DESCRIPTION_MAX - 3)}...` : t)
}

/** The powder/test-gate state for a deploy's recorded test gate result (the deploy
 *  script's nonced mark, the same value it writes to deploys.test_gate; never a log
 *  search): 'passed' ->
 *  success, 'failed' -> failure, 'none' or not recorded -> no status. Pure. */
export function testGateCommitState(testGate: TestGate | null | undefined): 'success' | 'failure' | null {
	if (testGate === 'passed') return 'success'
	if (testGate === 'failed') return 'failure'
	return null
}

export function pendingCommitStatus(): CommitStatus {
	return { context: DEPLOY_CONTEXT, state: 'pending', description: redactSecrets('powder is deploying this commit') }
}

/** What a finished deploy posts on the commit it built. `ok` = the deploy succeeded.
 *  errorSummary is the deploy row's error_summary (already masked by deploy-failure.ts). Pure. */
export function terminalCommitStatuses(d: {
	ok: boolean
	sha: string
	failedStep: string | null
	errorSummary?: SafeText | null
	testGate: TestGate | null | undefined
}): CommitStatus[] {
	const out: CommitStatus[] = []
	if (d.ok) {
		out.push({ context: DEPLOY_CONTEXT, state: 'success', description: cutDescription(`deployed ${d.sha.slice(0, 7)}`) })
	} else if (d.failedStep === 'superseded') {
		// Not built: a newer deploy of the app replaced this one. Not a failure of the commit.
		out.push({ context: DEPLOY_CONTEXT, state: 'error', description: cutDescription('not deployed: a newer deploy of this app replaced it') })
		return out
	} else {
		// never "failed at <step>: failed during: <step>": only what the summary says beyond the step
		const beyond = summaryBeyondStep(d.failedStep, d.errorSummary)
		const summary = beyond ? ` ${beyond}` : ''
		const where = d.failedStep ? `failed at ${safeFailedStep(d.failedStep)}:` : 'failed:'
		out.push({ context: DEPLOY_CONTEXT, state: 'failure', description: cutDescription(`${where}${summary}`.replace(/:$/, '')) })
	}
	const gate = testGateCommitState(d.testGate)
	if (gate === 'success') {
		out.push({ context: TEST_GATE_CONTEXT, state: 'success', description: cutDescription('.powder/test.sh passed') })
	} else if (gate === 'failure') {
		const beyondGate = summaryBeyondStep(d.failedStep, d.errorSummary)
		const summary = beyondGate && isTestGateStep(d.failedStep) ? `: ${beyondGate}` : ''
		out.push({ context: TEST_GATE_CONTEXT, state: 'failure', description: cutDescription(`.powder/test.sh failed${summary}`) })
	}
	return out
}

/** The commit `pending` went to (the requested one) when the deploy built another
 *  commit (the requested one was no longer the branch tip): closed as `error`, or it
 *  would stay pending forever. Null when there is nothing to close. Pure. */
export function supersededPendingStatus(requested: string | null, built: string): CommitStatus | null {
	if (!requested || requested === built) return null
	return {
		context: DEPLOY_CONTEXT,
		state: 'error',
		description: cutDescription(`not deployed: a newer commit was built (${built.slice(0, 7)})`),
	}
}

/** A short, path-free reason for a failed call: `github 403`, `timeout`, or `error`. */
export function failureReason(err: unknown): string {
	const msg = err instanceof Error ? err.message : ''
	const m = msg.match(/^github (\d{3})\b/)
	if (m) return `github ${m[1]}`
	if (err instanceof Error && (err.name === 'GithubTimeoutError' || err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout'
	return 'error'
}

export interface GhTarget {
	token: string
	owner: string
	repo: string
}

type Post = typeof createCommitStatus

/** Post each status (in parallel). Never throws; a failed call logs one line
 *  naming the context and the reason, never the token or the API path. */
export async function postCommitStatuses(
	target: GhTarget,
	sha: string,
	statuses: CommitStatus[],
	targetUrl: string | null,
	post: Post = createCommitStatus,
): Promise<void> {
	await Promise.all(
		statuses.map(async (s) => {
			try {
				await post(target.token, target.owner, target.repo, sha, {
					state: s.state,
					context: s.context,
					description: s.description,
					...(targetUrl ? { targetUrl } : {}),
					timeoutMs: COMMIT_STATUS_TIMEOUT_MS,
				})
			} catch (err) {
				console.error(`[gh-status] ${s.context} ${s.state} not posted (${failureReason(err)})`)
			}
		}),
	)
}
