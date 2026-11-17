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
import { dashboardUrl } from './hosts'
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

function deployLogUrl(repo: AppRepo, deployId: string): string {
	// No request here: the dashboard origin comes from BETTER_AUTH_URL (lib/hosts.ts).
	return `${dashboardUrl()}/servers/${repo.serverId}/${repo.containerName}/deploys/${deployId}`
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
		const integration = await getAdminGithubIntegration(repo.ownerUserId)
		if (!integration) return
		const parsed = parseRepoUrl(repo.repoUrl)
		if (!parsed) return

		const ghDeployment = await createDeployment(
			integration.token,
			parsed.owner,
			parsed.repo,
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
			integration.token,
			parsed.owner,
			parsed.repo,
			ghDeployment.id,
			'in_progress',
			{
				description: redactSecrets('powder is building'),
				logUrl: deployLogUrl(repo, deploy.id),
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
		const integration = await getAdminGithubIntegration(repo.ownerUserId)
		if (!integration) return
		const parsed = parseRepoUrl(repo.repoUrl)
		if (!parsed) return

		const prs = await listOpenPRsForBranch(integration.token, parsed.owner, parsed.repo, branch)
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
			integration.token,
			parsed.owner,
			parsed.repo,
			pr.number,
		)
		const existing = comments.find((c) => c.body.includes(PREVIEW_COMMENT_MARKER))

		if (existing) {
			await updateIssueComment(
				integration.token,
				parsed.owner,
				parsed.repo,
				existing.id,
				body,
			)
		} else {
			await createIssueComment(
				integration.token,
				parsed.owner,
				parsed.repo,
				pr.number,
				body,
			)
		}
	} catch (err) {
		console.error('[gh-preview-comment] failed:', err)
	}
}

// Called from every terminal path (success, fail, rollback, health-fail).
// Looks up the saved github_deployment_id from the deploys row and POSTs a
// status. If the start notification didn't run (no integration, parsing
// failed) this is a no-op. Caller only passes the deploy id — saves
// threading a `ghDeploymentId` variable through every IIFE.
export async function notifyDeploymentFinished(
	repo: AppRepo,
	deployId: string,
	state: GhDeploymentState,
	/** Becomes a permanent, often public, GitHub status: must be masked. */
	description: SafeText,
): Promise<void> {
	if (!repo.ownerUserId) return
	try {
		const [row] = await db
			.select({ githubDeploymentId: deploys.githubDeploymentId })
			.from(deploys)
			.where(eq(deploys.id, deployId))
		if (!row?.githubDeploymentId) return

		const integration = await getAdminGithubIntegration(repo.ownerUserId)
		if (!integration) return
		const parsed = parseRepoUrl(repo.repoUrl)
		if (!parsed) return

		await createDeploymentStatus(
			integration.token,
			parsed.owner,
			parsed.repo,
			Number(row.githubDeploymentId),
			state,
			{
				description,
				logUrl: deployLogUrl(repo, deployId),
				environmentUrl: state === 'success' ? await environmentUrlFor(repo) : undefined,
			},
		)
	} catch (err) {
		console.error('[gh-deploy] notifyDeploymentFinished failed:', err)
	}
}
