// How deploy lists order and date their rows. One rule for every list of deploys (the
// /deploys page, an app's deployments tab and overview, the ci tab's checks, the activity
// feed): newest PUSH first, by queued_at, the time the deploy was asked for. started_at is
// reset when the worker claims the row, so ordering or dating by it moves a deploy that
// waited in the queue below the ones it waited behind, and hides the wait.
// Duration stays build time (finished_at - started_at); the wait is shown on its own
// (lib/format.ts waitedLabel).
//
// The SQL order is in lib/deploys.ts (deployListOrder) and app/api/deploys-list/route.ts
// (raw SQL, same columns). Pure, safe in client components.

type When = string | Date

/** The time a list shows ("12m ago") and sorts by: queued_at, else started_at (a row
 *  read without queued_at). */
export function deployListAt(d: { queuedAt?: When | null; startedAt: When }): When {
	return d.queuedAt ?? d.startedAt
}

/** The /deploys list cursor: the last row's queued_at in microseconds since the epoch and
 *  its id, so rows inserted in the same transaction (one push fanned out to several apps)
 *  are neither skipped nor repeated across pages. */
export function encodeDeployCursor(queuedAtMicros: string | number | bigint, id: string): string {
	return `${String(queuedAtMicros)}~${id}`
}

export type DeployCursor = { micros: string; id: string } | { iso: string }

/** null = no cursor, 'invalid' = answer 400. A plain ISO timestamp (the older cursor) is
 *  still accepted. */
export function parseDeployCursor(raw: string | null): DeployCursor | null | 'invalid' {
	if (raw === null || raw === '') return null
	const m = raw.match(/^(\d{1,17})~([A-Za-z0-9_-]{1,100})$/)
	if (m) return { micros: m[1] as string, id: m[2] as string }
	const ms = Date.parse(raw)
	return Number.isFinite(ms) ? { iso: new Date(ms).toISOString() } : 'invalid'
}
