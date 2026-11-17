// Powder deploy worker — a process SEPARATE from the Next.js web server.
//
// Why this exists: a deploy run as a fire-and-forget async task INSIDE the web
// process dies with it. A web restart (notably a powder self-deploy recreating
// the `powder` container) would kill any in-flight deploy mid-`docker compose up`,
// leaving the target container stuck in Created → 502. With execution here a
// powder self-deploy only ever recreates `powder` (+ web), never this worker, so
// an app deploy cannot be SIGKILLed out from under itself by a powder redeploy.
//
// No Redis / no external queue: the `deploys` table IS the queue. Web enqueues
// 'queued' rows; this worker atomically claims them (FOR UPDATE SKIP LOCKED, in
// claimNextQueuedDeploy) and flips them to 'running' before executing. One
// deploy per server at a time (different servers run in parallel): the
// per-server build serialization keeps a server from OOMing on
// parallel `next build`s.
//
// The worker also OWNS the cron/uptime/backup/watchdog scheduler — see
// instrumentation.ts, where web skips startCronScheduler when the flag is on so
// the two processes don't both tick.
//
// Gated by POWDER_DEPLOY_WORKER: when unset the worker idles (web runs deploys
// itself and owns the scheduler: in-web mode), so this one setting moves deploys and the
// scheduler between the two processes.
//
// The claim loop must not wedge silently. A claim await can hang rather than
// throw (on a connection-starved pool postgres.js queues the query client-side
// and never sends it, so it is invisible in pg_stat_activity); a hung await is
// not caught by try/finally, so `claiming` would stay true, scheduleClaim's
// .finally would never re-fire, and the loop would stop while crons (a separate
// timer) keep ticking. Three independent defenses keep that from persisting:
//   1. Every claim await is wrapped in withTimeout → a hang becomes a caught
//      rejection, the loop recovers on the next tick.
//   2. An independent self-heal timer re-arms the loop if it ever stops firing,
//      and stamps a DB heartbeat so /api/health can see the claim loop (not just
//      the cron scheduler) cross-process.
//   3. Global uncaughtException / unhandledRejection handlers + a startup
//      try/catch guarantee no error is ever swallowed: fatal → exit(1) → compose
//      restarts clean (fresh DB pool); non-fatal → logged loud.
// Pool-level statement_timeout / idle_in_transaction_session_timeout (see
// packages/db/src/client.ts) is the fourth layer: it frees a stuck connection
// server-side so the starvation does not persist.

import { claimWithLateDispatch } from './lib/claim-late'
import { stampClaimHeartbeat, startCronScheduler, stopCronScheduler } from './lib/cron-scheduler'
import { unhandledRejectionLogValue } from './lib/deploy-failure'
import { executeDeploy } from './lib/deploy-runner'
import { claimNextQueuedDeploy, deployWorkerEnabled, requeueClaimedDeploy } from './lib/deploys'
import { restoreFirstRunAdmin } from './lib/first-run'
import { waitForSchema } from './lib/migration-wait'
import { warnIfHostKeyChecksDisabled } from './lib/ssh-host-keys'
import { assertProductionConfig, startupWarnings } from './lib/startup-checks'
import { makeDispatch } from './lib/worker-dispatch'

// Normal claim cadence — fast, so a freshly-queued deploy starts within ~2s.
const CLAIM_INTERVAL_MS = 2_000
// A claim transaction is sub-second in health. If it hasn't settled in 30s the
// pool is starved or the query is stuck — treat it as failed and recover the
// loop rather than blocking on it forever. (The pool's own statement_timeout is
// 120s; this loop-level bound recovers the LOOP much sooner than that.)
const CLAIM_TIMEOUT_MS = 30_000
// Self-heal cadence. Cheap: in-memory liveness check + one heartbeat upsert.
const SELF_HEAL_INTERVAL_MS = 15_000
// If the claim loop hasn't even ATTEMPTED a claim in this long, its scheduling
// chain is presumed dead (should be impossible now that claims always settle,
// but this is the belt-and-suspenders backstop) → force-reset and re-arm.
const CLAIM_STALL_MS = 90_000

