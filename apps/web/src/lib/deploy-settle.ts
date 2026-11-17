// Settle window for push deploys: a webhook push does not deploy at once, it waits up to
// N seconds (deploys.not_before) so further pushes of the same app fold into the one
// queued row and ship as ONE deploy of the newest commit. The window is fixed from the
// first push: a later push that folds in never moves not_before later.
//
// Off by default: no powder_meta row (DEPLOY_SETTLE_META_KEY) and no per-app value = 0.
// The row is the install default; POWDER_DEPLOY_SETTLE_SECONDS writes it at boot
// (deploy-settle-env.ts). Lowering a window does not move a held row's not_before
// earlier; only an effective window of 0 releases it (heldSql).
// Per app: app_repos.deploy_settle_seconds (null = the global value, 0 = off, N = seconds).
// Capped at DEPLOY_SETTLE_MAX_SECONDS whatever the settings say, so a held row stays well
// inside the watchdog (180 min), the stuck-queue report (60 min) and the drift watch (1 h).
// Turning the window off (global or per app) releases rows already held: "held" also needs
// the app's effective setting to be on (heldSql).
//
// Never held: anything not a webhook push (manual redeploy, rollback, restart, apply,
// previews, catch-ups of in-web mode), a push with powder_force, and a push where ANY
// commit message (head_commit.message or commits[].message) contains `[urgent]`, any case.
// A held row stays status 'queued' (other systems read the statuses).
//
// heldSql is THE definition of "held" (queued, only waiting on its not_before, window on):
// the worker's claim, the inline guard (rollback / restart / apply / stop / delete), the
// automatic-rollback "superseded" check, the stuck-deploy report, and the in-flight counts
// in bin/self-deploy.sh and bin/install.sh (a copy of heldSql('d'), kept identical by
// deploy-settle-scripts.test.ts) all use it.

export const DEPLOY_SETTLE_META_KEY = 'deploy_settle_seconds'
export const DEPLOY_SETTLE_MAX_SECONDS = 1800

// One number syntax for JS and SQL: digits, optional fraction, spaces around (btrim).
const NUMBER_RE = /^[0-9]+(\.[0-9]+)?$/

/** A settings value as whole seconds in [0, cap]. Unreadable, negative or absent = null.
 *  Same rule as the SQL in heldSql. */
export function parseSettleSeconds(v: unknown): number | null {
	if (v === null || v === undefined) return null
	if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), DEPLOY_SETTLE_MAX_SECONDS) : null
	const t = String(v).replace(/^ +| +$/g, '')
	if (!NUMBER_RE.test(t)) return null
	return Math.min(Math.floor(Number(t)), DEPLOY_SETTLE_MAX_SECONDS)
}

/** The window for one app: the per-app override when set (0 = off), else the global
 *  value, else 0. Always within [0, DEPLOY_SETTLE_MAX_SECONDS]. */
export function effectiveSettleSeconds(globalValue: unknown, perApp: unknown): number {
	const app = parseSettleSeconds(perApp)
	if (app !== null) return app
	return parseSettleSeconds(globalValue) ?? 0
}

/** Only webhook pushes (single app and monorepo fan-out) may be held. */
export function isSettleTrigger(triggeredBy: string | null | undefined): boolean {
	return !!triggeredBy && triggeredBy.startsWith('webhook')
}

/** `[urgent]` anywhere in a commit message, any case. */
export function commitMessageIsUrgent(message: unknown): boolean {
	return typeof message === 'string' && /\[urgent\]/i.test(message)
}

/** A push payload that must deploy now: powder_force in the signed body, or `[urgent]` in
 *  any commit message of the push (head_commit.message or any commits[].message). */
export function pushIsUrgent(payload: { powder_force?: unknown; head_commit?: unknown; commits?: unknown }): boolean {
	if (payload.powder_force === true) return true
	const msg = (c: unknown) => (c && typeof c === 'object' ? (c as { message?: unknown }).message : undefined)
	if (commitMessageIsUrgent(msg(payload.head_commit))) return true
	return Array.isArray(payload.commits) && payload.commits.some((c) => commitMessageIsUrgent(msg(c)))
}

const HELD_SQL_TEMPLATE =
	"({d}.status = 'queued' AND {d}.not_before IS NOT NULL AND {d}.not_before > {now} AND coalesce(" +
	'(SELECT s.deploy_settle_seconds FROM app_repos s WHERE s.server_id = {d}.server_id AND s.container_name = {d}.container_name AND s.deploy_settle_seconds >= 0 LIMIT 1), ' +
	"(SELECT floor(btrim(m.value)::numeric) FROM powder_meta m WHERE m.key = 'deploy_settle_seconds' AND btrim(m.value) = substring(btrim(m.value) from '^[0-9]+(?:[.][0-9]+)?')), " +
	'0) >= 1)'

/**
 * THE definition of a held deploys row, as a SQL predicate over the row alias `row`
 * (e.g. `"deploys"` or `d`): queued, its not_before still ahead of `at`, and the app's
 * effective window on (per-app value when set and >= 0, else the global powder_meta value,
 * else 0; the same numbers as effectiveSettleSeconds). Raw SQL: it only interpolates the
 * alias the caller passes and an ISO timestamp, never user input.
 */
export function heldSql(row: string, at: Date | 'now()' = 'now()'): string {
	const now = at === 'now()' ? 'now()' : `'${at.toISOString()}'::timestamptz`
	return HELD_SQL_TEMPLATE.replaceAll('{d}', row).replaceAll('{now}', now)
}

/** HH:MM in UTC. */
export function utcClock(at: Date | string): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: 'UTC',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(new Date(at))
}

/** How the note of a held row starts (the claim drops that line from the output). */
export const SETTLE_WAITING_PREFIX = 'waiting until '

/** The one text a held row shows (UI, API, deploy output). */
export function settleNoteFor(notBefore: Date | string): string {
	return `${SETTLE_WAITING_PREFIX}${utcClock(notBefore)} UTC to bundle further pushes; "redeploy now" or a commit with [urgent] skips the wait`
}

/** Display only: the note for a queued row whose not_before is still ahead, else null.
 *  (Decisions use heldSql; a row whose window was switched off is claimed within seconds.) */
export function settleNote(
	row: { status: string; notBefore?: Date | string | null },
	now: Date = new Date(),
): string | null {
	if (row.status !== 'queued' || !row.notBefore) return null
	return new Date(row.notBefore).getTime() > now.getTime() ? settleNoteFor(row.notBefore) : null
}
