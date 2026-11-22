// The live half of the www check (lib/www-status.ts is the pure half): one HTTPS
// GET to https://<host>/, no redirect followed, a 5 s timeout, through
// guardedAppFetch so the address the socket connects to is checked at connect time
// (DNS rebinding included). The check is cronTargetBlocked: loopback, link-local,
// RFC 1918, unique-local and CGNAT 100.64/10 are refused; a public www never
// resolves there. Hosts come only from an app's own domain rows (the route derives
// them), never from the client.
//
// Results are cached per host for 60 s, like github-ci.ts, and concurrent checks of
// one host share one request. `fresh` (the recheck control) skips a cached answer
// older than 10 s.

import 'server-only'
import { cronTargetBlocked, guardedAppFetch } from './notify-url-guard'
import { WWW_PROBE_TIMEOUT_MS, type WwwProbeOutcome } from './www-status'

const CACHE_TTL_MS = 60_000
const FRESH_MIN_AGE_MS = 10_000

const cache = new Map<string, { at: number; value: WwwProbeOutcome }>()
const inFlight = new Map<string, Promise<WwwProbeOutcome>>()

function errorCode(err: unknown): string {
	const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null
	if (typeof e?.code === 'string') return e.code
	if (typeof e?.cause?.code === 'string') return e.cause.code
	if (e?.name === 'AbortError') return 'ABORT_ERR'
	return 'UNKNOWN'
}

async function probeOnce(host: string): Promise<WwwProbeOutcome> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), WWW_PROBE_TIMEOUT_MS)
	try {
		const res = await guardedAppFetch(`https://${host}/`, {
			method: 'GET',
			redirect: 'manual',
			signal: ctrl.signal,
			blocked: cronTargetBlocked,
			headers: { 'user-agent': 'powder-www-check' },
		})
		await res.body?.cancel().catch(() => {})
		return { status: res.status, location: res.headers.get('location') }
	} catch (err) {
		return { error: errorCode(err) }
	} finally {
		clearTimeout(timer)
	}
}

/** Probe `host` (already derived from a domain row), cached. */
export async function probeWww(host: string, opts: { fresh?: boolean } = {}): Promise<WwwProbeOutcome> {
	const key = host.toLowerCase()
	const hit = cache.get(key)
	if (hit) {
		const age = Date.now() - hit.at
		if (age < CACHE_TTL_MS && !(opts.fresh && age >= FRESH_MIN_AGE_MS)) return hit.value
	}
	const running = inFlight.get(key)
	if (running) return running
	const p = probeOnce(key)
		.then((value) => {
			cache.set(key, { at: Date.now(), value })
			return value
		})
		.finally(() => inFlight.delete(key))
	inFlight.set(key, p)
	return p
}
