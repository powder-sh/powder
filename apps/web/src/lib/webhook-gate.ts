import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { clientIpFromHeaders } from './client-ip'

function verifySignature(body: string, sigHeader: string, secret: string): boolean {
	if (!sigHeader.startsWith('sha256=')) return false
	const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
	if (expected.length !== sigHeader.length) return false
	try {
		return timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader))
	} catch {
		return false
	}
}

// Verify the signature BEFORE any event-specific reply, so an unauthenticated
// caller cannot learn anything from a valid token without the secret (no 200
// `{ignored}` or pong). An unknown token gets the same 401 (unknownTokenResponse).
// Returns a Response to send, or null for a push.
export function webhookEventGate(
	event: string,
	body: string,
	sig: string,
	secret: string,
	opts: {
		pongExtra?: Record<string, unknown>
		delivery?: string | null
		// Runs only once the signature verified (the per-token rate limit: an
		// unsigned request must not use up a real delivery's budget).
		onVerified?: () => Response | null
	} = {},
): Response | null {
	if (!verifySignature(body, sig, secret)) return badSignatureResponse()
	const after = opts.onVerified?.()
	if (after) return after
	if (event === 'ping') return Response.json({ pong: true, ...(opts.pongExtra ?? {}) })
	if (event !== 'push') return Response.json({ ignored: event })
	// GitHub always sends a delivery id; a push without one is a hand-made replay.
	if (!opts.delivery) return Response.json({ error: 'missing delivery id' }, { status: 400 })
	return null
}

function badSignatureResponse(): Response {
	return Response.json({ error: 'bad signature' }, { status: 401 })
}

// A per-process secret no webhook uses, so the HMAC below never matches.
const UNKNOWN_TOKEN_SECRET = randomBytes(32).toString('hex')

/** The answer for a well-formed token that names no app and no group: the same
 *  401 a bad signature gets, after the same HMAC over the body, so the status,
 *  body and work do not tell an unknown token from a valid one. */
export function unknownTokenResponse(body: string, sig: string): Response {
	verifySignature(body, sig, UNKNOWN_TOKEN_SECRET)
	return badSignatureResponse()
}

// Client key for the webhook limiter. Never the left-most
// x-forwarded-for hop (the client controls it). Which header is trusted is
// POWDER_TRUSTED_IP_HEADER (lib/client-ip.ts); the default is x-real-ip.
export function webhookClientIp(headers: Headers): string {
	return clientIpFromHeaders(headers)
}

/** Character set of every webhook token powder accepts: base64url, which also covers
 *  hex tokens. No minimum length beyond 1: the check only has to keep junk paths away
 *  from the buckets and the DB; the lookup decides whether a token exists. */
const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/

/** the limiter keys for a webhook request, or null when the token cannot be one
 *  (404 without a DB hit). The per-IP key is charged before any lookup; with no
 *  trusted client IP ('unknown') there is NO per-IP key: one shared 'unknown' bucket
 *  let a single client 429 every GitHub delivery. The per-token key is charged only
 *  after the signature verified (webhookEventGate onVerified). */
export function webhookLimitKeys(
	ip: string,
	token: string,
): { ipKey: string | null; tokenKey: string } | null {
	if (!WEBHOOK_TOKEN_RE.test(token)) return null
	return {
		ipKey: ip === 'unknown' ? null : `webhook:ip:${ip}`,
		tokenKey: `webhook:token:${token}`,
	}
}

/** 429 with Retry-After when `key` is over its bucket, else null. A limiter
 *  error never blocks a delivery. */
export function rateLimitedResponse(
	check: (key: string, limit: number, windowMs: number) => { ok: boolean; retryAfterMs: number },
	key: string,
	limit: number,
	windowMs: number,
): Response | null {
	let r: { ok: boolean; retryAfterMs: number }
	try {
		r = check(key, limit, windowMs)
	} catch (err) {
		console.error('[webhook] rate limit check failed:', err)
		return null
	}
	if (r.ok) return null
	return Response.json(
		{ error: 'rate limited' },
		{ status: 429, headers: { 'Retry-After': Math.ceil(r.retryAfterMs / 1000).toString() } },
	)
}
