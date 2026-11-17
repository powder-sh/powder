// A GitHub push hook whose token powder no longer has (app re-registered or
// deleted outside powder's own delete flow) keeps POSTing to
// /api/webhooks/deploy/<token> and gets 4xx forever. powder removes such a hook
// itself. An unknown token cannot be signature-verified, so the guards are:
// the repository must be one powder manages, the token must still be unknown
// right before acting, and the hook GitHub returns for X-GitHub-Hook-ID must
// point at this powder's own /api/webhooks/deploy/<that exact token> URL.
import { appRepos, db, repoDeploymentGroups, sql } from './db'
import { deleteWebhook, getWebhook, isGithubName } from './github'
import { dashboardUrlOrNull, siteHosts, webhookBaseUrlOrNull } from './hosts'
import { getAdminGithubIntegration } from './integrations'
import { getGroupByToken } from './repo-groups'
import { getRepoByToken } from './repos'

/** One attempt per hook id per window, and a ceiling on all attempts per window,
 *  so a flood of deliveries (or forged hook ids) cannot make powder spam GitHub.
 *  Only deliveries that name a managed repo count against either limit. */
export const STALE_HOOK_WINDOW_MS = 10 * 60 * 1000
export const STALE_HOOK_MAX_PER_WINDOW = 30

export interface StaleHookDeps {
	/** The owner of an app or group whose repo_url is github.com/<owner>/<repo>, or null. */
	managedRepoOwner(owner: string, repo: string): Promise<{ ownerUserId: string | null } | null>
	tokenKnown(token: string): Promise<boolean>
	githubToken(preferUserId: string | null): Promise<string | null>
	getHook(
		token: string,
		owner: string,
		repo: string,
		hookId: number,
	): Promise<{ config?: { url?: unknown } } | null>
	deleteHook(token: string, owner: string, repo: string, hookId: number): Promise<void>
	/** This powder's own origins (no trailing slash) that a deploy hook URL may use. */
	ownOrigins(): string[]
	now(): number
	log(line: string): void
}

export type StaleHookOutcome =
	| 'deleted'
	| 'rate limited'
	| 'bad input'
	| 'unmanaged repo'
	| 'token known'
	| 'no github token'
	| 'hook not found'
	| 'url mismatch'
	| `failed: ${string}`

const attempts = new Map<number, number>()
let windowStart = 0
let windowCount = 0

/** Test-only: forget every recorded attempt. */
export function resetStaleHookLimiter(): void {
	attempts.clear()
	windowStart = 0
	windowCount = 0
}

function claimAttempt(hookId: number, now: number): boolean {
	if (now - windowStart >= STALE_HOOK_WINDOW_MS) {
		windowStart = now
		windowCount = 0
		for (const [id, t] of attempts) if (now - t >= STALE_HOOK_WINDOW_MS) attempts.delete(id)
	}
	const last = attempts.get(hookId)
	if (last !== undefined && now - last < STALE_HOOK_WINDOW_MS) return false
	if (windowCount >= STALE_HOOK_MAX_PER_WINDOW) return false
	attempts.set(hookId, now)
	windowCount++
	return true
}

/** owner/repo from a push payload's repository.full_name, or null. */
export function payloadFullName(body: string): { owner: string; repo: string } | null {
	let full: unknown
	try {
		full = (JSON.parse(body) as { repository?: { full_name?: unknown } } | null)?.repository
			?.full_name
	} catch {
		return null
	}
	if (typeof full !== 'string') return null
	const [owner, repo, extra] = full.split('/')
	if (extra !== undefined || !owner || !repo || !isGithubName(owner) || !isGithubName(repo))
		return null
	return { owner, repo }
}

/** Postgres (and JS, case-insensitive) regex for every github.com URL form
 *  parseGithubRepoUrl accepts for owner/repo. Inputs are GitHub names
 *  ([A-Za-z0-9._-]), so escaping '.' is all the quoting needed. */
