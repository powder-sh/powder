// Post-swap bookkeeping: the writes powder makes to its OWN database after a deploy
// has already put the new container live (git sha/branch, image tag, the final
// success row). These record what happened; they must never decide it. When
// powder's Postgres is briefly slow (statement timeout 57014, a dropped
// connection), a thrown write used to fall into executeDeploy's catch-all and
// turn a live, finished update into "failed", with the failed query's text
// ("Failed query: ... params: ...") as the error summary.
// Every post-swap write goes through recordAfterSwap: bounded retry
// on transient DB errors, never throws, logs once when it gives up.

/** The one-line summary for a deploy whose failure was powder's own database, never the query text. */
export const POWDER_DB_SLOW_SUMMARY =
	"powder's own database was slow or unreachable while recording this deploy (a powder-side problem, not the app's code): check the deployed app before redeploying"

import { isDbError, isTransientDbError } from './pg-error'

export { isTransientDbError }

/** An error thrown by powder's own DB layer: isDbError (drizzle's "Failed query: ... params: ..."
 *  wrapper, a postgres.js PostgresError) or a postgres.js connection error. A bare socket error
 *  (ECONNREFUSED, ETIMEDOUT) is NOT enough: SSH to an app server throws those too. Pure. */
export function isPowderDbError(err: unknown): boolean {
	if (isDbError(err)) return true
	let cur: unknown = err
	for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
		const code = (cur as { code?: unknown }).code
		if (typeof code === 'string' && /^(CONNECTION_(CLOSED|ENDED|DESTROYED)|CONNECT_TIMEOUT)$/.test(code)) return true
		cur = (cur as { cause?: unknown }).cause
	}
	return false
}

export type BookkeepingResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

export interface BookkeepingOpts {
	/** delays before each retry (ms); attempts = delays.length + 1 */
	delaysMs?: number[]
	sleep?: (ms: number) => Promise<void>
	log?: (msg: string, err: unknown) => void
	/** 'read' for a post-swap read (health_url, rollback target): the give-up log says so. */
	kind?: 'write' | 'read'
}

const DEFAULT_DELAYS_MS = [2_000, 10_000]
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Run one post-swap bookkeeping write (or read, with kind: 'read'). Retries transient DB errors with bounded backoff,
 *  does not retry anything else, never throws. Logs once when it gives up. */
export async function recordAfterSwap<T>(
	deployId: string,
	label: string,
	write: () => Promise<T>,
	opts: BookkeepingOpts = {},
): Promise<BookkeepingResult<T>> {
	const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS
	const sleep = opts.sleep ?? realSleep
	const log = opts.log ?? ((m, e) => console.error(m, e))
	let lastErr: unknown
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		try {
			return { ok: true, value: await write() }
		} catch (err) {
			lastErr = err
			if (!isTransientDbError(err) || attempt === delays.length) break
			await sleep(delays[attempt] ?? 0)
		}
	}
	log(
		opts.kind === 'read'
			? `[deploy-bookkeeping ${deployId}] ${label} gave up, nothing read (the caller falls back):`
			: `[deploy-bookkeeping ${deployId}] ${label} not recorded (the deploy itself is unaffected):`,
		lastErr,
	)
	return { ok: false, error: lastErr }
}

/** The output line for a bookkeeping write that gave up. */
export function bookkeepingWarning(label: string): string {
	return `\n[powder] warning: could not record ${label} (powder's own database was slow); the deploy itself is unaffected\n`
}
