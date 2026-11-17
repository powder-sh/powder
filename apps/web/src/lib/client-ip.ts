// Which request header carries the real client IP. One authority for the
// better-auth login limiter (lib/auth.ts) and powder's own limiters
// (webhookClientIp in lib/webhook-gate.ts).
//
// POWDER_TRUSTED_IP_HEADER:
//   x-real-ip (default) - directly behind powder's Traefik (or another proxy that
//     sets X-Real-IP from the TCP peer). Client-sent cf-connecting-ip is ignored.
//   cf-connecting-ip - behind Cloudflare. Order: cf-connecting-ip, x-real-ip,
//     right-most x-forwarded-for hop. SAFE ONLY when the origin accepts traffic
//     from Cloudflare alone (an origin lock); otherwise any client can send its
//     own cf-connecting-ip and get a fresh rate-limit bucket per request.
//   x-forwarded-for - the right-most x-forwarded-for hop (the one the nearest
//     proxy appended). Client-sent cf-connecting-ip and x-real-ip are ignored.
// the default is x-real-ip, the one that is safe on a server reachable
// directly. Behind Cloudflare set cf-connecting-ip, or every visitor shares the
// bucket of the Cloudflare edge IP it came through. An unknown value also falls
// back to x-real-ip.
// behind a proxy that is not Traefik, x-real-ip must be set by that proxy
// (nginx: `proxy_set_header X-Real-IP $remote_addr;`, Caddy: `header_up X-Real-IP
// {remote_host}`). Without it every request is 'unknown': powder logs one WARN, and
// no limiter puts those requests in one shared pre-auth bucket (one client could
// 429 everyone): webhooks fall back to the per-token bucket, MCP to a per-credential
// bucket, better-auth skips its per-IP limiter (the per-email lockout still applies).

import { isIP } from 'node:net'

export type TrustedIpHeader = 'cf-connecting-ip' | 'x-real-ip' | 'x-forwarded-for'

const MODES: readonly TrustedIpHeader[] = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']

export function trustedIpHeader(
	env: string | undefined = process.env.POWDER_TRUSTED_IP_HEADER,
): TrustedIpHeader {
	const v = (env ?? '').trim().toLowerCase()
	if (!v) return 'x-real-ip'
	if ((MODES as readonly string[]).includes(v)) return v as TrustedIpHeader
	console.warn(
		`[client-ip] unknown POWDER_TRUSTED_IP_HEADER=${JSON.stringify(v).slice(0, 60)}, using x-real-ip`,
	)
	return 'x-real-ip'
}

/** better-auth `advanced.ipAddress` for the mode. For x-forwarded-for,
 *  better-auth only walks the hops right to left when trustedProxies is set
 *  (else it refuses any multi-hop value); a range that matches nothing makes
 *  it take the right-most hop. */
export function betterAuthIpOptions(mode: TrustedIpHeader = trustedIpHeader()): {
	ipAddressHeaders: string[]
	trustedProxies?: string[]
} {
	if (mode === 'x-real-ip') return { ipAddressHeaders: ['x-real-ip'] }
	if (mode === 'x-forwarded-for')
		return { ipAddressHeaders: ['x-forwarded-for'], trustedProxies: ['255.255.255.255/32'] }
	// trustedProxies: a multi-hop x-forwarded-for resolves to its right-most hop
	// (like clientIpFromHeaders) instead of no IP at all.
	return {
		ipAddressHeaders: ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'],
		trustedProxies: ['255.255.255.255/32'],
	}
}

/** better-auth `rateLimit.customRules`. better-auth puts every request
 *  without a resolvable client IP into ONE shared per-path bucket, so when the
 *  proxy sends no trusted IP header a single client could lock everyone out of
 *  sign-in. Such requests skip better-auth's per-IP limiter instead; the per-email
 *  sign-in lockout (lib/signin-lockout.ts) still applies to them. */
export function betterAuthRateLimitRules(
	mode: TrustedIpHeader = trustedIpHeader(),
): Record<
	string,
	(
		req: Request,
		current: { window: number; max: number },
	) => { window: number; max: number } | false
> {
	return {
		'/**': (req, current) => (knownClientIp(req.headers, mode) ? current : false),
	}
}

/** The client IP when a trusted header carries a valid address, else null. */
export function knownClientIp(
	headers: Headers,
	mode: TrustedIpHeader = trustedIpHeader(),
): string | null {
	const ip = clientIpFromHeaders(headers, mode)
	return ip !== 'unknown' && isIP(ip) ? ip : null
}

let missingWarned = false

/** Test hook: let the one-time missing-header warning fire again. */
export function resetMissingIpWarning(): void {
	missingWarned = false
}

function warnMissingOnce(mode: TrustedIpHeader): void {
	if (missingWarned) return
	missingWarned = true
	const fix =
		'Behind nginx add `proxy_set_header X-Real-IP $remote_addr;`, behind Caddy `header_up X-Real-IP {remote_host}`, behind Cloudflare (origin locked) set POWDER_TRUSTED_IP_HEADER=cf-connecting-ip.'
	console.warn(
		`[client-ip] WARN a request reached powder without a ${mode} header (POWDER_TRUSTED_IP_HEADER=${mode}), so rate limits cannot tell clients apart. ${fix} Until then webhooks are limited per token and sign-in per email only. Logged once.`,
	)
}

function rightmostXff(headers: Headers): string | null {
	return headers.get('x-forwarded-for')?.split(',').pop()?.trim() || null
}

/** Client IP for powder's own limiters. Never the left-most x-forwarded-for
 *  hop (the client controls it). 'unknown' when nothing trusted is present. */
export function clientIpFromHeaders(
	headers: Headers,
	mode: TrustedIpHeader = trustedIpHeader(),
): string {
	const ip =
		mode === 'x-real-ip'
			? headers.get('x-real-ip')?.trim()
			: mode === 'x-forwarded-for'
				? rightmostXff(headers)
				: headers.get('cf-connecting-ip')?.trim() ||
					headers.get('x-real-ip')?.trim() ||
					rightmostXff(headers)
	if (ip) return ip
	warnMissingOnce(mode)
	return 'unknown'
}
