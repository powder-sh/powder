// the live SSE streams (deploy logs, container logs) end for three
// different reasons, and clients must tell them apart:
//   end      the deploy finished (data: 'success' | 'failed') or the log source closed
//   expired  the stream hit its lifetime cap: reconnect (deploy streams resume with
//            ?from=<characters received>)
//   revoked  the caller's token or session no longer holds: sign in again
// Shared by the routes (via stream-guard.ts) and the dashboard clients. No server
// imports: this file is bundled into client components.

export const STREAM_EXPIRED = 'expired'
export const STREAM_REVOKED = 'revoked'
/** deploy streams send the raw character offset of the output sent so far
 *  after each chunk (chunks are masked, so their length is not the raw length).
 *  A client resumes with ?from=<last offset>. */
export const STREAM_OFFSET = 'offset'
export type StreamStop = typeof STREAM_EXPIRED | typeof STREAM_REVOKED

export const REVOKED_MESSAGE =
	'your session expired or access was revoked: sign in again to keep watching'

/** The final status an `end` event of a deploy stream carries, or null when it is
 *  not one (never assume success). */
export function deployEndStatus(data: unknown): 'success' | 'failed' | null {
	let v: unknown = data
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v)
		} catch {
			// a plain string
		}
	}
	if (v && typeof v === 'object') v = (v as { status?: unknown }).status
	if (typeof v !== 'string') return null
	const s = v.trim().toLowerCase()
	return s === 'success' || s === 'failed' ? s : null
}

/** The raw offset an `offset` event carries, or null. */
export function streamOffset(data: unknown): number | null {
	let v: unknown = data
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v)
		} catch {
			return null
		}
	}
	const n = Number(v)
	return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** Characters as the server counts them (Postgres char_length: code points). */
export function streamChars(s: string): number {
	let n = 0
	for (const _ of s) n++
	return n
}

/** Deploy stream URL, resuming after `from` characters when > 0. */
export function deployStreamUrl(deployId: string, from = 0): string {
	const base = `/api/deploys/${encodeURIComponent(deployId)}/stream`
	return from > 0 ? `${base}?from=${Math.floor(from)}` : base
}

/** Log lines of a resumed container log stream (opened with tail=1): drop the
 *  first line when it repeats the last line already shown (docker --timestamps
 *  makes lines unique). */
export function dedupeResumedLines(last: string | undefined, lines: string[]): string[] {
	return last !== undefined && lines[0] === last ? lines.slice(1) : lines
}
