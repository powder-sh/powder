// One authority for "what hostname does an app get by default on this server".
// Reads servers.base_domain (migration 0041); no hardcoded default domain.
// Pure module (no db imports) so every caller and test can use it.
import { createHash } from 'node:crypto'

export interface HostServer {
	id: string
	baseDomain?: string | null
}

/** One authority for "this app_domains row is in the app's routing": live and
 *  attached to the app itself, not to a preview. */
export function isRoutedDomain(d: { status: string; previewDeployId: string | null }): boolean {
	return d.status === 'live' && d.previewDeployId === null
}

export const NO_BASE_DOMAIN_MESSAGE = 'no base domain set on this server, add a custom domain'

// One authority for "is this a plain DNS hostname" (app-domains.ts imports it).
export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** The one hostname validator for anything that reaches a Traefik `Host()`
 *  rule, nginx config or DNS lookup: HOST_RE (letters, digits, hyphens, at
 *  least two labels; no backtick, $, (), &, quotes, ;) plus the DNS lengths. */
export function isValidHostname(s: string): boolean {
	return (
		typeof s === 'string' &&
		s.length <= 253 &&
		HOST_RE.test(s) &&
		s.split('.').every((l) => l.length <= 63)
	)
}

/** the raw compose guard (COMPOSE_RAW_AWK, deploy/fragments.ts) refuses the words
 *  `include` and `extends` ANYWHERE in a compose file, powder's own override included,
 *  so a hostname, base domain or health path holding one would make every deploy of the
 *  app refuse. Such values are refused when saved and kept out of compose labels. */
export const COMPOSE_FORBIDDEN_WORD_RE = /extends|include/i

/** Why a value may not go into powder's compose labels, or null. */
export function composeWordProblem(value: string, what: string): string | null {
	return COMPOSE_FORBIDDEN_WORD_RE.test(value)
		? `${what} "${value.slice(0, 120)}" contains "include" or "extends"; powder's compose guard refuses those words anywhere in a compose file, so it cannot be used in the app's routing labels`
		: null
}

/** Column value, validated. Null = no base domain. */
export function resolveBaseDomain(
	serverId: string,
	column: string | null | undefined,
): string | null {
	const v = column
		?.trim()
		.toLowerCase()
		.replace(/^\*?\.+/, '')
	if (!v) return null
	// base_domain ends up inside shell commands and Traefik rules: only a
	// plain hostname is accepted, anything else counts as unset.
	if (HOST_RE.test(v) && !COMPOSE_FORBIDDEN_WORD_RE.test(v)) return v
	console.warn(`[app-hosts] ignoring invalid servers.base_domain for ${serverId}`)
	return null
}

/** `<label>.<base_domain>` or null when the server has no base domain. */
export function hostForLabel(server: HostServer, label: string): string | null {
	const base = resolveBaseDomain(server.id, server.baseDomain)
	return base ? `${label}.${base}` : null
}

/** Default host for an app: `<appName>.<base_domain>`, or null. */
export function defaultHostFor(server: HostServer, appName: string): string | null {
	return hostForLabel(server, appName)
}

/**
 * The live custom domain an app is reached at by uptime checks and http crons:
 * the oldest live row (ties: hostname order), one per app. Deterministic, so
 * both callers hit the same host (apex vs www can differ by a redirect). Pure.
 */
export function firstLiveHostByRepo(
	rows: { appRepoId: string; hostname: string; createdAt: Date }[],
): Map<string, string> {
	const sorted = [...rows].sort(
		(a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.hostname.localeCompare(b.hostname),
	)
	const out = new Map<string, string>()
	for (const r of sorted) if (!out.has(r.appRepoId)) out.set(r.appRepoId, r.hostname)
	return out
}

/**
 * Traefik retry middleware on every router powder renders (`<name>-retry`, last in the
 * router's middleware chain so it wraps only the call to the service). Traefik re-sends
 * a request only while it has not reached a backend: the middleware turns retries off
 * as soon as the request headers are written to the backend connection (httptrace
 * WroteHeaders / WroteRequest, traefik v3 pkg/middlewares/retry). So it retries a
 * refused connection, no route to host and a dial timeout, and never re-sends a
 * request, a POST included, that a backend may have received: a reset or a timeout
 * after the request was written still answers 502. In a deploy swap that covers the
 * old container's refused port and vanished IP while the docker provider still lists
 * it: those failures all happen before the request is written.
 * Each attempt goes through the load balancer again, so it lands on the bridge or the
 * new container. Backoff starts at 100 ms and stays under 200 ms.
 */
export const TRAEFIK_RETRY_ATTEMPTS = 10

export function traefikRetryLabels(name: string): { middleware: string; labels: string[] } {
	const middleware = `${name}-retry`
	return {
		middleware,
		labels: [
			`traefik.http.middlewares.${middleware}.retry.attempts=${TRAEFIK_RETRY_ATTEMPTS}`,
			`traefik.http.middlewares.${middleware}.retry.initialinterval=100ms`,
		],
	}
}

/**
 * Path Traefik's service health check should probe: the path of the app's
 * health_url (scheme, host and query dropped), else '/'. Must start with '/'.
 */
export function healthPathFor(healthUrl: string | null | undefined): string {
	const raw = healthUrl?.trim()
	if (!raw) return '/'
	let path: string
	if (raw.startsWith('/')) path = raw
	else {
		try {
			const u = new URL(raw)
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return '/'
			path = u.pathname
		} catch {
			return '/'
		}
	}
	path = path.split(/[?#]/)[0] ?? '/'
	if (!path.startsWith('/') || path.startsWith('//') || /[\s`'"\\$]/.test(path)) return '/'
	// a path with include/extends would make the compose guard refuse the override.
	if (COMPOSE_FORBIDDEN_WORD_RE.test(path)) return '/'
	return path
}

/** Pre-hash slug (kept to find preview rows created before slugs were hashed). */
export function readableBranchSlug(branch: string): string {
	return branch
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24)
}

/** `<readable slug>-<6 hex of sha1(branch)>`, so `feat/x` and `feat-x` (which
 *  slugify identically) get different previews instead of sharing one container. */
export function branchSlug(branch: string): string {
	const h = createHash('sha1').update(branch).digest('hex').slice(0, 6)
	return `${readableBranchSlug(branch) || 'b'}-${h}`
}

const MAX_NAME_LEN = 50

// Previews live in their own `pv-` namespace so `<parent>-<slug>` can
// never land on another tenant's app name. Over-long names are truncated with
// a hash suffix so two long names cannot truncate to the same string.
export function previewContainerName(parentContainer: string, slug: string): string {
	const merged = `pv-${parentContainer}-${slug}`
	if (merged.length <= MAX_NAME_LEN) return merged
	const h = createHash('sha1').update(merged).digest('hex').slice(0, 6)
	return `${merged.slice(0, MAX_NAME_LEN - 7).replace(/-+$/, '')}-${h}`
}

/** Host for a NEW preview of `branch`: `<pv-name>.<base_domain>`, or null. */
export function previewHostFor(server: HostServer, appName: string, branch: string): string | null {
	return hostForLabel(server, previewContainerName(appName, branchSlug(branch)))
}
