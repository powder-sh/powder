// Host split: the one authority for which hostname serves what.
//
// Default (POWDER_SITE_HOST unset): one host serves everything. No gating, no header reads.
//
// Split (POWDER_SITE_HOST set, e.g. "powder.sh,www.powder.sh"): those hosts
// serve only the public site (landing page, /docs, assets) plus the endpoints
// outside callers already use there (GitHub push webhooks, /api/health,
// /ingest). Every other path 404s on them (src/proxy.ts). The dashboard,
// login and its APIs live on the dashboard origin, which is BETTER_AUTH_URL
// (better-auth already needs it to be the dashboard origin for OAuth).
//
// Imported by proxy.ts: keep this file free of node-only and DB imports.

import { RECREATE_HINT } from './recreate-hint'
import { SITE_URL } from './site'

type Env = Record<string, string | undefined>

/** Lowercase, port stripped, trailing dots stripped. "POWDER.SH.:443" -> "powder.sh". */
function normalizeHost(raw: string | null | undefined): string | null {
	if (!raw) return null
	let h = raw.trim().toLowerCase()
	if (h.startsWith('[')) {
		const end = h.indexOf(']')
		if (end !== -1) h = h.slice(0, end + 1)
	} else {
		const colon = h.indexOf(':')
		if (colon !== -1) h = h.slice(0, colon)
	}
	h = h.replace(/\.+$/, '')
	return h || null
}

/** Public-site hosts from POWDER_SITE_HOST (comma separated). Empty = no split. */
export function siteHosts(env: Env = process.env): string[] {
	return (env.POWDER_SITE_HOST ?? '')
		.split(',')
		.map(normalizeHost)
		.filter((h): h is string => !!h)
}

export function isHostSplit(env: Env = process.env): boolean {
	return siteHosts(env).length > 0
}

/** Development default when BETTER_AUTH_URL is unset (`next dev` on its default port). */
export const DEV_DASHBOARD_URL = 'http://localhost:3000'

/** The BETTER_AUTH_URL origin when it is a valid http(s) URL, else null. */
export function authUrlOrigin(env: Env = process.env): string | null {
	const raw = env.BETTER_AUTH_URL?.trim()
	if (!raw) return null
	try {
		const u = new URL(raw)
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
		return u.origin
	} catch {
		return null
	}
}

/** Thrown when a dashboard or webhook URL is needed and BETTER_AUTH_URL is unusable. */
export class DashboardUrlMissingError extends Error {
	constructor() {
		super(
			`BETTER_AUTH_URL is not set to a valid http(s) URL: set it to the dashboard origin (e.g. https://deploy.example.com) in powder.env, then ${RECREATE_HINT}`,
		)
		this.name = 'DashboardUrlMissingError'
	}
}

/** Dashboard origin (no trailing slash) for links built outside a request, or null
 *  when it is not configured. Outside production an unset value means the local
 *  dev server. Never the project's own site: these links carry tokens and deploy
 *  data, so a missing setting must not send them to a host the install does not own. */
export function dashboardUrlOrNull(env: Env = process.env): string | null {
	const origin = authUrlOrigin(env)
	if (origin) return origin
	if (env.NODE_ENV !== 'production' && !env.BETTER_AUTH_URL?.trim()) return DEV_DASHBOARD_URL
	return null
}

/** Dashboard origin (no trailing slash); throws DashboardUrlMissingError when it
 *  is not configured. Production refuses to boot without it (lib/startup-checks.ts). */
export function dashboardUrl(env: Env = process.env): string {
	const url = dashboardUrlOrNull(env)
	if (!url) throw new DashboardUrlMissingError()
	return url
}

/** This install's public site URL (no trailing slash) for metadataBase and the
 *  sitemap: the first POWDER_SITE_HOST when split, else the dashboard origin
 *  (BETTER_AUTH_URL). Static docs rendered by a build without either get the
 *  project's SITE_URL as their canonical base: those pages are the project's docs,
 *  and no token or deploy data is ever built from this value. */
export function siteUrl(env: Env = process.env): string {
	const site = siteHosts(env)[0]
	if (site) return `https://${site}`
	return authUrlOrigin(env) ?? SITE_URL
}

/** Every host a request claims: Host plus each X-Forwarded-Host entry. */
function requestHosts(headers: Headers): string[] {
	const out: string[] = []
	const host = normalizeHost(headers.get('host'))
	if (host) out.push(host)
	for (const part of (headers.get('x-forwarded-host') ?? '').split(',')) {
		const h = normalizeHost(part)
		if (h) out.push(h)
	}
	return out
}

/**
 * True when the request is for a public-site host. Fail-safe: if ANY of the
 * claimed hosts (Host or any X-Forwarded-Host entry) is a site host, the
 * request is treated as site traffic, so a forged X-Forwarded-Host cannot
 * unlock the dashboard on the site host.
 */
