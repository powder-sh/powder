// The worker's dispatch step, separated from worker.ts (which starts timers and
// signal handlers at import) so it can be tested.
//
// A claim can commit AFTER shutdown started (claim-late's late dispatch, or the
// claim transaction racing SIGTERM). The row is already 'running'. Executing it
// during a drain would be killed by process.exit when the drain finishes (or run
// on a worker that is going away), and nothing else would pick it up until the
// watchdog reaps it as failed. So while draining the row is flipped back to
// 'queued' for the next worker instead of being run.

import type { Deploy } from './db'

export interface DispatchDeps {
	isDraining: () => boolean
	execute: (deploy: Deploy) => Promise<void>
	requeue: (deployId: string) => Promise<unknown>
	/** Servers with a deploy running in this worker. */
	inFlightServers: Set<string>
	/** Every in-flight promise; the shutdown drain awaits all of them. */
	inFlightDeploys: Set<Promise<void>>
}

export function makeDispatch(deps: DispatchDeps): (deploy: Deploy) => void {
	return (deploy) => {
		if (deps.isDraining()) {
			console.log(`[worker] draining: handing claimed deploy ${deploy.id} back to the queue instead of running it`)
			const q: Promise<void> = deps
				.requeue(deploy.id)
				.then(
					() => {},
					(err) => console.error(`[worker] requeue of deploy ${deploy.id} failed (the watchdog will reap it):`, err),
				)
				.finally(() => {
					deps.inFlightDeploys.delete(q)
				})
			deps.inFlightDeploys.add(q)
			return
		}
		const { serverId } = deploy
		deps.inFlightServers.add(serverId)
		console.log(`[worker] claimed deploy ${deploy.id} (${deploy.containerName} on ${serverId})`)
		const p: Promise<void> = deps
			.execute(deploy)
			.catch((err) => console.error(`[worker] deploy ${deploy.id} threw:`, err))
			.finally(() => {
				deps.inFlightServers.delete(serverId)
				deps.inFlightDeploys.delete(p)
			})
		deps.inFlightDeploys.add(p)
	}
}
