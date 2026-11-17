// cron_failed adapter for managed crons: builds the message and sends it
// through the shared notify() in lib/notifications.ts (targets + env webhook).

import { notify as notifyTargets } from './notifications'
import { redactSecrets } from './secret-text'

export interface CronFailedPayload {
	app: string
	server: string
	jobId: string
	schedule: string
	target: string
	status: 'failed' | 'timeout'
	error: string
}

export async function notify(event: 'cron_failed', payload: CronFailedPayload): Promise<boolean> {
	const { delivered } = await notifyTargets(event, {
		app: payload.app,
		server: payload.server,
		message: redactSecrets(
			`cron ${payload.status} (${payload.schedule}, ${payload.target}): ${payload.error.slice(0, 500)}`,
		),
		// Per job, so two failing jobs of one app are not deduped into one alert.
		instanceId: payload.jobId,
	})
	return delivered > 0
}

/** Alert once per failure streak: on the first failed/timeout run after a
 *  success (or after no run at all), not on every failing firing. Pure. */
export function shouldNotifyCronFailure(prevStatus: string | null, status: string): boolean {
	if (status !== 'failed' && status !== 'timeout') return false
	return prevStatus !== 'failed' && prevStatus !== 'timeout'
}