// Servers with a deploy currently running in THIS worker — excluded from the
// next claim so each server runs at most one deploy at a time.
const inFlightServers = new Set<string>()
// Every in-flight deploy promise — awaited on SIGTERM so we drain before exit.
const inFlightDeploys = new Set<Promise<void>>()

let draining = false
let claiming = false
let claimTimer: NodeJS.Timeout | null = null
let selfHealTimer: NodeJS.Timeout | null = null
// Wall-clock of the most recent claim ATTEMPT. The self-heal timer watches this
// to detect a wedged loop, and the heartbeat row mirrors it so /api/health sees
// staleness cross-process. Initialised to now so a slow boot doesn't trip it.
let lastClaimAttemptAt = Date.now()
let selfHealCount = 0

// Reject if `p` doesn't settle within `ms`. The underlying promise is left to
// settle on its own (we can't cancel an in-flight DB query), but we do not
// AWAIT it, so a hang can't block the caller. One orphaned pending claim at a
// time, max (the `claiming` guard serialises them), so they can't pile up.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
		p.then(
			(v) => {
				clearTimeout(t)
				resolve(v)
			},
			(e) => {
				clearTimeout(t)
				reject(e)
			},
		)
	})
}

const dispatch = makeDispatch({
	isDraining: () => draining,
	execute: executeDeploy,
	requeue: requeueClaimedDeploy,
	inFlightServers,
	inFlightDeploys,
})

// Drain everything claimable this tick: keep claiming rows for not-busy servers,
// dispatching each WITHOUT awaiting it, until no claimable row remains. The
// `claiming` guard prevents the initial kick and the interval from overlapping.
async function claimAndDispatch(): Promise<void> {
	if (draining || claiming) return
	claiming = true
	try {
		for (;;) {
			if (draining) return
			lastClaimAttemptAt = Date.now()
			const deploy = await claimWithLateDispatch(
				claimNextQueuedDeploy([...inFlightServers]),
				CLAIM_TIMEOUT_MS,
				'claimNextQueuedDeploy',
				// A claim that commits AFTER the timeout must still execute: the row is
				// already 'running' and nothing else would run it.
				dispatch,
			).catch((err) => {
				// A THROW or a TIMEOUT both land here. Log loud, return null to end
				// this pass cleanly, and let scheduleClaim's .finally re-arm the next
				// tick. This is the line that makes a hung claim non-fatal.
				console.error('[worker] claim failed (will retry next tick):', err)
				return null
			})
			if (!deploy) return
			dispatch(deploy)
		}
	} finally {
		claiming = false
	}
}

// Idempotent: always clears any existing timer before arming a new one, so the
// self-heal re-arm and scheduleClaim's own .finally re-arm can never leave two
// overlapping timers racing.
function scheduleClaim(): void {
	if (claimTimer) clearTimeout(claimTimer)
	claimTimer = setTimeout(() => {
		claimTimer = null
		void claimAndDispatch()
			.catch((err) => console.error('[worker] claim pass failed:', err))
			.finally(() => {
				if (!draining) scheduleClaim()
			})
	}, CLAIM_INTERVAL_MS)
}

// Independent watchdog timer — NOT chained off the claim loop, so it survives
// even if the claim loop somehow dies. Does only in-memory work before any
// await, so a hung DB write can't stop it detecting/fixing a stall.
function selfHealTick(): void {
	if (draining) return
	const sinceAttempt = Date.now() - lastClaimAttemptAt
	if (sinceAttempt > CLAIM_STALL_MS) {
		selfHealCount++
		console.error(
			`[worker] SELF-HEAL #${selfHealCount}: claim loop has not attempted in ${Math.round(
				sinceAttempt / 1000,
			)}s — forcing reset and re-arming`,
		)
		claiming = false
		scheduleClaim() // clears the stale timer + arms a fresh one
		void claimAndDispatch().catch((err) => console.error('[worker] claim pass failed:', err)) // immediate kick so we don't wait a full interval
	}
	// Stamp the claim heartbeat (fire-and-forget, timeout-bounded). Uses
	// lastClaimAttemptAt — NOT now() — so the row reflects the claim loop's
	// liveness, not this timer's. A wedged loop → frozen lastClaimAttemptAt →
	// stale row → /api/health 503, even though this timer keeps stamping.
	void withTimeout(
		stampClaimHeartbeat(true, new Date(lastClaimAttemptAt)),
		CLAIM_TIMEOUT_MS,
		'stampClaimHeartbeat',
	).catch((err) => console.error('[worker] claim heartbeat write failed:', err))
}