export function isSiteHostRequest(headers: Headers, env: Env = process.env): boolean {
	const site = siteHosts(env)
	if (site.length === 0) return false
	return requestHosts(headers).some((h) => site.includes(h))
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackPeer(ip: string): boolean {
	const v = ip.trim().toLowerCase().replace(/^::ffff:/, '')
	return v === '::1' || /^127\./.test(v)
}

/**
 * True for a caller inside powder's own container (the entrypoint's probe of
 * 127.0.0.1:3000): every claimed host is loopback, no proxy header that Traefik or
 * Cloudflare sets is present (x-real-ip, cf-connecting-ip, forwarded), and every
 * x-forwarded-for hop (Next fills it from the socket when absent) is a loopback address.
 * A request through Traefik never matches, and neither does an on-server curl through the
 * published port (its peer is the docker bridge gateway): those get the public body,
 * which is all bin/self-deploy.sh reads. Limit: Next does not expose the socket address
 * to route handlers, so a container that reaches powder:3000 directly and sends both a
 * loopback Host and `x-forwarded-for: 127.0.0.1` itself is treated as loopback (it then
 * sees the version and scheduler detail, nothing secret).
 */
export function isLoopbackRequest(headers: Headers): boolean {
	const hosts = requestHosts(headers)
	if (hosts.length === 0 || !hosts.every((h) => LOOPBACK_HOSTS.has(h))) return false
	if (headers.get('x-real-ip') || headers.get('cf-connecting-ip') || headers.get('forwarded')) return false
	const xff = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
	return xff.length > 0 && xff.every(isLoopbackPeer)
}

const SITE_EXACT = new Set([
	'/',
	'/docs',
	'/robots.txt',
	'/sitemap.xml',
	'/llms.txt',
	'/favicon.ico',
	'/icon.svg',
	'/apple-icon.svg',
	// Root Open Graph / Twitter cards (app/opengraph-image.tsx, twitter-image.tsx).
	// The docs cards live under /docs/ and are covered by that prefix.
	'/opengraph-image',
	'/twitter-image',
	// An external uptime monitor probes this.
	'/api/health',
	'/ingest',
])

const SITE_PREFIXES = [
	'/docs/',
	// Next build output: JS/CSS chunks, fonts, image optimizer.
	'/_next/',
	// GitHub push webhooks already installed on app repos point here.
	'/api/webhooks/',
	// PostHog reverse proxy (next.config.ts rewrites), used by the public pages.
	'/ingest/',
]

/** Paths a site host serves when split. Everything else 404s there. */
export function isSiteAllowedPath(pathname: string): boolean {
	if (SITE_EXACT.has(pathname)) return true
	// Root-level static files (public/*.txt, *.svg, ...). No dashboard route is a
	// single dotted segment; the guard test keeps it that way and checks every
	// file under public/ is allowed here.
	if (/^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]+$/.test(pathname)) return true
	return SITE_PREFIXES.some((p) => pathname.startsWith(p))
}

/**
 * Base URL for GitHub push webhooks handed out for new repos. Split: the first
 * site host, so new hooks match the ones already installed. Otherwise the
 * BETTER_AUTH_URL origin (a required setting, docs/SELF-HOSTING.md); throws
 * DashboardUrlMissingError when neither is set. Never the project's site and
 * never the request's Host / X-Forwarded-Host: a forged header
 * would hand GitHub a webhook URL (with its token) on another host. The headers
 * argument is kept for the callers and ignored.
 */
export function webhookBaseUrl(_headers?: Headers | null, env: Env = process.env): string {
	const site = siteHosts(env)[0]
	if (site) return `https://${site}`
	return dashboardUrl(env)
}

/** webhookBaseUrl, or null when neither POWDER_SITE_HOST nor BETTER_AUTH_URL is usable. */
export function webhookBaseUrlOrNull(env: Env = process.env): string | null {
	const site = siteHosts(env)[0]
	if (site) return `https://${site}`
	return dashboardUrlOrNull(env)
}

/** The refusal for a route about to install a GitHub webhook (or hand out its URL)
 *  without a configured base URL, else null. */
export function webhookConfigError(env: Env = process.env): string | null {
	return webhookBaseUrlOrNull(env) ? null : new DashboardUrlMissingError().message
}

export function webhookUrl(
	token: string,
	headers?: Headers | null,
	env: Env = process.env,
): string {
	return `${webhookBaseUrl(headers, env)}/api/webhooks/deploy/${token}`
}

/** Public-site link to the operator login, or null when split (never link the dashboard from the site). */
export function publicSignInHref(env: Env = process.env): string | null {
	return isHostSplit(env) ? null : '/login'
}

/**
 * better-auth trustedOrigins: the dashboard origin plus the Traefik router
 * hosts from POWDER_DASHBOARD_HOST(_ALIAS/_ALIAS2), minus any site host.
 */
export function dashboardTrustedOrigins(env: Env = process.env): string[] {
	const site = siteHosts(env)
	// Unset BETTER_AUTH_URL trusts no dashboard origin (production refuses to boot
	// without it; dev adds its localhost origins in lib/auth.ts).
	const dash = authUrlOrigin(env)
	const out = new Set<string>(dash ? [dash] : [])
	for (const key of [
		'POWDER_DASHBOARD_HOST',
		'POWDER_DASHBOARD_HOST_ALIAS',
		'POWDER_DASHBOARD_HOST_ALIAS2',
	]) {
		const h = normalizeHost(env[key])
		if (h && !site.includes(h)) out.add(`https://${h}`)
	}
	for (const s of site) out.delete(`https://${s}`)
	return [...out]
}