export function githubRepoUrlRegex(owner: string, repo: string): string {
	if (!isGithubName(owner) || !isGithubName(repo)) throw new Error('invalid GitHub owner/repo')
	const esc = (s: string) => s.replace(/\./g, '\\.')
	return `^(git@github\\.com:|ssh://git@github\\.com(:22)?/|https?://(www\\.)?github\\.com/)${esc(owner)}/${esc(repo)}(\\.git)?/?$`
}

export async function removeStaleHook(
	input: {
		token: string
		hookId: string | null
		repository: { owner: string; repo: string } | null
	},
	deps: StaleHookDeps = defaultDeps,
): Promise<StaleHookOutcome> {
	const hookId = Number(input.hookId)
	if (
		!input.hookId ||
		!/^[0-9]{1,15}$/.test(input.hookId) ||
		!Number.isSafeInteger(hookId) ||
		!input.repository
	) {
		return 'bad input'
	}
	const { owner, repo } = input.repository
	const wanted = `${owner}/${repo}`
	try {
		const managed = await deps.managedRepoOwner(owner, repo)
		if (!managed) return 'unmanaged repo'
		// The budget is claimed only for a repo this powder manages, so forged
		// deliveries naming random repos cannot use it up.
		if (!claimAttempt(hookId, deps.now())) return 'rate limited'
		if (await deps.tokenKnown(input.token)) return 'token known'
		const gh = await deps.githubToken(managed.ownerUserId)
		if (!gh) return 'no github token'
		const hook = await deps.getHook(gh, owner, repo, hookId)
		if (!hook) return 'hook not found'
		const url = hook.config?.url
		const expected = new Set(
			deps.ownOrigins().map((o) => `${o}/api/webhooks/deploy/${input.token}`),
		)
		if (typeof url !== 'string' || !expected.has(url)) return 'url mismatch'
		// re-check right before the delete: a token registered meanwhile is never removed
		if (await deps.tokenKnown(input.token)) return 'token known'
		await deps.deleteHook(gh, owner, repo, hookId)
		deps.log(
			`[webhook] removed stale GitHub hook ${hookId} on ${owner}/${repo}: it posts to an unknown deploy token (${input.token.slice(0, 8)}...)`,
		)
		return 'deleted'
	} catch (err) {
		const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200)
		console.warn(`[webhook] stale hook ${hookId} on ${wanted}: cleanup failed: ${msg}`)
		return `failed: ${msg}`
	}
}

const defaultDeps: StaleHookDeps = {
	// Matched in SQL and only owner_user_id is selected: repo_url can carry
	// credentials, so its raw text never reaches app code (secret-raw-reads guard).
	async managedRepoOwner(owner, repo) {
		const re = githubRepoUrlRegex(owner, repo)
		const [app] = await db
			.select({ ownerUserId: appRepos.ownerUserId })
			.from(appRepos)
			.where(sql`repo_url ~* ${re}`)
			.limit(1)
		if (app) return app
		const [group] = await db
			.select({ ownerUserId: repoDeploymentGroups.ownerUserId })
			.from(repoDeploymentGroups)
			.where(sql`repo_url ~* ${re}`)
			.limit(1)
		return group ?? null
	},
	async tokenKnown(token) {
		return !!(await getRepoByToken(token)) || !!(await getGroupByToken(token))
	},
	async githubToken(preferUserId) {
		return (await getAdminGithubIntegration(preferUserId))?.token ?? null
	},
	getHook: getWebhook,
	deleteHook: deleteWebhook,
	ownOrigins() {
		const out = new Set<string>()
		const base = webhookBaseUrlOrNull()
		if (base) out.add(base)
		const dash = dashboardUrlOrNull()
		if (dash) out.add(dash)
		for (const h of siteHosts()) out.add(`https://${h}`)
		return [...out]
	},
	now: () => Date.now(),
	log: (line) => console.log(line),
}
