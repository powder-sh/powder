import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { isAdminUserId } from './admin-ids'
import { auth } from './auth'
import { and, type AppRepo, appRepos, db, eq, isNull, previewDeploys, user as userTable, userApiTokens } from './db'
import { isPowderSelfContainer, powderSelfContainerNames, powderSelfDenied } from './secret-mask'
import type { ServerConfig } from './servers'
import { sessionOnlyRule } from './session-only'
import { POWDER_REQUEST_HEADER, tokenAllows } from './token-scopes'

export interface CurrentUser {
	id: string
	email: string
	name: string
	isAdmin: boolean
	// Set only when the request authenticated with a bearer API token.
	viaToken?: boolean
	tokenId?: string
	// The token's scopes (null = full access). Meaningful only when viaToken.
	tokenScopes?: string[] | null
}

// API tokens are stored as their sha256; a bearer is looked up by that hash.
function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

async function userFromBearer(token: string, request: string | null): Promise<CurrentUser | null> {
	if (!token) return null
	const hash = hashToken(token)
	const [row] = await db
		.select({
			tokenId: userApiTokens.id,
			userId: userApiTokens.userId,
			email: userTable.email,
			name: userTable.name,
			scopes: userApiTokens.scopes,
			expiresAt: userApiTokens.expiresAt,
		})
		.from(userApiTokens)
		.innerJoin(userTable, eq(userApiTokens.userId, userTable.id))
		.where(and(eq(userApiTokens.hash, hash), isNull(userApiTokens.revokedAt)))
		.limit(1)
	if (!row) return null
	if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
	// a session-only route (lib/session-only.ts) is never a token's, whatever its
	// scopes (the proxy refuses it first; this holds when the proxy did not run).
	if (bearerSessionOnly(request)) return null
	// Scoped token outside its routes → treated as unauthenticated (401).
	if (!tokenAllows(row.scopes ?? null, request)) return null
	// fire-and-forget last_used_at update
	void db
		.update(userApiTokens)
		.set({ lastUsedAt: new Date() })
		.where(eq(userApiTokens.id, row.tokenId))
		.catch(() => {})
	return {
		id: row.userId,
		email: row.email,
		name: row.name,
		isAdmin: isAdminUserId(row.userId),
		viaToken: true,
		tokenId: row.tokenId,
		tokenScopes: row.scopes ?? null,
	}
}

/** true when the stamped "METHOD /path" is a path rule of the session-only
 *  registry. No stamp (the proxy did not run) counts as session-only: a scoped token is
 *  refused there by tokenAllows already, a full-access token now too (fail closed). */
export function bearerSessionOnly(request: string | null): boolean {
	if (!request) return true
	const sp = request.indexOf(' ')
	if (sp < 0) return true
	return sessionOnlyRule(request.slice(0, sp), request.slice(sp + 1)) !== null
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
	const hdrs = await headers()
	const authHeader = hdrs.get('authorization') ?? hdrs.get('Authorization')
	if (authHeader?.startsWith('Bearer ')) {
		const token = authHeader.slice(7).trim()
		const u = await userFromBearer(token, hdrs.get(POWDER_REQUEST_HEADER))
		if (u) return u
		// Bearer token present but invalid — don't fall back to session
		return null
	}
	const session = await auth.api.getSession({ headers: hdrs })
	if (!session) return null
	return {
		id: session.user.id,
		email: session.user.email,
		name: session.user.name,
		isAdmin: isAdminUserId(session.user.id),
	}
}

// Single-tenant: powder is the operator's own tool. Only admin ids may use it;
// sign-in itself still works so an admin can log in. Always on
// (POWDER_SINGLE_TENANT is ignored, see startup-checks.ts).
export function singleTenantBlocks(userId: string): Response | null {
	if (!isAdminUserId(userId)) {
		return Response.json({ error: 'single_tenant' }, { status: 403 })
	}
	return null
}

// 401-style: returns user or a Response to bail with.
export async function requireUser(): Promise<CurrentUser | Response> {
	const u = await getCurrentUser()
	if (!u) return Response.json({ error: 'unauthorized' }, { status: 401 })
	const blocked = singleTenantBlocks(u.id)
	if (blocked) return blocked
	return u
}

/** the ONE access check of every /api/projects/[id] route: a user (requireUser),
 *  the app_repos row (404), and never powder's own container (powderSelfDenied, the same
 *  404 as an unknown app). `selfRead` routes (reads that hold no secret value, and
 *  the backup list / run) serve powder's own row to an admin browser session; writes,
 *  env values and every token call keep the 404. */
