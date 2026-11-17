// ONE registry of the admin actions no bearer token reaches, whatever its scopes
// (a scoped token, a full-access token, an MCP token). Closing such a route one at
// a time left side routes a token could still reach, so the rule is central:
//
//   - SESSION_ONLY: route + method patterns (`*` one path segment, a trailing `**` the
//     rest, as token scopes), optionally only with a query flag (`?reveal=1`). The proxy
//     (src/proxy.ts) answers 403 to any request with an `Authorization: Bearer` header
//     that matches one, before any handler runs; access.ts refuses the token again for
//     the path rules (getCurrentUser, from the method + path the proxy stamps).
//   - SESSION_ONLY_ACTIONS: actions a route decides from the request body or the stored
//     row (an exec cron, an http cron with a non-default bearer env var). The route asks
//     sessionOnlyActionDenied, which needs an admin BROWSER session.
//   - TOKEN_ROUTES: every other route + method, listed explicitly. The guard test
//     (session-only.test.ts) enumerates every route file under app/api and fails when
//     a route + method is in neither list, so a new admin route cannot ship token-open by
//     accident.
//
// Edge-safe: no imports beyond token-scopes (pure), so the proxy can use it.

import { routePatternMatches } from './token-scopes'

export interface SessionOnlyRule {
	/** "METHOD /api/pattern" */
	route: string
	/** only when this query parameter is `1` (the reveal toggles) */
	query?: string
	why: string
}

export const SESSION_ONLY: readonly SessionOnlyRule[] = [
	// repo connect / disconnect / import (adopt a running container) / clone
	{ route: 'GET /api/servers/*/containers/*/repo', why: 'repo connect' },
	{ route: 'POST /api/servers/*/containers/*/repo', why: 'repo connect' },
	{ route: 'DELETE /api/servers/*/containers/*/repo', why: 'repo disconnect' },
	{ route: 'POST /api/servers/*/containers/*/repo/import', why: 'repo import (adopt)' },
	{ route: 'POST /api/servers/*/containers/*/repo/clone', why: 'repo clone' },
	// domains: add, apply, verify, delete, status
	{ route: 'POST /api/projects/*/domains', why: 'domain add' },
	{ route: 'DELETE /api/projects/*/domains', why: 'domain delete' },
	{ route: 'POST /api/projects/*/domains/*/apply', why: 'domain apply' },
	{ route: 'POST /api/projects/*/domains/*/verify', why: 'domain verify' },
	{ route: 'POST /api/servers/*/containers/*/domains', why: 'domain add' },
	{ route: 'POST /api/servers/*/containers/*/domains/*', why: 'domain apply' },
	{ route: 'DELETE /api/servers/*/containers/*/domains/*', why: 'domain delete' },
	{ route: 'PATCH /api/domains/*/*/*', why: 'domain status' },
	// secret reveal
	{ route: 'GET /api/env-vars', query: 'reveal', why: 'env reveal' },
	{ route: 'GET /api/databases', query: 'reveal', why: 'database URL reveal' },
	{
		route: 'GET /api/servers/*/containers/*/inspect',
		query: 'reveal',
		why: 'container env reveal',
	},
	{ route: 'GET /api/servers/*/containers/*/env-file', query: 'reveal', why: 'env file reveal' },
	// backups: download, restore, verify, drop
	{ route: 'POST /api/projects/*/backups/*', why: 'backup download / restore' },
	{ route: 'POST /api/projects/*/backups/restores/*', why: 'restore database drop' },
	// app create (a new app, repo and deploy key)
	{ route: 'POST /api/apps', why: 'app create' },
	// tokens, users, setup
	{ route: 'GET /api/tokens', why: 'token list' },
	{ route: 'POST /api/tokens', why: 'token mint' },
	{ route: 'DELETE /api/tokens', why: 'token revoke' },
	{ route: 'POST /api/setup/token', why: 'setup token' },
	{ route: 'GET /api/admin/users', why: 'users' },
	{ route: 'POST /api/admin/users', why: 'users' },
	{ route: 'DELETE /api/admin/users/*', why: 'user remove' },
	// settings
	{ route: 'PATCH /api/projects/*', why: 'app settings' },
	{ route: 'POST /api/setup/checklist', why: 'setup checklist' },
	{ route: 'POST /api/notification-targets', why: 'notification target add' },
	{ route: 'DELETE /api/notification-targets', why: 'notification target delete' },
	{ route: 'POST /api/notification-targets/test', why: 'notification target test' },
	{ route: 'POST /api/integrations/github', why: 'GitHub integration' },
	// commits a Dockerfile to the app's repo with powder's GitHub integration
	{ route: 'POST /api/integrations/github/repos/*/*/dockerfile', why: 'Dockerfile commit' },
	{ route: 'DELETE /api/integrations/github', why: 'GitHub integration' },
	// servers: add, edit, remove, bootstrap
	{ route: 'POST /api/servers', why: 'server add' },
	{ route: 'PATCH /api/servers/*', why: 'server edit' },
	{ route: 'DELETE /api/servers/*', why: 'server remove' },
	{ route: 'POST /api/servers/*/bootstrap', why: 'server bootstrap' },
	// mints a new per-app cron token and reveals it once
	{ route: 'POST /api/servers/*/containers/*/crons/token/rotate', why: 'cron token rotate' },
	// previews (enabling previews is a DB update only: no route exists)
	{ route: 'DELETE /api/servers/*/containers/*/previews/*', why: 'preview delete' },
	// stops and removes the app's containers, then its rows (lib/app-lifecycle.ts)
	{ route: 'DELETE /api/servers/*/containers/*', why: 'app delete' },
]

