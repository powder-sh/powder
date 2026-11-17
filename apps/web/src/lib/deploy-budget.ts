// ONE place for every deploy time constant. They must stay ordered:
//
//   DEPLOY_BUDGET_SEC            total wall clock for a deploy, counted from the
//                                claim time (deploys.started_at). Builder phase
//                                AND deploy script both draw from it.
//   + DEPLOY_OUTER_GRACE_SEC     outer `timeout` sits just above the budget
//   + TIMEOUT_KILL_SEC           `timeout -k` escalates to SIGKILL after this
//   + SSH_WALL_SLACK_SEC         the SSH wall sits above the kill
//   = deployChainMaxSec()        the longest a live deploy can legitimately run
//   < STUCK_AFTER_MIN            elapsed backstop for rows with no heartbeat
//   < HARD_CAP_MIN               watchdog hard cap for heartbeating rows
//   < compose stop_grace_period  (docker-compose.yml, worker) 80m
//
// deploy-budget.test.ts enforces the ordering, so changing one constant without
// the others fails a test instead of reaping a live deploy.

/** Total budget for one deploy (builder phase + deploy script), from claim time. */
export const DEPLOY_BUDGET_SEC = 55 * 60
/** The outer `timeout` runs this long after the in-script DEADLINE. */
const DEPLOY_OUTER_GRACE_SEC = 60
/** `timeout -k`: seconds between SIGTERM and SIGKILL. */
export const TIMEOUT_KILL_SEC = 30
/** The SSH wall-clock sits this far above the SIGKILL. */
const SSH_WALL_SLACK_SEC = 90
/** Seconds kept back for the deploy script when the builder phase is budgeted
 *  (a builder failure falls back to a local build that still needs time). */
export const BUILDER_SCRIPT_RESERVE_SEC = 10 * 60
/** Floor so a nearly-spent budget still yields a usable positive timeout. */
const MIN_PHASE_BUDGET_SEC = 60
/** Image stream builder -> target never runs longer than this. */
export const IMAGE_STREAM_MAX_MS = 20 * 60 * 1000

/** Executor-liveness reap: a heartbeat older than this means the process died. */
export const HEARTBEAT_STALE_MIN = 3
/** Watchdog hard cap for heartbeating rows. Must exceed deployChainMaxSec(). */
export const HARD_CAP_MIN = 75
/** Elapsed backstop for rows with no heartbeat (inline routes). Must exceed deployChainMaxSec(). */
export const STUCK_AFTER_MIN = 60
/** The worker's compose stop_grace_period (docker-compose.yml), minutes. */
export const WORKER_STOP_GRACE_MIN = 80

/** `timeout` value wrapping a script that was given `budgetSec`. */
export function outerTimeoutSec(budgetSec: number): number {
	return budgetSec + DEPLOY_OUTER_GRACE_SEC
}

/** SSH wall-clock (ms) for a command wrapped in outerTimeoutSec(budgetSec). */
export function sshWallMs(budgetSec: number): number {
	return (outerTimeoutSec(budgetSec) + TIMEOUT_KILL_SEC + SSH_WALL_SLACK_SEC) * 1000
}

/** Longest a live deploy can run end to end (budget + outer timeout chain). */
export function deployChainMaxSec(): number {
	return DEPLOY_BUDGET_SEC + DEPLOY_OUTER_GRACE_SEC + TIMEOUT_KILL_SEC + SSH_WALL_SLACK_SEC
}

/** Seconds left of the single deploy budget, given the absolute deadline (ms
 *  epoch). No deadline = the full budget. Never below MIN_PHASE_BUDGET_SEC. */
export function remainingBudgetSec(deadlineAtMs: number | null | undefined, nowMs = Date.now()): number {
	if (!deadlineAtMs) return DEPLOY_BUDGET_SEC
	return Math.max(MIN_PHASE_BUDGET_SEC, Math.floor((deadlineAtMs - nowMs) / 1000))
}

/** The one deadline for a deploy: claim time + DEPLOY_BUDGET_SEC (ms epoch). */
export function deployDeadlineAt(claimedAt: Date | string | number): number {
	return new Date(claimedAt).getTime() + DEPLOY_BUDGET_SEC * 1000
}

/** The deploy budget is already spent (deadline reached or passed). remainingBudgetSec
 *  floors at MIN_PHASE_BUDGET_SEC so a phase never gets a zero timeout, which alone would
 *  let a deploy whose budget is gone (long wait for the server slot) start anyway. */
export function budgetExhausted(deadlineAtMs: number | null | undefined, nowMs = Date.now()): boolean {
	return !!deadlineAtMs && deadlineAtMs - nowMs <= 0
}
