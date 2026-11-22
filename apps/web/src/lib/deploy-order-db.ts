// The SQL side of lib/deploy-order.ts: every drizzle list of deploys orders by this.
// A function, not a constant: tests mock './db' without `deploys`.
import { deploys, desc } from './db'

/** newest push first (queued_at), the id breaking ties between rows of one transaction */
export function deployListOrder() {
	return [desc(deploys.queuedAt), desc(deploys.id)] as const
}