/** Every route + method a bearer token may reach (its scopes still decide). The guard test
 *  needs each route file's methods in SESSION_ONLY or here. */
export const TOKEN_ROUTES: readonly string[] = [
	'GET /api/auth/**',
	'POST /api/auth/**',
	'GET /api/cmd/search',
	'POST /api/crons/logs',
	'GET /api/crons',
	'GET /api/databases',
	'GET /api/deploys-list',
	'GET /api/deploys/*',
	'GET /api/deploys/*/stream',
	'GET /api/domains',
	'GET /api/env-vars',
	'GET /api/health',
	'GET /api/sign-in-link',
	'GET /api/integrations/github/repos/*/*/detect',
	'GET /api/integrations/github/repos',
	'GET /api/integrations/github',
	'GET /api/internal/apps',
	'GET /api/internal/auto-rollback',
	'POST /api/internal/backups/prune',
	'GET /api/internal/backups',
	'GET /api/internal/deploys',
	'GET /api/logs/search',
	'POST /api/mcp',
	'GET /api/mcp',
	'DELETE /api/mcp',
	'GET /api/notification-targets',
	'GET /api/projects/*/backups/restores/*',
	'GET /api/projects/*/backups',
	'POST /api/projects/*/backups',
	'POST /api/projects/*/ci/*/diagnose',
	'GET /api/projects/*/ci',
	'GET /api/projects/*/context',
	'GET /api/projects/*/domains',
	'GET /api/projects/*/env/*/history',
	'POST /api/projects/*/env/*/rollback',
	'DELETE /api/projects/*/env/*',
	'GET /api/projects/*/env/audit',
	'POST /api/projects/*/env/backfill',
	'GET /api/projects/*/env',
	'PUT /api/projects/*/env',
	'POST /api/projects/*/env',
	'POST /api/projects/*/redeploy',
	'GET /api/projects/*',
	'GET /api/projects',
	'GET /api/repos',
	'POST /api/servers/*/containers/*/apply',
	'DELETE /api/servers/*/containers/*/crons/*',
	'PATCH /api/servers/*/containers/*/crons/*',
	'POST /api/servers/*/containers/*/crons/*/run',
	'POST /api/servers/*/containers/*/crons/import',
	'GET /api/servers/*/containers/*/crons',
	'POST /api/servers/*/containers/*/crons',
	'POST /api/servers/*/containers/*/deploys/*/snapshot',
	'GET /api/servers/*/containers/*/deploys',
	'GET /api/servers/*/containers/*/domains',
	'GET /api/servers/*/containers/*/env-file',
	'PUT /api/servers/*/containers/*/env-file',
	'POST /api/servers/*/containers/*/git-deploy',
	'GET /api/servers/*/containers/*/git-status',
	'GET /api/servers/*/containers/*/inspect',
	'GET /api/servers/*/containers/*/logs',
	'GET /api/servers/*/containers/*/logs/stream',
	'GET /api/servers/*/containers/*/previews',
	'POST /api/servers/*/containers/*/restart',
	'POST /api/servers/*/containers/*/stop',
	'POST /api/servers/*/containers/*/rollback',
	'GET /api/servers/*/containers/*/traffic',
	'POST /api/servers/*/dns-check',
	'GET /api/servers/*',
	'GET /api/servers/*/stats',
	'GET /api/servers/list',
	'GET /api/servers',
	'GET /api/servers/ssh-key',
	'POST /api/servers/sync',
	'GET /api/setup/checklist',
	'POST /api/webhooks/deploy/*',
]

