import { requireContainerAccess } from '@/lib/access'
import { lineRedactor } from '@/lib/log-line-redact'
import { parseLogTail } from '@/lib/log-tail'
import { redactSecrets } from '@/lib/secret-text'
import { streamContainerLogs } from '@/lib/ssh'
import { acquireStreamSlot, guardStream, streamStillAuthorized } from '@/lib/stream-guard'
import type { NextRequest } from 'next/server'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
	req: NextRequest,
	ctx: { params: Promise<{ id: string; name: string }> },
) {
	const { id, name } = await ctx.params
	// never powder's own containers (POWDER_SELF_CONTAINER).
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server, user } = access
	// bounded concurrency, lifetime and periodic re-authorization.
	const slot = acquireStreamSlot(user.id, server.id)
	if (slot instanceof Response) return slot
	const reqHeaders = new Headers(req.headers)
	let stopGuard: () => void = () => {}

	const tail = parseLogTail(req.nextUrl.searchParams.get('tail'))
	const encoder = new TextEncoder()
	let cancelLogs: (() => void) | null = null
	// the client may leave while streamContainerLogs is still handshaking;
	// cancel() then has no handle yet, so remember it and cancel on arrival.
	let cancelled = false
	let pingTimer: ReturnType<typeof setInterval> | null = null

	const stream = new ReadableStream({
		async start(controller) {
			let closed = false
			const safeEnqueue = (bytes: Uint8Array) => {
				if (closed) return
				try {
					controller.enqueue(bytes)
				} catch {
					closed = true
				}
			}
			const send = (event: string, data: string) => {
				safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
			}
			const closeStream = () => {
				if (closed) return
				closed = true
				if (pingTimer) clearInterval(pingTimer)
				stopGuard()
				slot.release()
				try {
					controller.close()
				} catch {
					// already closed
				}
			}

			pingTimer = setInterval(() => {
				safeEnqueue(encoder.encode(': ping\n\n'))
			}, 25_000)
			stopGuard = guardStream({
				recheck: () => streamStillAuthorized(user, reqHeaders),
				end: (event, reason) => {
					send(event, reason)
					cancelled = true
					cancelLogs?.()
					closeStream()
				},
			})

			// whole lines only, each masked (redactSecrets); the rest on close.
			const lines = lineRedactor((text) => send('log', text))
			try {
				const handle = await streamContainerLogs(server, name, {
					tail,
					onData: (chunk) => lines.push(chunk),
					onError: (err) => {
						lines.flush()
						send('error', redactSecrets(err.message))
						closeStream()
					},
					onClose: () => {
						lines.flush()
						send('end', 'stream ended')
						closeStream()
					},
				})
				if (cancelled) {
					handle.cancel()
					closeStream()
					return
				}
				cancelLogs = handle.cancel
				send('open', 'connected')
			} catch (err) {
				send('error', redactSecrets(clientErrorMessage(err, 'failed to start stream', 'servers/:id/containers/:name/logs/stream')))
				closeStream()
			}
		},
		cancel() {
			cancelled = true
			cancelLogs?.()
			if (pingTimer) clearInterval(pingTimer)
			stopGuard()
			slot.release()
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			// nginx + cloudflare buffer streams without this:
			'X-Accel-Buffering': 'no',
		},
	})
}
