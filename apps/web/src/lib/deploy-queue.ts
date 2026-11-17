// Per-server deploy serializer.
//
// Webhooks can fire faster than servers can build (a burst of pushes would
// start several `next build` processes on one server at once and run it out of
// memory).
// This module chains all work for a given server through a single Promise so
// only one deploy runs at a time per server. App-level dedup is still handled
// by the inFlight set in the webhook handler — this is the next layer down,
// preventing different apps on the same server from competing for RAM.

const queues = new Map<string, Promise<unknown>>()

export async function runOnServer<T>(
	serverId: string,
	work: () => Promise<T>,
): Promise<T> {
	const prev = queues.get(serverId) ?? Promise.resolve()
	let release: (v: T) => void = () => {}
	let reject: (e: unknown) => void = () => {}
	const result = new Promise<T>((res, rej) => {
		release = res
		reject = rej
	})
	const next = prev
		.catch(() => {}) // never let an upstream failure block the chain
		.then(async () => {
			try {
				const value = await work()
				release(value)
				return value
			} catch (err) {
				reject(err)
				throw err
			}
		})
	queues.set(serverId, next)
	// best-effort cleanup: if this is the tail of the chain when it finishes,
	// drop it from the Map so we don't leak resolved promises forever.
	// then(cleanup, cleanup), never a bare .finally(): when work() throws, `next`
	// rejects and a .finally() derived promise would reject with the same error
	// unhandled (an unhandledRejection per failed deploy, dumping its output into
	// the worker log). The caller already gets the error through `result`.
	const cleanup = () => {
		if (queues.get(serverId) === next) queues.delete(serverId)
	}
	next.then(cleanup, cleanup)
	return result
}
