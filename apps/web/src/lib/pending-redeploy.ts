import { runInWeb } from './deploy-runner'
import { AppBeingDeletedError, DeployInFlightError, deployWorkerEnabled, startDeploy } from './deploys'
import { reportDeployToHq } from './hq'
import { redactSecrets } from './secret-text'

// When a webhook push arrives while a deploy for the SAME app is already in
// flight, the push must not be dropped (rapid iteration would leave the app
// behind HEAD).
//
// Since 0035 the normal path needs none of this: in worker mode a mid-deploy
// push is stored as the app's single QUEUED row (durable, survives restarts),
// and further pushes fold into it (startDeploy). This in-memory retry is the
// fallback for what's left: in-web mode (every row is 'running') and
// a database still on the pre-0035 combined index. The follow-up git-syncs to
// the branch HEAD, so ONE catch-up carries every dropped commit; one pending
// retry per app collapses a burst. A powder restart loses pending markers.
//
// It retries for longer than the longest possible deploy (script budget 55m +
// SSH wall ≈ 57.5m, watchdog hard cap 75m), and giving up is LOUD — an HQ
// deploy-failure event naming the dropped catch-up — never a silent drop.

const pending = new Set<string>()
const RETRY_MS = 15_000
const MAX_ATTEMPTS = 360 // 90 min of retries, past the watchdog's 75m hard cap

export function schedulePendingRedeploy(opts: {
	serverId: string
	containerName: string
	triggeredBy: string
}): void {
	const key = `${opts.serverId}:${opts.containerName}`
	if (pending.has(key)) return
	pending.add(key)
	let attempts = 0
	const tick = async () => {
		attempts++
		try {
			const started = await startDeploy({
				serverId: opts.serverId,
				containerName: opts.containerName,
				kind: 'git_deploy',
				triggeredBy: opts.triggeredBy,
			})
			// Flag-off the row is 'running' and nobody else will execute it: run it
			// through the one execution authority (worker mode: the worker claims it).
			if (!deployWorkerEnabled()) runInWeb(started)
			pending.delete(key)
			console.log(`[pending-redeploy] catch-up queued for ${key} after ${attempts} attempt(s)`)
		} catch (err) {
			if (err instanceof AppBeingDeletedError) {
				// The app is being deleted: the push has nothing left to deploy.
				pending.delete(key)
				console.log(`[pending-redeploy] ${key}: app is being deleted, catch-up dropped`)
			} else if (err instanceof DeployInFlightError && err.coalesced) {
				// A queued deploy exists now and will build HEAD — covered.
				pending.delete(key)
				console.log(`[pending-redeploy] ${key}: folded into the queued deploy`)
			} else if (err instanceof DeployInFlightError && attempts < MAX_ATTEMPTS) {
				setTimeout(tick, RETRY_MS)
			} else {
				pending.delete(key)
				const why = err instanceof DeployInFlightError ? `still in flight after ${attempts} attempts` : String(err)
				console.error(`[pending-redeploy] GAVE UP for ${key} — the push that scheduled it is NOT deployed: ${why}`)
				void reportDeployToHq({
					app: opts.containerName,
					server: opts.serverId,
					status: 'failure',
					sha: null,
					branch: null,
					error: redactSecrets(
						`catch-up deploy abandoned (${why}) - a push that landed mid-deploy was never deployed; redeploy the app`,
					),
					deployId: null,
					deployKind: 'git_deploy',
				})
			}
		}
	}
	setTimeout(tick, RETRY_MS)
}
