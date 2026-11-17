import { REVOKED_MESSAGE, STREAM_EXPIRED, STREAM_REVOKED, type StreamStop } from './stream-events'

// limits for the live SSE streams (container logs, deploy logs).
//
// Each stream holds an SSH channel (logs) or a polling timer (deploys) for as long
// as the client stays connected, and was authorized once, at the start. So:
//   - at most STREAMS_PER_USER concurrent streams per user (tokens count for their
//     user) and STREAMS_PER_SERVER per managed server, in this process;
//   - a stream ends after STREAM_MAX_LIFETIME_MS (the client reconnects, which
//     authorizes again);
//   - every STREAM_RECHECK_MS the caller's credentials are checked again (a revoked
//     or expired API token, a signed-out session, a user who is no longer admin)
//     and the stream ends when they no longer hold.

export const STREAMS_PER_USER = 5
export const STREAMS_PER_SERVER = 20
const STREAM_MAX_LIFETIME_MS = 30 * 60_000
const STREAM_RECHECK_MS = 60_000

const g = globalThis as {
	__powderStreams?: { user: Map<string, number>; server: Map<string, number> }
}
function counts() {
	if (!g.__powderStreams) g.__powderStreams = { user: new Map(), server: new Map() }
	return g.__powderStreams
}

/** Take a slot, or a 429 Response. The release function is idempotent. */
export function acquireStreamSlot(
	userId: string,
	serverId: string,
): { release: () => void } | Response {
	const c = counts()
	const u = c.user.get(userId) ?? 0
	const s = c.server.get(serverId) ?? 0
	if (u >= STREAMS_PER_USER)
		return Response.json(
			{ error: `too many live streams: at most ${STREAMS_PER_USER} per user; close one first` },
			{ status: 429 },
		)
	if (s >= STREAMS_PER_SERVER)
		return Response.json(
			{ error: `too many live streams on this server: at most ${STREAMS_PER_SERVER}` },
			{ status: 429 },
		)
	c.user.set(userId, u + 1)
	c.server.set(serverId, s + 1)
	let done = false
	return {
		release() {
			if (done) return
			done = true
			const dec = (m: Map<string, number>, k: string) => {
				const n = (m.get(k) ?? 1) - 1
				if (n <= 0) m.delete(k)
				else m.set(k, n)
			}
			dec(c.user, userId)
			dec(c.server, serverId)
		},
	}
}

/** Test hook. */
export function resetStreamSlots(): void {
	g.__powderStreams = undefined
}

export interface StreamPrincipal {
	id: string
	viaToken?: boolean
	tokenId?: string
}

/** Do the credentials that opened the stream still hold? `hdrs` are the request's
 *  headers (cookie / authorization), kept from the start of the stream. Errors
 *  count as "no" (fail closed). */
export async function streamStillAuthorized(who: StreamPrincipal, hdrs: Headers): Promise<boolean> {
	try {
		const { isAdminUserId } = await import('./admin-ids')
		if (!isAdminUserId(who.id)) return false
		if (who.viaToken) {
			if (!who.tokenId) return false
			const { and, db, eq, isNull, userApiTokens } = await import('./db')
			const [row] = await db
				.select({ expiresAt: userApiTokens.expiresAt })
				.from(userApiTokens)
				.where(and(eq(userApiTokens.id, who.tokenId), isNull(userApiTokens.revokedAt)))
				.limit(1)
			return !!row && (!row.expiresAt || row.expiresAt.getTime() > Date.now())
		}
		const { auth } = await import('./auth')
		const session = await auth.api.getSession({ headers: hdrs })
		return session?.user.id === who.id
	} catch {
		return false
	}
}

/** Timers that end a stream: at the lifetime cap (`expired`), or when a recheck
 *  fails (`revoked`). `end(event, reason)` is called at most once; the route sends
 *  `event` as the SSE event name (never `end`: clients read `end` as "the deploy
 *  finished"). Returns a stop function. */
export function guardStream(opts: {
	recheck: () => Promise<boolean>
	end: (event: StreamStop, reason: string) => void
	lifetimeMs?: number
	recheckMs?: number
}): () => void {
	let stopped = false
	const stop = () => {
		stopped = true
		clearTimeout(life)
		clearInterval(timer)
	}
	const finish = (event: StreamStop, reason: string) => {
		if (stopped) return
		stop()
		opts.end(event, reason)
	}
	const life = setTimeout(
		() => finish(STREAM_EXPIRED, 'stream lifetime reached; reconnecting'),
		opts.lifetimeMs ?? STREAM_MAX_LIFETIME_MS,
	)
	const timer = setInterval(() => {
		// A recheck that rejects fails closed (revoked); a throwing end() is logged,
		// never left as an unhandled rejection.
		void opts
			.recheck()
			.catch(() => false)
			.then((ok) => {
				if (!ok) finish(STREAM_REVOKED, REVOKED_MESSAGE)
			})
			.catch((err) => console.error('[stream-guard] ending the stream failed:', err))
	}, opts.recheckMs ?? STREAM_RECHECK_MS)
	return stop
}
