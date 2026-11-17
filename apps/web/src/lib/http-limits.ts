// request bodies are bounded BEFORE parsing, so a huge JSON body cannot
// balloon memory. proxy.ts rejects oversized Content-Length up front; routes
// that read JSON use readJsonCapped, which also covers chunked bodies that
// carry no Content-Length.
//
// Chunked bodies (no Content-Length) skip the proxy check, and plain
// req.json() routes and better-auth read them whole. next.config.ts sets
// experimental.proxyClientMaxBodySize = MAX_BODY_BYTES: Next buffers at most
// that much of any request body for proxy + route, and a longer body arrives
// truncated (invalid JSON, rejected), not in full. Next has no per-route value
// for it, so MAX_BODY_BYTES is the one global cap and must cover the largest
// legitimate body. Every route reads JSON or a capped
// text body; the largest caps are the GitHub webhook (MAX_WEBHOOK_BYTES, 1 MB,
// push payloads are far smaller) and MCP (256 KB). There is no upload route
// (no backup or file upload into powder). So 1 MB for every path, and the
// declared Content-Length cap is the same value, so a 1-5 MB body gets a clear
// 413 instead of a silently truncated read. Raise both together if a route
// ever needs more.

const MAX_AUTH_BODY_BYTES = 1024 * 1024
export const MAX_BODY_BYTES = 1024 * 1024

function bodyLimitFor(pathname: string): number {
	return pathname.startsWith('/api/auth/') ? MAX_AUTH_BODY_BYTES : MAX_BODY_BYTES
}

/** True when a declared Content-Length is over the limit for this path. */
export function declaredBodyTooLarge(pathname: string, contentLength: string | null): boolean {
	if (!contentLength) return false
	const n = Number(contentLength)
	return Number.isFinite(n) && n > bodyLimitFor(pathname)
}

export class BodyTooLargeError extends Error {}

/** Reads a body as text, aborting once `max` bytes have been read (covers chunked
 *  bodies with no Content-Length). Throws BodyTooLargeError. */
export async function readTextCapped(req: Request, max = 256 * 1024): Promise<string> {
	const declared = Number(req.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError()
	if (!req.body) return ''
	const reader = req.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > max) {
			await reader.cancel().catch(() => {})
			throw new BodyTooLargeError()
		}
		chunks.push(value)
	}
	return Buffer.concat(chunks).toString('utf8')
}

/** Reads and parses a JSON body, aborting once `max` bytes have been read. */
export async function readJsonCapped<T = unknown>(req: Request, max = 256 * 1024): Promise<T> {
	const declared = Number(req.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError()
	if (!req.body) return JSON.parse('null') as T
	return JSON.parse(await readTextCapped(req, max)) as T
}

/** GitHub caps webhook payloads at 25 MB but push events that powder acts on are tiny. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024

export function bodyTooLargeResponse(): Response {
	return Response.json({ error: 'request body too large' }, { status: 413 })
}
