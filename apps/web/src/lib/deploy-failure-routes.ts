// The one answer to "does a failed deploy reach anyone outside the dashboard?".
// Every route that really carries deploy failures, from env presence and the
// saved notification targets. Pure: env values never leave this module, only
// which routes are on.
//
// Routes (what each carries, see notifications.ts and hq.ts):
// - env-webhook: POWDER_NOTIFY_WEBHOOK_URL gets deploy_failed (ENV_WEBHOOK_EVENTS).
// - webhook-target: an enabled webhook target with deploy_failed for every app.
// - email-target: the same as an email target, only while SMTP is configured
//   (POWDER_SMTP_URL + POWDER_MAIL_FROM); without it sendMail sends nothing.
// - ops-endpoint: ops endpoint reporting (POWDER_HQ_INGEST_TOKEN +
//   POWDER_HQ_INGEST_URL) posts every deploy result, failures included; the
//   endpoint does its own alerting. The generic and cron URLs carry no deploys.
// A target filtered to one app does not count: failures of the other apps go nowhere.

import { hqDeployEventsOn } from './hq'
import { smtpConfigured } from './mailer'
import {
	ENV_WEBHOOK_EVENTS,
	type RoutableTarget,
	envWebhookTarget,
	targetWants,
} from './notify-routing'
import type { DeployFailureRoute } from './deploy-failure-route-words'

export { type DeployFailureRoute, describeDeployFailureRoutes } from './deploy-failure-route-words'

export interface DeployFailureTarget extends RoutableTarget {
	email?: string | null
	urlEncrypted?: string | null
}

const ORDER: readonly DeployFailureRoute[] = [
	'webhook-target',
	'email-target',
	'env-webhook',
	'ops-endpoint',
]

/** The routes failed deploys take, in a fixed order; [] = none. */
export function deployFailureRoutes(
	env: Record<string, string | undefined>,
	targets: readonly DeployFailureTarget[],
): DeployFailureRoute[] {
	const on = new Set<DeployFailureRoute>()
	if (envWebhookTarget(env) && ENV_WEBHOOK_EVENTS.includes('deploy_failed')) on.add('env-webhook')
	for (const t of targets) {
		if (!targetWants(t, 'deploy_failed', null)) continue
		if (t.kind === 'webhook' && t.urlEncrypted) on.add('webhook-target')
		if (t.kind === 'email' && t.email && smtpConfigured(env)) on.add('email-target')
	}
	if (hqDeployEventsOn(env)) on.add('ops-endpoint')
	return ORDER.filter((r) => on.has(r))
}