// Graceful drain: stop claiming new work, stop the scheduler, then let the
// deploys already running finish before exit. compose `stop_grace_period`
// bounds how long the orchestrator waits before SIGKILL — keep it >= the
// slowest expected build so a deploy is never severed mid-flight.
async function shutdown(signal: string): Promise<void> {
	if (draining) return
	draining = true
	console.log(`[worker] ${signal} received — draining ${inFlightDeploys.size} in-flight deploy(s)`)
	if (claimTimer) clearTimeout(claimTimer)
	if (selfHealTimer) clearInterval(selfHealTimer)
	stopCronScheduler()
	void stampClaimHeartbeat(false, new Date()).catch(() => {})
	// Loop: a late claim that lands while we drain registers a requeue; await those too.
	while (inFlightDeploys.size > 0) await Promise.allSettled([...inFlightDeploys])
	console.log('[worker] drain complete — exiting')
	process.exit(0)
}

async function main(): Promise<void> {
	if (!deployWorkerEnabled()) {
		// Flag off (in-web mode): web owns the scheduler and runs deploys. Stay alive (so
		// compose doesn't restart-loop us) but do nothing. Clear any stale claim
		// heartbeat so /api/health (which gates on the flag too) isn't confused by
		// a leftover row from a previous worker-on period.
		console.log(
			'[worker] POWDER_DEPLOY_WORKER is not 1, true, yes or on - idling (in-web mode: the web process runs deploys)',
		)
		void stampClaimHeartbeat(false, new Date()).catch(() => {})
		setInterval(() => {}, 1 << 30)
		return
	}

	console.log('[worker] starting — owns cron scheduler + deploy queue')
	assertProductionConfig()
	// The worker runs the backups: say it here too if the passphrase is weak.
	for (const w of startupWarnings()) console.warn(`[worker] WARNING: ${w}`)
	warnIfHostKeyChecksDisabled()
	// powder and the worker start together, but only powder applies the schema
	// (its entrypoint's pre phase, before it serves). Wait for it, bounded
	// (lib/migration-wait.ts), so new code never claims a deploy on the old schema.
	await waitForSchema()
	if (draining) return
	// The backup scheduler picks GitHub tokens of admins: know the stored first-run
	// one (or, with POWDER_ADMIN_USER_IDS set, delete it).
	void restoreFirstRunAdmin()
	startCronScheduler('worker')
	lastClaimAttemptAt = Date.now()
	// Stamp immediately so /api/health sees a fresh claim heartbeat from t=0,
	// rather than 503-ing for the ~15s until the first self-heal tick stamps it.
	void stampClaimHeartbeat(true, new Date()).catch(() => {})
	scheduleClaim()
	selfHealTimer = setInterval(selfHealTick, SELF_HEAL_INTERVAL_MS)
	// Kick an immediate claim so a deploy queued while the worker was down runs
	// right away instead of waiting a full interval.
	void claimAndDispatch().catch((err) => console.error('[worker] claim pass failed:', err))
}

// No swallowed errors: a fatal uncaught error means a clean exit so the
// supervisor (compose) restarts the worker with a fresh DB pool; an unhandled rejection
// could be a transient best-effort task, so log it loud but stay up.
process.on('uncaughtException', (err) => {
	console.error('[worker] FATAL uncaughtException — exiting for a clean restart:', err)
	process.exit(1)
})
process.on('unhandledRejection', (reason) => {
	console.error(
		'[worker] unhandledRejection (logged, not exiting):',
		unhandledRejectionLogValue(reason),
	)
})

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

main().catch((err) => {
	console.error('[worker] FATAL during startup — exiting for a clean restart:', err)
	process.exit(1)
})
