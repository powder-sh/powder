// High-level wrappers around the GitHub Deployments API. Two responsibilities:
//   1. Hide token lookup + URL parsing + try/catch from every deploy route.
//   2. Persist the GH deployment id back to the deploys row at start, then
//      look it up at finish. Without this round-trip the terminal status PATCH
//      can't target the right deployment object.
//
// All calls are best-effort. GitHub being down, the user revoking the token,
// the repo being deleted — none of these should fail a deploy. The functions
// log the underlying error and resolve normally.

import { defaultHostFor } from './app-hosts'
import { db, deploys, eq } from './db'
import type { AppRepo, Deploy } from './db'
import {
	type GhDeploymentState,
	createDeployment,
	createDeploymentStatus,
	createIssueComment,
	listIssueComments,
	listOpenPRsForBranch,
	parseGithubRepoUrl,
	updateIssueComment,
} from './github'
import {
	type GhTarget,
	commitStatusEnabled,
	commitStatusSha,
	failureReason,
	pendingCommitStatus,
	postCommitStatuses,
	supersededPendingStatus,
	terminalCommitStatuses,
} from './github-commit-status'
import type { TestGate } from '@powder/db/schema'
import { dashboardUrl, dashboardUrlOrNull } from './hosts'
import { getAdminGithubIntegration } from './integrations'
import { type SafeText, redactSecrets } from './secret-text'
import { getServer } from './servers'
import { isTraefikServer } from './traefik-servers'

interface OwnerRepo {
	owner: string
	repo: string
}

// github.com only, plain GitHub names only (no '/', no '..'); the
// one parser lives in github.ts next to the path builder.
export function parseRepoUrl(url: string): OwnerRepo | null {
	return parseGithubRepoUrl(url)
}

/** The one token + repo lookup of every GitHub call about an app (Deployments,
 *  commit statuses, preview comments): a CURRENT admin's token (the owner's
 *  first) and a github.com owner/repo. Null when either is missing. */
async function githubTarget(repo: AppRepo): Promise<GhTarget | null> {
	if (!repo.ownerUserId) return null
	const integration = await getAdminGithubIntegration(repo.ownerUserId)
	if (!integration) return null
	const parsed = parseRepoUrl(repo.repoUrl)
	if (!parsed) return null
	return { token: integration.token, owner: parsed.owner, repo: parsed.repo }
}

/** The deploy's page for a commit status link, or null when this powder has no
 *  public URL configured (the status then has no link). */
function deployPageUrlOrNull(deployId: string): string | null {
	const base = dashboardUrlOrNull()
	return base ? `${base}/deploys/${encodeURIComponent(deployId)}` : null
}

// The dashboard's deploy page (app/(dashboard)/deploys/[id]).
function deployLogUrl(deployId: string): string {
	// No request here: the dashboard origin comes from BETTER_AUTH_URL (lib/hosts.ts).
	return `${dashboardUrl()}/deploys/${encodeURIComponent(deployId)}`
}

async function environmentUrlFor(repo: AppRepo): Promise<string | undefined> {
	// Apps on a Traefik server have a deterministic public URL; apps on nginx servers need
	// nginx introspection which isn't worth it for an informational link.
	const server = await getServer(repo.serverId)
	if (server && (await isTraefikServer(server))) {
		const host = defaultHostFor(server, repo.containerName)
		return host ? `https://${host}` : undefined
	}
	return undefined
}

// Called right after startDeploy succeeds. Creates the GH deployment + posts
// `in_progress` status, then writes the deployment id back to the deploys row
// so notifyDeploymentFinished can find it.
export async function notifyDeploymentStarted(
	repo: AppRepo,
	deploy: Deploy,
	ref: string,
): Promise<void> {
	if (!repo.ownerUserId) return
	try {
		const gh = await githubTarget(repo)
		if (!gh) return

		const ghDeployment = await createDeployment(
			gh.token,
			gh.owner,
			gh.repo,
			ref,
			{
				environment: 'production',
				description: `powder · ${deploy.kind}`,
				productionEnvironment: true,
			},
		)

		await db
			.update(deploys)
			.set({ githubDeploymentId: String(ghDeployment.id) })
			.where(eq(deploys.id, deploy.id))

		// Fire-and-forget the in_progress status — the terminal status is what
		// matters; this is just for UX so the dot turns yellow promptly.
		createDeploymentStatus(
			gh.token,
			gh.owner,
			gh.repo,
			ghDeployment.id,
			'in_progress',
			{
				description: redactSecrets('powder is building'),
				logUrl: deployLogUrl(deploy.id),
			},
		).catch((err) => console.error('[gh-deploy] in_progress status failed:', err))
	} catch (err) {
		console.error('[gh-deploy] notifyDeploymentStarted failed:', err)
	}
}

