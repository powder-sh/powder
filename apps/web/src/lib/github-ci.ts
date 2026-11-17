// GitHub Actions reader. Wraps the workflow-runs and logs endpoints, with a
// process-wide TTL cache so the projects list doesn't burn rate-limit budget
// on every page load.

const GITHUB_API = 'https://api.github.com'

export interface GhRun {
	id: number
	name: string
	display_title: string
	status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'
	conclusion:
		| 'success'
		| 'failure'
		| 'cancelled'
		| 'skipped'
		| 'timed_out'
		| 'action_required'
		| 'neutral'
		| null
	html_url: string
	head_sha: string
	head_branch: string | null
	run_number: number
	event: string
	created_at: string
	updated_at: string
	run_started_at: string | null
}

interface CacheEntry<T> {
	at: number
	value: T
}

const CACHE_TTL_MS = 60_000
const runsCache = new Map<string, CacheEntry<GhRun[]>>()
const logCache = new Map<string, CacheEntry<string>>()

function headers(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'powder',
	}
}

// Recent workflow runs for a repo on a given branch. We over-fetch (10) so the
// CI tab can show a small history, but the projects-list pill only ever uses
// the first one. Errors become an empty list — a 404/403 just means the user
// doesn't have access or no Actions are configured, not a hard failure.
export async function listRunsForRepo(
	token: string,
	owner: string,
	repo: string,
	opts: { branch?: string; perPage?: number } = {},
): Promise<GhRun[]> {
	const perPage = opts.perPage ?? 10
	const key = `${owner}/${repo}@${opts.branch ?? '*'}:${perPage}`
	const cached = runsCache.get(key)
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

	const params = new URLSearchParams()
	params.set('per_page', String(perPage))
	if (opts.branch) params.set('branch', opts.branch)
	try {
		const res = await fetch(
			`${GITHUB_API}/repos/${owner}/${repo}/actions/runs?${params.toString()}`,
			{ headers: headers(token) },
		)
		if (!res.ok) {
			runsCache.set(key, { at: Date.now(), value: [] })
			return []
		}
		const data = (await res.json()) as { workflow_runs: GhRun[] }
		const value = data.workflow_runs ?? []
		runsCache.set(key, { at: Date.now(), value })
		return value
	} catch {
		runsCache.set(key, { at: Date.now(), value: [] })
		return []
	}
}

// Log tail for a specific run. GitHub returns the full log as a zip; we ask
// for the failed-step logs specifically (cheaper + targeted). Caller gets the
// last `tailBytes` characters of the most relevant step's text.
//
// Falls back to '(log unavailable)' on any error — used by the LLM diagnoser
// which should always get *something* to summarize.
export async function getRunFailureTail(
	token: string,
	owner: string,
	repo: string,
	runId: number,
	tailBytes = 8000,
): Promise<string> {
	const key = `${owner}/${repo}:${runId}:${tailBytes}`
	const cached = logCache.get(key)
	if (cached && Date.now() - cached.at < CACHE_TTL_MS * 10) return cached.value

	try {
		// /jobs first — pick the failed one(s) and grab their step logs.
		const jobsRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, {
			headers: headers(token),
		})
		if (!jobsRes.ok) {
			const fallback = `(jobs api ${jobsRes.status})`
			logCache.set(key, { at: Date.now(), value: fallback })
			return fallback
		}
		const jobsBody = (await jobsRes.json()) as {
			jobs: {
				id: number
				name: string
				conclusion: string | null
				steps?: { name: string; conclusion: string | null }[]
			}[]
		}
		const failedJob = jobsBody.jobs.find((j) => j.conclusion === 'failure') ?? jobsBody.jobs[0]
		if (!failedJob) return ''

		// /logs returns plain text for a single job (no zip dance). Bytes-limited.
		const logRes = await fetch(
			`${GITHUB_API}/repos/${owner}/${repo}/actions/jobs/${failedJob.id}/logs`,
			{ headers: headers(token), redirect: 'follow' },
		)
		if (!logRes.ok) {
			const fallback = `(log api ${logRes.status})`
			logCache.set(key, { at: Date.now(), value: fallback })
			return fallback
		}
		const text = await logRes.text()
		const tail = text.length > tailBytes ? text.slice(-tailBytes) : text
		logCache.set(key, { at: Date.now(), value: tail })
		return tail
	} catch (err) {
		const fallback = `(log fetch failed: ${err instanceof Error ? err.message : 'unknown'})`
		logCache.set(key, { at: Date.now(), value: fallback })
		return fallback
	}
}

// Parse `git@github.com:owner/repo.git` and `https://github.com/owner/repo` into {owner, repo}.
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
	const ssh = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/)
	if (ssh) return { owner: ssh[1] ?? '', repo: ssh[2] ?? '' }
	const https = url.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
	if (https) return { owner: https[1] ?? '', repo: https[2] ?? '' }
	return null
}

export interface GhCommit {
	sha: string
	message: string
	authorName: string | null
	authorLogin: string | null
	authoredAt: string | null
	htmlUrl: string
}

// Cache for SHA-pinned commit lookups (used by the /deploys list to show commit
// messages for historical deploys). Commits are immutable once authored, so this
// cache has no TTL: once populated it lives until process restart.
const shaCommitCache = new Map<string, GhCommit | null>()

// Resolve a specific SHA through the commits `:ref` API endpoint (GitHub accepts a
// commit hash or a branch name there).
export async function getCommitBySha(
	token: string,
	owner: string,
	repo: string,
	sha: string,
): Promise<GhCommit | null> {
	const key = `${owner}/${repo}/${sha}`
	const cached = shaCommitCache.get(key)
	if (cached !== undefined) return cached
	try {
		const res = await fetch(
			`${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`,
			{ headers: headers(token) },
		)
		if (!res.ok) {
			shaCommitCache.set(key, null)
			return null
		}
		const data = (await res.json()) as {
			sha: string
			html_url: string
			commit: { message: string; author: { name: string; date: string } | null }
			author: { login: string } | null
		}
		const value: GhCommit = {
			sha: data.sha,
			message: ((data.commit.message ?? '').split('\n')[0] ?? '').slice(0, 200),
			authorName: data.commit.author?.name ?? null,
			authorLogin: data.author?.login ?? null,
			authoredAt: data.commit.author?.date ?? null,
			htmlUrl: data.html_url,
		}
		shaCommitCache.set(key, value)
		return value
	} catch {
		shaCommitCache.set(key, null)
		return null
	}
}
