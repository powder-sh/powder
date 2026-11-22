// What a deploy the watchdog ended says about itself: the failed step and the one-line
// summary written to the row (the deploy page's failure banner needs the summary), sent
// in the failure event and posted to GitHub. Pure, so it can be tested and read anywhere.
//
// The conditions mirror runningReapCondition (lib/deploy-watchdog.ts), in the same order;
// the reap itself is decided in SQL, this only words the row it already reaped.

import { HARD_CAP_MIN, HEARTBEAT_STALE_MIN, STUCK_AFTER_MIN } from './deploy-budget'

/** failed_step of a running deploy the watchdog stopped: whether it got to the swap is
 *  unknown (lib/deploy-swap.ts treats it so). */
export const WATCHDOG_STOPPED_STEP = 'watchdog'
/** failed_step of a queued deploy no worker ever claimed: nothing ran. */
export const NEVER_CLAIMED_STEP = 'queue'

/** No persisted output after this long (and no fresh heartbeat) reaps a running row. */
export const SILENT_AFTER_MIN = 5
/** A queued row no worker claims after this long is reaped. */
export const QUEUED_STUCK_AFTER_MIN = 180

// The exact notes the reap writes into the error column, in the reap statement itself. The
// late-result path recognises a reaped row by these whole texts, never by a prefix a deploy's
// own log could print. (U+2014 is written as an escape: the stored text is unchanged.)
const DASH = '\u2014'
export const RUNNING_REAP_NOTE = `[watchdog] deploy stuck in running (executor heartbeat >${HEARTBEAT_STALE_MIN}m stale, >${HARD_CAP_MIN}m elapsed, >${STUCK_AFTER_MIN}m without a heartbeat, or >${SILENT_AFTER_MIN}m with no output) ${DASH} executor died or SSH wedged; lock released`
export const QUEUED_REAP_NOTE = `[watchdog] deploy stuck in queued (>${QUEUED_STUCK_AFTER_MIN}m, worker never claimed it) ${DASH} lock released`

/** `error` holds a reap note: exactly one, or one followed by the late-result lines the
 *  runner appends after it. Pure. */
export function isReapNote(error: string | null | undefined): boolean {
	if (!error) return false
	return [RUNNING_REAP_NOTE, QUEUED_REAP_NOTE].some((n) => error === n || error.startsWith(`${n}\n`))
}

type When = Date | string | null | undefined

export interface ReapedFacts {
	/** true for a queued row (never claimed), false for a running one */
	queued: boolean
	heartbeatAt?: When
	startedAt?: When
	queuedAt?: When
	/** the row had persisted output when it was reaped */
	hadOutput?: boolean
}

const minutesSince = (t: When, now: number): number | null =>
	t ? Math.max(0, Math.floor((now - new Date(t).getTime()) / 60_000)) : null

const mins = (n: number) => `${n} minute${n === 1 ? '' : 's'}`

/** The step and summary for a reaped row. Pure. */
export function watchdogReapReason(r: ReapedFacts, now: number = Date.now()): { failedStep: string; summary: string } {
	if (r.queued) {
		const waited = minutesSince(r.queuedAt ?? r.startedAt, now) ?? QUEUED_STUCK_AFTER_MIN
		return {
			failedStep: NEVER_CLAIMED_STEP,
			summary: `never started: queued for ${mins(waited)} and no deploy worker claimed it (is the worker running?); nothing was built or changed`,
		}
	}
	const sinceBeat = minutesSince(r.heartbeatAt, now)
	const running = minutesSince(r.startedAt, now)
	// the cause suffix only where the deploy went silent: a hard-cap row still heartbeats
	const silent = ' (the process running it died or its SSH session hung)'
	let what: string
	if (sinceBeat !== null && sinceBeat >= HEARTBEAT_STALE_MIN) {
		what = `no heartbeat for ${mins(sinceBeat)}${silent}`
	} else if (sinceBeat !== null && running !== null && running >= HARD_CAP_MIN) {
		what = `it ran for ${mins(running)}, past the ${HARD_CAP_MIN}-minute limit, and was stopped`
	} else if (sinceBeat === null && running !== null && running >= STUCK_AFTER_MIN) {
		what = `no heartbeat and no result after ${mins(running)}${silent}`
	} else if (!r.hadOutput) {
		what = `no output for ${mins(running ?? SILENT_AFTER_MIN)}${silent}`
	} else {
		what = `the deploy stopped reporting${silent}`
	}
	return { failedStep: WATCHDOG_STOPPED_STEP, summary: `stopped by the watchdog: ${what}` }
}
