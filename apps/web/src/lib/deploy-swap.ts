// Did a failed deploy change what runs? The deploy runner's knowledge of which steps come
// at or after the swap, in one place: the runner uses it to decide rollback and env
// restore after a failure (deploy-runner.ts), and the deploy page to decide whether
// "roll back" would change anything. Pure, safe in client components.

import { WATCHDOG_STOPPED_STEP } from './deploy-watchdog-reason'

/** Remote-script phases that run AFTER the old container may already be gone (the
 *  up-retry path removes it). A failure here must roll back, not just be recorded. */
export const POST_SWAP_STEPS: ReadonlySet<string> = new Set([
	'docker compose up',
	'normalize (enforce restart + mem cap)',
	'resolve image',
])
/** The runner's own checks after the swap (the new container is live when they fail). */
export const HEALTH_CHECK_STEP = 'health check'
export const IMAGE_READBACK_STEP = 'image readback'

/** True when a failed deploy is known to have stopped before the swap: its failed step is
 *  recorded and is none of the steps at or after the swap. An unknown step (null: an SSH
 *  drop, a deadline kill) and a deploy the watchdog stopped mid-run may have swapped. Pure. */
export function failedBeforeSwap(failedStep: string | null | undefined): boolean {
	if (!failedStep) return false
	if (POST_SWAP_STEPS.has(failedStep)) return false
	return failedStep !== HEALTH_CHECK_STEP && failedStep !== IMAGE_READBACK_STEP && failedStep !== WATCHDOG_STOPPED_STEP
}

interface DeployState {
	id: string
	status: string
	failedStep?: string | null
}

/** True when rolling back to `lastGood` would recreate the version that already runs:
 *  `failed` stopped before the swap, and since `lastGood` no deploy of the app succeeded
 *  or may have swapped. `since` = the app's deploys that started at or after lastGood
 *  (lastGood itself may be in it); `complete` = false when that list was cut short, which
 *  answers false. Pure. */
export function rollbackChangesNothing(
	failed: DeployState,
	lastGood: { id: string } | null,
	since: readonly DeployState[],
	complete = true,
): boolean {
	if (!lastGood || !complete) return false
	if (failed.status !== 'failed' || !failedBeforeSwap(failed.failedStep)) return false
	return since.every(
		(d) => d.id === lastGood.id || d.status === 'queued' || (d.status === 'failed' && failedBeforeSwap(d.failedStep)),
	)
}
