import {
	account,
	and,
	createId,
	db,
	eq,
	prefixes,
	userIntegrations,
} from './db'
import type { UserIntegration } from './db'
import { adminTokenCandidates } from './admin-ids'
import { decryptSecret, encryptSecret } from './crypto'
import { getTokenScopes, getViewer } from './github'
import { readOAuthAccessToken } from './oauth-token'

// Reads the GitHub access token for a user. Prefers OAuth (better-auth's `account` table),
// falls back to PAT (user_integrations) if any user connected before OAuth was enabled.
export async function getGithubIntegration(
	userId: string,
): Promise<{ token: string; username: string | null; source: 'oauth' | 'pat' } | null> {
	const [acc] = await db
		.select()
		.from(account)
		.where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
		.limit(1)
	const oauthToken = await readOAuthAccessToken(acc?.accessToken)
	if (oauthToken) {
		return { token: oauthToken, username: null, source: 'oauth' }
	}

	const [row] = await db
		.select()
		.from(userIntegrations)
		.where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'github')))
		.limit(1)
	if (!row) return null
	return {
		token: decryptSecret(row.accessTokenEncrypted),
		username: row.username,
		source: 'pat',
	}
}

/** a GitHub token of a CURRENT admin for background calls on an
 *  app (deployment statuses, preview comments): the owner's when the owner is an
 *  admin, else the first admin that has one. Null when no admin has a token. */
export async function getAdminGithubIntegration(
	preferUserId: string | null | undefined,
): Promise<{ token: string; username: string | null; source: 'oauth' | 'pat' } | null> {
	for (const id of adminTokenCandidates(preferUserId)) {
		const i = await getGithubIntegration(id)
		if (i) return i
	}
	return null
}

/** Time limit of the validity check: the integrations page waits on it. */
const CHECK_TIMEOUT_MS = 5_000

/** Whether GitHub still accepts a token: `valid: true` (and the login) when /user
 *  answers, `false` when GitHub rejects it with 401 (revoked or expired), `null` when
 *  the check could not run (network error, timeout, rate limit, GitHub down): unknown. */
export async function checkGithubToken(
	token: string,
	viewer: (t: string) => Promise<{ login: string }> = (t) => getViewer(t, { timeoutMs: CHECK_TIMEOUT_MS }),
): Promise<{ valid: boolean | null; login: string | null }> {
	try {
		const v = await viewer(token)
		return { valid: true, login: v.login }
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return { valid: /^github 401\b/.test(msg) ? false : null, login: null }
	}
}

/** How long one validity result per user is reused: every render of the
 *  integrations page would otherwise call GitHub, and a slow GitHub would slow
 *  every render. Keyed on the token too, so a reconnect or new PAT is checked
 *  at once. In memory, per process. */
export const GITHUB_CHECK_TTL_MS = 60_000

const checkCache = new Map<string, { token: string; at: number; result: { valid: boolean | null; login: string | null } }>()

async function cachedGithubCheck(userId: string, token: string): Promise<{ valid: boolean | null; login: string | null }> {
	const now = Date.now()
	const hit = checkCache.get(userId)
	if (hit && hit.token === token && now - hit.at < GITHUB_CHECK_TTL_MS) return hit.result
	const result = await checkGithubToken(token)
	for (const [k, v] of checkCache) if (now - v.at >= GITHUB_CHECK_TTL_MS) checkCache.delete(k)
	checkCache.set(userId, { token, at: Date.now(), result })
	return result
}

/** Drops every cached validity result (tests). */
export function clearGithubCheckCache() {
	checkCache.clear()
}

export async function getGithubIntegrationDisplay(userId: string): Promise<{
	connected: boolean
	/** true: GitHub accepts the token; false: GitHub rejected it (401); null: unknown */
	valid?: boolean | null
	username?: string | null
	source?: 'oauth' | 'pat'
	scopes?: string[]
}> {
	const i = await getGithubIntegration(userId)
	if (!i) return { connected: false }
	const check = await cachedGithubCheck(userId, i.token)
	if (i.source === 'pat') {
		const [row] = await db
			.select()
			.from(userIntegrations)
			.where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'github')))
			.limit(1)
		return {
			connected: true,
			valid: check.valid,
			username: i.username,
			source: 'pat',
			scopes: row?.scopes ? row.scopes.split(',') : [],
		}
	}
	return { connected: true, valid: check.valid, username: check.login, source: 'oauth' }
}

export async function setGithubPat(userId: string, token: string): Promise<UserIntegration> {
	const viewer = await getViewer(token)
	const scopes = await getTokenScopes(token)
	const required = ['repo', 'admin:repo_hook']
	const missing = required.filter(
		(s) => !scopes.includes(s) && !scopes.includes(s.split(':')[0] ?? s),
	)
	if (missing.length) {
		throw new Error(`token is missing scopes: ${missing.join(', ')}. needs: repo, admin:repo_hook`)
	}
	const existing = await db
		.select()
		.from(userIntegrations)
		.where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'github')))
		.limit(1)
		.then((rows) => rows[0] ?? null)
	const data = {
		userId,
		provider: 'github' as const,
		username: viewer.login,
		accessTokenEncrypted: encryptSecret(token),
		scopes: scopes.join(','),
		updatedAt: new Date(),
	}
	if (existing) {
		const [row] = await db
			.update(userIntegrations)
			.set(data)
			.where(eq(userIntegrations.id, existing.id))
			.returning()
		if (!row) throw new Error('github integration write returned no row')
		return row
	}
	const [row] = await db
		.insert(userIntegrations)
		.values({ ...data, id: createId(prefixes.integration) })
		.returning()
	if (!row) throw new Error('github integration write returned no row')
	return row
}

export async function deleteGithubIntegration(userId: string): Promise<void> {
	const rows = await db
		.select()
		.from(userIntegrations)
		.where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'github')))
	for (const row of rows) {
		await db.delete(userIntegrations).where(eq(userIntegrations.id, row.id))
	}
}