/** Body- or row-dependent admin actions (the route checks them, sessionOnlyActionDenied). */
const SESSION_ONLY_ACTIONS = {
	/** an exec cron runs a command of the caller's choice inside the app container:
	 *  create, edit into or as one, import as one, resume, run now */
	exec_cron: 'exec crons need an admin browser session (API tokens may manage http crons only)',
	/** an http cron's bearer is read from the named app env var and sent to the
	 *  cron URL: tokens may only use the default per-app cron token (create, edit, import,
	 *  resume and run now of a cron that names another) */
	cron_bearer_env:
		'an http cron that sends an app env var as its bearer needs an admin browser session (API tokens may use the default per-app cron token only: leave the bearer env var empty)',
	/** DELETE /api/servers/[id]/containers/[name]: also on the path list above; the route
	 *  checks it again, so a request that skipped the proxy is still refused */
	app_delete: 'deleting an app needs an admin browser session (API tokens cannot reach it)',
	/** POST /api/internal/backups/prune with dryRun:false deletes backups. A token
	 *  may preview (dry run); the delete needs a browser session unless the operator sets
	 *  POWDER_TOKEN_BACKUP_PRUNE=1 (an ops hub that prunes on a schedule). */
	backup_prune:
		'deleting backups (prune with dryRun:false) needs an admin browser session (API tokens may run the dry run only; operator flag POWDER_TOKEN_BACKUP_PRUNE=1)',
	/** PATCH /api/projects/[id] with hasPostgres or a backup_db_* field: which
	 *  database backups dump, restore into and download from */
	backup_db:
		'choosing the database an app backs up needs an admin browser session (API tokens cannot change it)',
} as const

export type SessionOnlyAction = keyof typeof SESSION_ONLY_ACTIONS

/** True when an http cron sends the default bearer: no env var named (unset or blank),
 *  exactly when lib/cron-scheduler.ts resolveBearer uses the per-app cron token.
 *  A cron that NAMES POWDER_CRON_TOKEN reads that app env var (resolveBearer), so it is
 *  not the default either. */
export function cronBearerIsDefault(bearerEnvVar: string | null | undefined): boolean {
	return !(bearerEnvVar ?? '').trim()
}

/** The session-only actions a cron (stored or requested) involves. */
function cronSessionOnlyActions(job: {
	kind?: string | null
	bearerEnvVar?: string | null
}): SessionOnlyAction[] {
	const out: SessionOnlyAction[] = []
	if (job.kind === 'exec') out.push('exec_cron')
	if (job.kind !== 'exec' && !cronBearerIsDefault(job.bearerEnvVar)) out.push('cron_bearer_env')
	return out
}

/** 403 when the action needs an admin browser session and the caller is not one. */
export function sessionOnlyActionDenied(
	action: SessionOnlyAction,
	user: { isAdmin: boolean; viaToken?: boolean },
): Response | null {
	if (user.isAdmin === true && user.viaToken !== true) return null
	return Response.json(
		{ error: SESSION_ONLY_ACTIONS[action], code: 'session_only' },
		{ status: 403 },
	)
}

/** The first refusal among a cron's session-only actions, or null. */
export function cronSessionOnlyDenied(
	job: { kind?: string | null; bearerEnvVar?: string | null },
	user: { isAdmin: boolean; viaToken?: boolean },
): Response | null {
	for (const a of cronSessionOnlyActions(job)) {
		const d = sessionOnlyActionDenied(a, user)
		if (d) return d
	}
	return null
}

/** The SESSION_ONLY rule a request matches, or null. `query`: the request's search
 *  params (rules with a query flag match only when that flag is `1`; without params
 *  those rules never match, so the path-only layer in access.ts skips them). */
export function sessionOnlyRule(
	method: string,
	path: string,
	query?: URLSearchParams | null,
): SessionOnlyRule | null {
	for (const r of SESSION_ONLY) {
		if (!routePatternMatches(r.route, method, path)) continue
		if (r.query && query?.get(r.query) !== '1') continue
		return r
	}
	return null
}

/** True when a request carries a bearer token (the proxy's view). */
export function hasBearer(authorization: string | null | undefined): boolean {
	return /^\s*bearer\s/i.test(authorization ?? '')
}

/** The 403 the proxy answers. */
export function sessionOnlyResponse(rule: SessionOnlyRule): Response {
	return Response.json(
		{
			error: `${rule.why} needs an admin browser session; API tokens cannot reach it (whatever their scopes)`,
			code: 'session_only',
		},
		{ status: 403 },
	)
}
