// API-token scopes. A scope is "METHOD /path/pattern": `*` matches one path
// segment, a trailing `**` matches the rest (one or more segments). A token
// with scopes = NULL is a full-access token; any non-null list, even
// empty, restricts it to exactly those routes. Checked in access.ts against
// the method+path the proxy stamps onto the request (src/proxy.ts).
//
// Scopes are per ROUTE, not per action: the stamp carries no query string, so a
// scope for a path covers every `?action=` branch of that handler. Rule for
// route authors: one privileged action per METHOD + path. A second action gets
// its own path (POST /api/servers/sync, not POST /api/servers?action=sync); a
// query switch is only fine when every branch is the same privilege (e.g.
// POST /api/setup/checklist?action=run, its only POST action).

export const POWDER_REQUEST_HEADER = 'x-powder-request'

const SCOPE_RE = /^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9_\-/*.]*$/

export function isValidScope(scope: string): boolean {
	return SCOPE_RE.test(scope)
}

function segments(path: string): string[] {
	return path.split('/').filter(Boolean)
}

// A token may only mint tokens that are no broader than itself. A null
// caller (full access, or a session) may request anything; a scoped caller may
// only request scopes it already holds verbatim, and never a full-access token.
export function scopesWithinCaller(
	requested: string[] | null,
	callerScopes: string[] | null,
): boolean {
	if (callerScopes === null) return true
	if (requested === null) return false
	return requested.every((s) => callerScopes.includes(s))
}

function scopeMatches(scope: string, method: string, path: string): boolean {
	const sp = scope.indexOf(' ')
	if (sp < 0) return false
	const sMethod = scope.slice(0, sp)
	// Next answers HEAD with the GET handler, so HEAD is GET for every rule (token
	// scopes and the session-only registry): `HEAD /api/tokens` is `GET /api/tokens`.
	const m = method.toUpperCase()
	if (sMethod !== (m === 'HEAD' ? 'GET' : m)) return false
	const pat = segments(scope.slice(sp + 1))
	const got = segments(path)
	for (const [i, p] of pat.entries()) {
		if (p === '**') return i === pat.length - 1 && got.length > i
		if (i >= got.length) return false
		if (p !== '*' && p !== got[i]) return false
	}
	return pat.length === got.length
}

/** a "METHOD /pattern" route pattern (scope syntax) against a request. Each path
 *  segment is percent-decoded first (an undecodable one stays as written), so
 *  `/api/%74okens` is `/api/tokens` here: the session-only registry (session-only.ts)
 *  must not be skipped by an encoding the router undoes. */
export function routePatternMatches(pattern: string, method: string, path: string): boolean {
	const decoded = path
		.split('/')
		.map((s) => {
			try {
				return decodeURIComponent(s)
			} catch {
				return s
			}
		})
		.join('/')
	return scopeMatches(pattern, method, decoded)
}

// `request` is "METHOD /path" as stamped by the proxy, or null when the proxy
// didn't run (then a scoped token is refused — fail closed).
export function tokenAllows(scopes: string[] | null, request: string | null): boolean {
	if (scopes === null) return true
	if (!request) return false
	const sp = request.indexOf(' ')
	if (sp < 0) return false
	const method = request.slice(0, sp)
	const path = request.slice(sp + 1)
	return scopes.some((s) => scopeMatches(s, method, path))
}

// MCP (/api/mcp). The endpoint itself needs `POST /api/mcp`; each tool then
// needs the scope of the REST route it runs (lib/mcp/tools.ts), so a token can
// do exactly what it could do over REST. These presets are what the tokens
// page offers for coding agents. Patterns, not ids, so they cover every app.
export const MCP_READ_SCOPES: readonly string[] = [
	'POST /api/mcp',
	'GET /api/projects',
	'GET /api/projects/*/context',
	'GET /api/projects/*/domains',
	'GET /api/servers/*/containers/*/deploys',
	'GET /api/deploys/*',
	'GET /api/projects/*/env',
	'GET /api/servers/list',
]

export const MCP_WRITE_SCOPES: readonly string[] = [
	...MCP_READ_SCOPES,
	'POST /api/projects/*/redeploy',
	'PUT /api/projects/*/env',
	'DELETE /api/projects/*/env/*',
]

// write access for chosen apps only. Read covers every app (the
// MCP read preset); each app adds its own env PUT and redeploy POST, so a leak
// of this token can only change and redeploy those apps.
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function mcpWriteScopesForApps(appIds: readonly string[]): string[] {
	const ids = [...new Set(appIds)].filter((id) => APP_ID_RE.test(id))
	return [
		...MCP_READ_SCOPES,
		...ids.flatMap((id) => [`PUT /api/projects/${id}/env`, `POST /api/projects/${id}/redeploy`]),
	]
}
