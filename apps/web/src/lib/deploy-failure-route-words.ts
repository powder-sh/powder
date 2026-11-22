// Route names and words for deployFailureRoutes() (deploy-failure-routes.ts). No
// imports: the setup checklist card (a client component) renders these.

export type DeployFailureRoute = 'env-webhook' | 'webhook-target' | 'email-target' | 'ops-endpoint'

const ROUTE_WORDS: Record<DeployFailureRoute, string> = {
	'webhook-target': 'a webhook target',
	'email-target': 'an email target',
	'env-webhook': 'the env webhook (POWDER_NOTIFY_WEBHOOK_URL)',
	'ops-endpoint': 'your ops endpoint (ops endpoint reporting, POWDER_HQ_INGEST_URL)',
}

/** "failed deploys go to a webhook target and your ops endpoint (...)". */
export function describeDeployFailureRoutes(routes: readonly DeployFailureRoute[]): string {
	const words = routes.map((r) => ROUTE_WORDS[r])
	if (words.length === 0) return 'failed deploys are shown only in the dashboard'
	const list =
		words.length === 1
			? words[0]
			: `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
	return `failed deploys go to ${list}`
}