// Sticky PR comment marker. Used to find + update our own previous comment
// instead of duplicating one per push. The HTML comment is invisible in the
// rendered PR view but matchable in the raw body.
const PREVIEW_COMMENT_MARKER = '<!-- powder-preview-comment -->'

function buildPreviewCommentBody(opts: {
	url: string
	host: string
	sha: string | null
	deployLogUrl: string | null
}): string {
	const sha = opts.sha ? `\`${opts.sha.slice(0, 7)}\`` : '_pending_'
	const updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
	const logsLine = opts.deployLogUrl
		? ` · [logs](${opts.deployLogUrl})`
		: ''
	return [
		PREVIEW_COMMENT_MARKER,
		`### 🚀 Preview deploy`,
		``,
		`**[${opts.host}](${opts.url})** · ${sha}${logsLine}`,
		``,
		`<sub>Updated ${updatedAt} by powder · DB shared with production</sub>`,
	].join('\n')
}

// Posts (or updates) a sticky comment on the open PR for `branch` with the
// preview URL. No-op if no integration, no open PR, or the API is down.
// Same best-effort contract as the deployment-status calls.
export async function commentPreviewOnPR(
	repo: AppRepo,
	branch: string,
	opts: {
		previewUrl: string
		previewHost: string
		sha: string | null
		deployLogUrl?: string
	},
): Promise<void> {
	if (!repo.ownerUserId) return
	try {
		const gh = await githubTarget(repo)
		if (!gh) return

		const prs = await listOpenPRsForBranch(gh.token, gh.owner, gh.repo, branch)
		const pr = prs[0]
		if (!pr) {
			// No PR open yet — push happened before PR creation. Comment will appear on next push.
			return
		}

		const body = buildPreviewCommentBody({
			url: opts.previewUrl,
			host: opts.previewHost,
			sha: opts.sha,
			deployLogUrl: opts.deployLogUrl ?? null,
		})

		// Look for existing sticky comment by marker. First page (100 comments)
		// is enough — our comment is created on the first push, before reviewers
		// pile up replies.
		const comments = await listIssueComments(
			gh.token,
			gh.owner,
			gh.repo,
			pr.number,
		)
		const existing = comments.find((c) => c.body.includes(PREVIEW_COMMENT_MARKER))

		if (existing) {
			await updateIssueComment(
				gh.token,
				gh.owner,
				gh.repo,
				existing.id,
				body,
			)
		} else {
			await createIssueComment(
				gh.token,
				gh.owner,
				gh.repo,
				pr.number,
				body,
			)
		}
	} catch (err) {
		console.error('[gh-preview-comment] failed:', err)
	}
}

/** What a finished deploy tells the commit status code (github-commit-status.ts). */
export interface CommitCheckFacts {
	kind: string
	requestedSha: string | null
	/** the commit the deploy built; null when it died before the sync */
	sha: string | null
	failedStep: string | null
	/** the deploy row's error_summary (masked by deploy-failure.ts) */
	errorSummary?: SafeText | null
	/** the deploy's recorded test gate result (the value it writes to deploys.test_gate); decides powder/test-gate */
	testGate: TestGate | null
}

// The pending commit status in flight per deploy (this process), so the terminal
// one is never sent before it and overwritten by it.
const pendingPosts = new Map<string, Promise<void>>()

/** `pending` on powder/deploy once a git deploy with a known commit is claimed.
 *  Not awaited by the runner (fire and forget); never throws. */
export function notifyCommitPending(repo: AppRepo, deploy: Pick<Deploy, 'id' | 'kind' | 'requestedSha'>): void {
	const sha = commitStatusSha({ kind: deploy.kind, requestedSha: deploy.requestedSha })
	if (!sha || !repo.ownerUserId || !commitStatusEnabled()) return
	const post = async () => {
		try {
			const gh = await githubTarget(repo)
			if (!gh) return
			await postCommitStatuses(gh, sha, [pendingCommitStatus()], deployPageUrlOrNull(deploy.id))
		} catch (err) {
			console.error(`[gh-status] pending not posted (${failureReason(err)})`)
		}
	}
	// post() never rejects; the entry is dropped once it settled
	const p: Promise<void> = post().then(() => {
		if (pendingPosts.get(deploy.id) === p) pendingPosts.delete(deploy.id)
	})
	pendingPosts.set(deploy.id, p)
}

