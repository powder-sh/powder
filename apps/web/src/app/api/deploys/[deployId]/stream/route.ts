import { requireContainerAccess, requireUser } from '@/lib/access'
import { db, deploys, eq, sql } from '@/lib/db'
import { subscribe } from '@/lib/deploy-bus'
import { deployWorkerEnabled } from '@/lib/deploys'
import { SecretStreamRedactor, redactNullable, redactSecrets } from '@/lib/secret-text'
import { STREAM_OFFSET } from '@/lib/stream-events'
import { acquireStreamSlot, guardStream, streamStillAuthorized } from '@/lib/stream-guard'
import type { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// How often we re-read the deploy row in worker mode. The worker debounce-
// flushes partial output to deploys.output ~every 1.5s, so polling at the same
// cadence keeps the live log roughly in step without hammering the DB.
const POLL_MS = 1500

const isTerminal = (s: string) => s === 'success' || s === 'failed'

export async function GET(req: NextRequest, ctx: { params: Promise<{ deployId: string }> }) {
	// Deploy logs carry env banners + full build output — gate on the same
	// per-container access the container-detail routes use. Auth BEFORE the row
	// lookup so unauthenticated callers can't probe which deploy IDs exist.
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp

	const { deployId } = await ctx.params
	const [row] = await db.select().from(deploys).where(eq(deploys.id, deployId)).limit(1)
	if (!row) return new Response('not found', { status: 404 })

	// the same per-container check as the deploy detail route (it also refuses
	// powder's own container and a container the user cannot reach on that server).
	const access = await requireContainerAccess(row.serverId, row.containerName)
	if (access instanceof Response) return access

	// a live stream takes a slot (per user, per server) and is bounded in
	// lifetime and re-authorized periodically; a finished deploy is one response.
	const slot = isTerminal(row.status) ? null : acquireStreamSlot(userOrResp.id, row.serverId)
	if (slot instanceof Response) return slot
	const reqHeaders = new Headers(req.headers)
	let stopGuard: () => void = () => {}

	// Optional ?from=<character offset> so a reconnecting client skips output it
	// already has (worker mode only; the in-web mode's in-memory bus has no replay).
	const fromParam = Number(new URL(req.url).searchParams.get('from') ?? 0)
	const fromOffset = Number.isFinite(fromParam) && fromParam > 0 ? Math.floor(fromParam) : 0

	const encoder = new TextEncoder()
	// Assigned by start(); cancel() calls it when the client disconnects.
	let cleanup: () => void = () => {}
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
				stopGuard()
				slot?.release()
				if (closed) return
				closed = true
				try {
					controller.close()
				} catch {
					// already closed
				}
			}

			// If already finished, send everything we have and close.
			if (isTerminal(row.status)) {
				// masked like every other reader of the deploy output and error text.
				if (row.output) send('chunk', redactSecrets(row.output))
				if (row.error) send('error', redactNullable(row.error) as string)
				send('end', row.status)
				closeStream()
				return
			}

			const ping = setInterval(() => safeEnqueue(encoder.encode(': ping\n\n')), 25_000)
			// Assigned below by the mode that runs; the guard's end() calls it.
			let stopMode: () => void = () => {}
			stopGuard = guardStream({
				recheck: () => streamStillAuthorized(userOrResp, reqHeaders),
				end: (event, reason) => {
					send(event, reason)
					stopMode()
					clearInterval(ping)
					closeStream()
				},
			})

			// Worker mode: the deploy executes in the SEPARATE worker process, so the
			// in-memory deploy-bus in THIS (web) process never sees its chunks. Poll
			// the row's output column — the worker append-only-grows and flushes it
			// every ~1.5s — and emit the forward delta. While 'queued' there's nothing
			// yet, so we just keep the connection warm. We deliberately do NOT delta
			// across the terminal flip: finishDeploy rewrites output into its final
			// shape (env banner + build output + health output), which can diverge
			// from the streamed accumulator, so on terminal we just emit 'end' and let
			// the client refetch the canonical row.
			if (deployWorkerEnabled()) {
				let sentLen = fromOffset
				let stopped = false
				// chunks go out masked, whole lines at a time (a secret split
				// across two polls is masked as one); the raw character offset follows
				// each chunk as its own event, so a resuming client asks for ?from= in
				// raw characters, not in the (shorter or longer) masked ones.
				const redactor = new SecretStreamRedactor()
				const finish = () => {
					if (stopped) return
					stopped = true
					clearInterval(timer)
					clearInterval(ping)
					closeStream()
				}
				// A resumed stream (?from=) may start inside a private key block: replay the
				// output before the offset through the redactor (nothing is sent) so it
				// knows that, and the key lines after the offset stay masked.
				let primed = fromOffset === 0
				const prime = async () => {
					const [pre] = await db
						.select({ text: sql<string>`substr(coalesce(${deploys.output}, ''), 1, ${fromOffset})` })
						.from(deploys)
						.where(eq(deploys.id, deployId))
						.limit(1)
					const text = pre?.text ?? ''
					redactor.push(text)
					// A prefix that does not end a line was already sent whole: drop it.
					if (!text.endsWith('\n')) redactor.flush()
					primed = true
				}
				const poll = async () => {
					if (stopped || closed) return
					try {
						if (!primed) await prime()
						// only the status and the output past what was sent, not
						// the whole row (the full build log) every tick. Offsets are in
						// characters (Postgres substr / char_length).
						const out = sql`coalesce(${deploys.output}, '')`
						const [cur] = await db
							.select({
								status: deploys.status,
								error: deploys.error,
								len: sql<number>`char_length(${out})::int`,
								tail: sql<string>`substr(${out}, ${sentLen + 1})`,
							})
							.from(deploys)
							.where(eq(deploys.id, deployId))
							.limit(1)
						if (!cur) {
							send('end', 'failed')
							finish()
							return
						}
						if (cur.status === 'running') {
							if (Number(cur.len) > sentLen && cur.tail) {
								const nl = cur.tail.lastIndexOf('\n')
								// A partial last line waits for the next poll (up to 64K chars).
								const take = nl >= 0 ? cur.tail.slice(0, nl + 1) : cur.tail.length >= 64 * 1024 ? cur.tail : ''
								if (take) {
									const masked = redactor.push(take) + (nl >= 0 ? '' : redactor.flush())
									sentLen += [...take].length
									if (masked) send('chunk', masked)
									send(STREAM_OFFSET, String(sentLen))
								}
							}
						} else if (isTerminal(cur.status)) {
							if (cur.error) send('error', redactNullable(cur.error) as string)
							send('end', cur.status)
							finish()
						}
						// 'queued' → still waiting for the worker to claim it; keep polling.
					} catch (err) {
						console.error(`[deploy-stream ${deployId}] poll failed:`, err)
					}
				}
				const timer = setInterval(() => void poll(), POLL_MS)
				stopMode = () => {
					stopped = true
					clearInterval(timer)
				}
				cleanup = () => {
					stopped = true
					clearInterval(timer)
					clearInterval(ping)
					stopGuard()
					slot?.release()
				}
				void poll()
				return
			}

			// In-web mode (POWDER_DEPLOY_WORKER off): the deploy runs in THIS process and
			// publishes chunks to the in-memory bus. Subscribe for live events.
			const unsub = subscribe(deployId, (event) => {
				send(event.type, event.data)
				if (event.type === 'end' || event.type === 'error') {
					unsub()
					clearInterval(ping)
					closeStream()
				}
			})
			stopMode = unsub
			cleanup = () => {
				clearInterval(ping)
				unsub()
				stopGuard()
				slot?.release()
			}
		},
		cancel() {
			cleanup()
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	})
}