export async function requireProjectAccess(
	id: string,
	opts: { selfRead?: boolean } = {},
): Promise<{ user: CurrentUser; repo: AppRepo } | Response> {
	const u = await requireUser()
	if (u instanceof Response) return u
	const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, id)).limit(1)
	if (!repo) return Response.json({ error: 'not found' }, { status: 404 })
	const self = powderSelfDenied(repo.containerName)
	if (self && !(opts.selfRead === true && u.isAdmin === true && u.viaToken !== true)) return self
	return { user: u, repo }
}

// 404 if the server is missing.
export async function requireServerForUser(serverId: string): Promise<ServerConfig | Response> {
	const { getServer } = await import('./servers')
	const s = await getServer(serverId)
	if (!s) return Response.json({ error: 'unknown server' }, { status: 404 })
	return s
}

// ── List visibility: the ONE authority for powder's own app row in lists ─────
// Every route that lists apps, or builds an ownership set of apps for a deploy
// / log / env / database listing, takes its set from visibleRepos (or filters
// rows with excludeSelf). Powder's own container (isPowderSelfContainer) is
// never in it for an API token. `self: 'admin-session'` lets an admin browser
// session see it where the single-app read serves it too (requireProjectAccess
// selfRead: project list, deploy history, domains); 'never' is for anything that
// can reveal env values or connection strings (env-vars, databases) or whose
// single-app routes refuse self (crons). Guard test: visible-repos-guard.test.ts.
export type SelfVisibility = 'never' | 'admin-session'

function seesSelf(caller: Pick<CurrentUser, 'isAdmin' | 'viaToken'>, self: SelfVisibility): boolean {
	return self === 'admin-session' && caller.isAdmin === true && caller.viaToken !== true
}

/** `rows` without powder's own containers unless this caller may see them. */
export function excludeSelf<T>(
	rows: T[],
	caller: Pick<CurrentUser, 'isAdmin' | 'viaToken'>,
	self: SelfVisibility,
	nameOf: (row: T) => string = (row) => (row as { containerName: string }).containerName,
): T[] {
	if (seesSelf(caller, self)) return rows
	return rows.filter((r) => !isPowderSelfContainer(nameOf(r)))
}

/** The container names a SQL listing must leave out for this caller (`NOT IN`), or []. */
export function hiddenSelfNames(
	caller: Pick<CurrentUser, 'isAdmin' | 'viaToken'>,
	self: SelfVisibility,
): string[] {
	return seesSelf(caller, self) ? [] : powderSelfContainerNames()
}

/** Every app row this caller may see in a list (see above). */
export async function visibleRepos(
	caller: Pick<CurrentUser, 'isAdmin' | 'viaToken'>,
	self: SelfVisibility,
): Promise<AppRepo[]> {
	return excludeSelf(await db.select().from(appRepos), caller, self)
}

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

export function isSafeContainerName(name: string): boolean {
	return CONTAINER_NAME_RE.test(name) && !name.includes('..')
}

export async function isManagedContainer(serverId: string, containerName: string): Promise<boolean> {
	const [app] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	if (app) return true
	const [preview] = await db
		.select({ id: previewDeploys.id })
		.from(previewDeploys)
		.innerJoin(appRepos, eq(previewDeploys.appRepoId, appRepos.id))
		.where(and(eq(previewDeploys.containerName, containerName), eq(appRepos.serverId, serverId)))
		.limit(1)
	return !!preview
}

// One-shot helper for per-container API routes: validates session + server +
// managed container in one call. Returns { user, server } or a Response to bail.
// the ONE authority that refuses powder's own containers (isPowderSelfContainer:
// selfDeployNames / POWDER_SELF_CONTAINER, its -worker, the stock powder / powder-worker)
// for every container route (restart, logs, env, crons, git-deploy, apply, domains,
// previews, snapshots, repo connect / import / DELETE, ...), allowUnmanaged or not. Same
// 404 as an unknown container.
export async function requireContainerAccess(
	serverId: string,
	containerName: string,
	// The "connect a repo" flow acts on a container that has no app_repos row yet.
	opts: { allowUnmanaged?: boolean } = {},
): Promise<{ user: CurrentUser; server: ServerConfig } | Response> {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	// `[name]` ends up in file paths and shell commands.
	if (!isSafeContainerName(containerName)) {
		return Response.json({ error: 'invalid container name' }, { status: 400 })
	}
	const self = powderSelfDenied(containerName)
	if (self) return self
	const serverCheck = await requireServerForUser(serverId)
	if (serverCheck instanceof Response) return serverCheck
	// only containers powder manages (an app or a preview of one).
	if (!opts.allowUnmanaged && !(await isManagedContainer(serverId, containerName))) {
		return Response.json({ error: 'unknown container' }, { status: 404 })
	}
	return { user: userOrResp, server: serverCheck }
}