async function notifyCommitFinished(
	repo: AppRepo,
	deployId: string,
	ok: boolean,
	check: CommitCheckFacts,
	known: GhTarget | null,
): Promise<void> {
	try {
		await pendingPosts.get(deployId)
		const sha = commitStatusSha({ kind: check.kind, gitSha: check.sha, requestedSha: check.requestedSha })
		if (!sha || !commitStatusEnabled()) return
		const gh = known ?? (await githubTarget(repo))
		if (!gh) return
		await postFinished(gh, sha, check.requestedSha, ok, check, deployPageUrlOrNull(deployId))
	} catch (err) {
		console.error(`[gh-status] terminal status not posted (${failureReason(err)})`)
	}
}

/** The result on the built commit, and `error` on the requested one when the deploy
 *  built another commit (pending went to the requested one). */
async function postFinished(
	gh: GhTarget,
	built: string,
	requested: string | null,
	ok: boolean,
	d: { failedStep: string | null; errorSummary?: SafeText | null; testGate: TestGate | null },
	link: string | null,
): Promise<void> {
	const req = commitStatusSha({ kind: 'git_deploy', requestedSha: requested })
	const close = req ? supersededPendingStatus(req, built) : null
	await Promise.all([
		postCommitStatuses(gh, built, terminalCommitStatuses({ ok, sha: built, failedStep: d.failedStep, errorSummary: d.errorSummary, testGate: d.testGate }), link),
		close && req ? postCommitStatuses(gh, req, [close], link) : Promise.resolve(),
	])
}

/** Commit statuses of a preview deploy (a branch push): pending when the spin
 *  starts, then the result. The same two contexts as a git deploy, on the pushed
 *  commit, which is what puts the check on the branch's pull request. The link
 *  goes to the app's page (a preview has no deploy row). Never throws. */
export async function notifyPreviewCommit(
	repo: AppRepo,
	pushedSha: string | null,
	result:
		| { phase: 'pending' }
		| { phase: 'done'; ok: boolean; builtSha: string | null; failedStep: string | null; errorSummary: SafeText | null; testGate: TestGate | null },
): Promise<void> {
	if (!repo.ownerUserId || !commitStatusEnabled()) return
	const sha = commitStatusSha({ kind: 'git_deploy', requestedSha: pushedSha })
	if (!sha) return
	try {
		const gh = await githubTarget(repo)
		if (!gh) return
		const base = dashboardUrlOrNull()
		const link = base ? `${base}/projects/${encodeURIComponent(repo.id)}` : null
		if (result.phase === 'pending') return await postCommitStatuses(gh, sha, [pendingCommitStatus()], link)
		const built = commitStatusSha({ kind: 'git_deploy', gitSha: result.builtSha, requestedSha: sha }) ?? sha
		await postFinished(gh, built, sha, result.ok, result, link)
	} catch (err) {
		console.error(`[gh-status] preview status not posted (${failureReason(err)})`)
	}
}

// Called from every terminal path (success, fail, rollback, health-fail, watchdog reap).
// Looks up the saved github_deployment_id from the deploys row and POSTs a
// status. If the start notification didn't run (no integration, parsing
// failed) this is a no-op. Caller only passes the deploy id — saves
// threading a `ghDeploymentId` variable through every IIFE.
// With `check` (git deploys run by the deploy runner, and the watchdog) it also
// posts the commit statuses (github-commit-status.ts), whether or not a
// Deployment exists. Rollbacks and cancelled held pushes pass none.
export async function notifyDeploymentFinished(
	repo: AppRepo,
	deployId: string,
	state: GhDeploymentState,
	/** Becomes a permanent, often public, GitHub status: must be masked. */
	description: SafeText,
	check?: CommitCheckFacts,
): Promise<void> {
	if (!repo.ownerUserId) return
	let gh: GhTarget | null = null
	try {
		const [row] = await db
			.select({ githubDeploymentId: deploys.githubDeploymentId })
			.from(deploys)
			.where(eq(deploys.id, deployId))
		if (row?.githubDeploymentId) {
			gh = await githubTarget(repo)
			if (gh) {
				await createDeploymentStatus(
					gh.token,
					gh.owner,
					gh.repo,
					Number(row.githubDeploymentId),
					state,
					{
						description,
						logUrl: deployLogUrl(deployId),
						environmentUrl: state === 'success' ? await environmentUrlFor(repo) : undefined,
					},
				)
			}
		}
	} catch (err) {
		console.error('[gh-deploy] notifyDeploymentFinished failed:', err)
	}
	if (check) await notifyCommitFinished(repo, deployId, state === 'success', check, gh)
}
