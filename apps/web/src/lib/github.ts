// Tiny GitHub API wrapper — just the endpoints powder needs.

import type { SafeText } from './secret-text'

const GITHUB_API = 'https://api.github.com'

function headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'powder',
	}
}

// owner and repo come from stored repo URLs and request bodies.
// One builder for every /repos/<owner>/<repo> path: each segment must look like a
// GitHub name (no '/', no '..', no empty part) and is encoded, so a crafted value
// cannot walk to another API path.
const GH_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

export function isGithubName(s: string): boolean {
	return GH_NAME_RE.test(s) && s !== '.' && s !== '..' && !s.includes('..')
}

export function repoPath(owner: string, repo: string): string {
	if (!isGithubName(owner) || !isGithubName(repo))
		throw new Error(
			`invalid GitHub owner/repo: ${JSON.stringify(`${owner}/${repo}`).slice(0, 120)}`,
		)
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

function int(n: number): string {
	if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid GitHub id: ${n}`)
	return String(n)
}

/** owner/repo of a github.com repo URL (ssh `git@github.com:o/r.git`,
 *  `ssh://git@github.com/o/r`, `https://github.com/o/r(.git)`), or null for any
 *  other host or a name that is not a plain GitHub name. */
export function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
	const u = url.trim()
	const m =
		u.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
		u.match(/^ssh:\/\/git@github\.com(?::22)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
		u.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i)
	if (!m || !m[1] || !m[2]) return null
	if (!isGithubName(m[1]) || !isGithubName(m[2])) return null
	return { owner: m[1], repo: m[2] }
}

/** Default time limit of one GitHub API call. A hung GitHub must not hang the
 *  page, deploy step or route waiting on it; every call here is a single small
 *  request, so 15 s is far above a normal answer. */
export const GH_TIMEOUT_MS = 15_000

export type GhFetchInit = RequestInit & {
	/** Overrides GH_TIMEOUT_MS. Ignored when `signal` is given. */
	timeoutMs?: number
}

function ghSignal(init: GhFetchInit): AbortSignal {
	return init.signal ?? AbortSignal.timeout(init.timeoutMs ?? GH_TIMEOUT_MS)
}

function isTimeout(e: unknown): boolean {
	return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
}

async function ghFetch(token: string, path: string, init: GhFetchInit = {}) {
	const { timeoutMs, ...rest } = init
	let res: Response
	try {
		res = await fetch(`${GITHUB_API}${path}`, {
			...rest,
			signal: ghSignal(init),
			headers: {
				...headers(token),
				...(rest.body ? { 'Content-Type': 'application/json' } : {}),
				...((rest.headers as Record<string, string>) ?? {}),
			},
		})
	} catch (e) {
		if (isTimeout(e)) throw new GithubTimeoutError(path, timeoutMs ?? GH_TIMEOUT_MS)
		throw e
	}
	const body = await res.text()
	if (!res.ok) {
		let err = body
		try {
			const parsed = JSON.parse(body) as { message?: string }
			if (parsed.message) err = parsed.message
		} catch {
			// ignore
		}
		throw new Error(`github ${res.status}: ${err}`)
	}
	return body ? JSON.parse(body) : null
}

/** GitHub did not answer within the time limit (or the caller's signal aborted). */
export class GithubTimeoutError extends Error {
	constructor(path: string, ms: number) {
		super(`github timeout: no answer within ${ms} ms (${path.split('?')[0]})`)
		this.name = 'GithubTimeoutError'
	}
}

export interface GhUser {
	login: string
	id: number
	avatar_url: string
	name: string | null
}

export async function getViewer(token: string, opts: { timeoutMs?: number } = {}): Promise<GhUser> {
	return ghFetch(token, '/user', opts)
}

export interface GhRepo {
	id: number
	name: string
	full_name: string
	private: boolean
	owner: { login: string; avatar_url: string }
	default_branch: string
	html_url: string
	ssh_url: string
	updated_at: string
}

export async function listRepos(token: string): Promise<GhRepo[]> {
	const all: GhRepo[] = []
	let page = 1
	while (true) {
		const batch = (await ghFetch(
			token,
			`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
		)) as GhRepo[]
		if (!Array.isArray(batch) || batch.length === 0) break
		all.push(...batch)
		if (batch.length < 100) break
		page++
		if (page > 10) break // safety: cap at 1000 repos
	}
	return all
}

export interface GhHook {
	id: number
	url: string
}

export async function createWebhook(
	token: string,
	owner: string,
	repo: string,
	webhookUrl: string,
	secret: string,
): Promise<GhHook> {
	return ghFetch(token, `${repoPath(owner, repo)}/hooks`, {
		method: 'POST',
		body: JSON.stringify({
			name: 'web',
			active: true,
			events: ['push'],
			config: { url: webhookUrl, content_type: 'json', secret, insecure_ssl: '0' },
		}),
	})
}

export async function createDeployKey(
	token: string,
	owner: string,
	repo: string,
	title: string,
	key: string,
	readOnly = true,
): Promise<{ id: number; key: string }> {
	return ghFetch(token, `${repoPath(owner, repo)}/keys`, {
		method: 'POST',
		body: JSON.stringify({ title, key, read_only: readOnly }),
	})
}

/** remove a deploy key / webhook powder installed. A 404 (already
 *  gone) counts as done. */
export async function deleteDeployKey(
	token: string,
	owner: string,
	repo: string,
	keyId: number,
): Promise<void> {
	try {
		await ghFetch(token, `${repoPath(owner, repo)}/keys/${int(keyId)}`, { method: 'DELETE' })
	} catch (err) {
		if (err instanceof Error && err.message.startsWith('github 404')) return
		throw err
	}
}

export async function deleteWebhook(
	token: string,
	owner: string,
	repo: string,
	hookId: number,
): Promise<void> {
	try {
		await ghFetch(token, `${repoPath(owner, repo)}/hooks/${int(hookId)}`, { method: 'DELETE' })
	} catch (err) {
		if (err instanceof Error && err.message.startsWith('github 404')) return
		throw err
	}
}

/** One repo hook (config.url is where it posts), or null when GitHub has no such hook. */
export async function getWebhook(
	token: string,
	owner: string,
	repo: string,
	hookId: number,
): Promise<{ id: number; config?: { url?: unknown } } | null> {
	try {
		return await ghFetch(token, `${repoPath(owner, repo)}/hooks/${int(hookId)}`)
	} catch (err) {
		if (err instanceof Error && err.message.startsWith('github 404')) return null
		throw err
	}
}

/** GitHub's numeric repository id (stable across renames and transfers). */
export async function getRepoInfo(
	token: string,
	owner: string,
	repo: string,
): Promise<{ id: number; full_name: string }> {
	return ghFetch(token, repoPath(owner, repo))
}

// Fetches a single file from a repo. Returns the decoded text, or null if the
// file doesn't exist (404 → null, other errors throw).
export async function getRepoFile(
	token: string,
	owner: string,
	repo: string,
	path: string,
	ref?: string,
): Promise<string | null> {
	const url =
		`${repoPath(owner, repo)}/contents/${encodeURIComponent(path)}` +
		(ref ? `?ref=${encodeURIComponent(ref)}` : '')
	try {
		const data = (await ghFetch(token, url)) as { content?: string; encoding?: string }
		if (!data.content) return null
		// content is base64 (with newlines). decode to utf-8.
		const buf = Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8')
		return buf.toString('utf8')
	} catch (err) {
		if (err instanceof Error && err.message.includes('404')) return null
		throw err
	}
}

// Returns true if the repo has a Dockerfile at the given path (default
// "Dockerfile" at the root). Cheap HEAD via the contents API.
export async function repoHasDockerfile(
	token: string,
	owner: string,
	repo: string,
	path = 'Dockerfile',
	ref?: string,
): Promise<boolean> {
	const file = await getRepoFile(token, owner, repo, path, ref)
	return file !== null
}

// Creates or updates a file in a repo. If the file already exists at `path`,
// the call requires its current sha — we look it up first.
export async function commitFile(
	token: string,
	owner: string,
	repo: string,
	path: string,
	content: string,
	message: string,
	branch: string,
	options: { skipIfUnchanged?: boolean } = {},
): Promise<{ sha: string; commitSha: string; skipped?: boolean }> {
	const url = `${repoPath(owner, repo)}/contents/${encodeURIComponent(path)}`
	const newContentB64 = Buffer.from(content, 'utf8').toString('base64')

	let existingSha: string | undefined
	let existingContent: string | undefined
	try {
		const head = (await ghFetch(token, `${url}?ref=${encodeURIComponent(branch)}`)) as {
			sha?: string
			content?: string
		}
		existingSha = head.sha
		existingContent = head.content
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('404')) throw err
	}

	if (options.skipIfUnchanged && existingContent && existingSha) {
		// GitHub returns base64 with newlines — strip them to compare to ours.
		const normalized = existingContent.replace(/\s+/g, '')
		if (normalized === newContentB64.replace(/\s+/g, '')) {
			return { sha: existingSha, commitSha: '', skipped: true }
		}
	}

	const body = JSON.stringify({
		message,
		content: newContentB64,
		branch,
		...(existingSha ? { sha: existingSha } : {}),
	})
	const data = (await ghFetch(token, url, { method: 'PUT', body })) as {
		content: { sha: string }
		commit: { sha: string }
	}
	return { sha: data.content.sha, commitSha: data.commit.sha }
}

// Deployments API. Used to surface deploy status back to GitHub so the
// commit/PR view shows the same green/red dot users expect from Vercel/Netlify.
//
// Two-step flow:
//   1. createDeployment at deploy start → returns { id }
//   2. createDeploymentStatus(id, 'in_progress') immediately, then 'success' /
//      'failure' / 'error' when the deploy finishes.
//
// Required scope: `repo:deployment` (subset of `repo`, which our integration
// already requires). For PATs without `repo`, this'll 403 — the calling
// helper logs and continues since deploy status is informational.
export interface GhDeployment {
	id: number
	url: string
	sha: string
	ref: string
	environment: string
}

export async function createDeployment(
	token: string,
	owner: string,
	repo: string,
	ref: string,
	opts: {
		environment?: string
		description?: string
		productionEnvironment?: boolean
		transientEnvironment?: boolean
	} = {},
): Promise<GhDeployment> {
	return ghFetch(token, `${repoPath(owner, repo)}/deployments`, {
		method: 'POST',
		body: JSON.stringify({
			ref,
			// Skip GH's status checks gate — powder is the deployer and
			// already ran them (or doesn't care).
			required_contexts: [],
			auto_merge: false,
			environment: opts.environment ?? 'production',
			description: opts.description?.slice(0, 140),
			production_environment: opts.productionEnvironment ?? true,
			transient_environment: opts.transientEnvironment ?? false,
		}),
	})
}

export type GhDeploymentState = 'in_progress' | 'success' | 'failure' | 'error' | 'queued'

export async function createDeploymentStatus(
	token: string,
	owner: string,
	repo: string,
	deploymentId: number,
	state: GhDeploymentState,
	opts: {
		/** Permanent and public on public repos: SafeText only (lib/secret-text.ts). */
		description?: SafeText
		logUrl?: string
		environmentUrl?: string
	} = {},
): Promise<{ id: number }> {
	return ghFetch(token, `${repoPath(owner, repo)}/deployments/${int(deploymentId)}/statuses`, {
		method: 'POST',
		body: JSON.stringify({
			state,
			description: opts.description?.slice(0, 140),
			log_url: opts.logUrl,
			environment_url: opts.environmentUrl,
		}),
	})
}

// Commit statuses (POST /repos/{owner}/{repo}/statuses/{sha}): the check a
// commit and its pull request show. Decided in github-commit-status.ts.
// Needs commit statuses: read and write (fine-grained) or repo:status (classic).
export type GhCommitState = 'pending' | 'success' | 'failure' | 'error'

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

export async function createCommitStatus(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	opts: {
		state: GhCommitState
		context: string
		/** Permanent and public on public repos: SafeText only (lib/secret-text.ts). */
		description: SafeText
		targetUrl?: string
		timeoutMs?: number
	},
): Promise<void> {
	if (!COMMIT_SHA_RE.test(sha)) throw new Error('invalid commit sha')
	await ghFetch(token, `${repoPath(owner, repo)}/statuses/${sha}`, {
		method: 'POST',
		timeoutMs: opts.timeoutMs,
		body: JSON.stringify({
			state: opts.state,
			context: opts.context,
			description: opts.description.slice(0, 140),
			...(opts.targetUrl ? { target_url: opts.targetUrl } : {}),
		}),
	})
}

// Pull-request lookup + comment APIs. Used by the preview-deploy flow to
// post a sticky comment on the PR with the preview URL, so reviewers don't
// have to dig through the powder dashboard to find it.
//
// PRs use the issues comments endpoint (every PR is also an issue). The
// comment body carries an HTML marker so we can find + update our own
// comment on subsequent pushes instead of duplicating.
export interface GhPullRequest {
	number: number
	html_url: string
	head: { ref: string; sha: string }
	state: string
}

export async function listOpenPRsForBranch(
	token: string,
	owner: string,
	repo: string,
	branch: string,
): Promise<GhPullRequest[]> {
	// `?head={owner}:{branch}` matches same-repo PRs only; PRs from forks
	// are not listed (they would need a wider search, not worth the API cost).
	return ghFetch(
		token,
		`${repoPath(owner, repo)}/pulls?state=open&head=${encodeURIComponent(owner)}:${encodeURIComponent(branch)}&per_page=10`,
	)
}

export interface GhIssueComment {
	id: number
	body: string
	html_url: string
}

export async function listIssueComments(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<GhIssueComment[]> {
	// PR comments are paginated; preview-comment finder only needs the first
	// page since our marker comment is created early and stays editable.
	return ghFetch(token, `${repoPath(owner, repo)}/issues/${int(issueNumber)}/comments?per_page=100`)
}

export async function createIssueComment(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<GhIssueComment> {
	return ghFetch(token, `${repoPath(owner, repo)}/issues/${int(issueNumber)}/comments`, {
		method: 'POST',
		body: JSON.stringify({ body }),
	})
}

export async function updateIssueComment(
	token: string,
	owner: string,
	repo: string,
	commentId: number,
	body: string,
): Promise<GhIssueComment> {
	return ghFetch(token, `${repoPath(owner, repo)}/issues/comments/${int(commentId)}`, {
		method: 'PATCH',
		body: JSON.stringify({ body }),
	})
}

export async function getTokenScopes(token: string): Promise<string[]> {
	const res = await fetch(`${GITHUB_API}/user`, { headers: headers(token), signal: AbortSignal.timeout(GH_TIMEOUT_MS) })
	const scopesHeader = res.headers.get('x-oauth-scopes') ?? ''
	return scopesHeader
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}
