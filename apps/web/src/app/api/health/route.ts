// Liveness + readiness probe. UNAUTHENTICATED on purpose so an external monitor
// (an uptime monitor) can watch it and alert when powder is unhealthy.
//
// Three failure modes it catches:
//   1. DB unreachable — SELECT 1 throws.
//   2. In-process cron scheduler dead — the 60s heartbeat goes stale. This is
//      the "watcher-of-the-watcher": instead of checking cron last_run_at by
//      hand after a deploy, a stale heartbeat answers 503.
//   3. Deploy-claim loop wedged (worker mode only) — the claim loop runs on its
//      own timer in the worker process, independent of the cron scheduler. It
//      once died silently while crons kept ticking, so the scheduler heartbeat
//      alone couldn't catch it. Its heartbeat going stale is now a 503 too.
//
// Returns 200 only when DB is reachable AND both heartbeats are fresh (the claim
// heartbeat is only required when the worker is enabled). 503 otherwise.
// The public body is only
// {status}, same HTTP code (an uptime monitor reads nothing else). The detail
// (version, db, scheduler owner + ticks, claim loop) is for an authenticated admin
// (session or API token) and callers inside powder's container (the entrypoint's
// probe of 127.0.0.1:3000, see isLoopbackRequest; bin/self-deploy.sh only needs status). The public-site host never gets it.

import { getClaimLoopHealth, getSchedulerHealth } from '@/lib/cron-scheduler'
import { db, sql } from '@/lib/db'
import { deployWorkerEnabled } from '@/lib/deploys'
import { isLoopbackRequest, isSiteHostRequest } from '@/lib/hosts'

/** Detail for on-server callers and a signed-in admin; never on the public-site host. */
async function mayReadDetail(request: Request): Promise<boolean> {
	if (isSiteHostRequest(request.headers)) return false
	if (isLoopbackRequest(request.headers)) return true
	try {
		const { getCurrentUser } = await import('@/lib/access')
		const u = await getCurrentUser()
		return !!u?.isAdmin
	} catch {
		return false
	}
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Cron ticks every 60s. Allow 3 missed ticks before we call the scheduler dead,
// so a single slow/skipped tick doesn't flap the probe.
const HEARTBEAT_STALE_MS = 180_000

export async function GET(request: Request) {
	let dbOk = false
	try {
		await db.execute(sql`SELECT 1`)
		dbOk = true
	} catch {
		dbOk = false
	}

	// Read from the DB heartbeat rows — the scheduler + claim loop run in the
	// deploy-worker process, so this is how web (a different process) sees them.
	const sched = await getSchedulerHealth()
	// Fresh if it has ticked at least once and the last tick is within the window.
	const schedulerFresh =
		sched.started && sched.staleMs !== null && sched.staleMs < HEARTBEAT_STALE_MS

	// The claim loop only exists when the worker is enabled. In in-web mode
	// (POWDER_DEPLOY_WORKER off) deploys run in the web request and there is no loop to watch, so
	// a missing/stale claim heartbeat must NOT fail the probe.
	const workerOn = deployWorkerEnabled()
	const claim = workerOn ? await getClaimLoopHealth() : null
	const claimFresh =
		!workerOn ||
		(claim?.started === true && claim.staleMs !== null && claim.staleMs < HEARTBEAT_STALE_MS)

	const healthy = dbOk && schedulerFresh && claimFresh
	if (!(await mayReadDetail(request))) {
		return Response.json({ status: healthy ? 'ok' : 'degraded' }, { status: healthy ? 200 : 503 })
	}

	return Response.json(
		{
			status: healthy ? 'ok' : 'degraded',
			version: process.env.NEXT_PUBLIC_POWDER_VERSION ?? null,
			db: dbOk,
			scheduler: {
				started: sched.started,
				owner: sched.owner,
				lastTickAt: sched.lastTickAt?.toISOString() ?? null,
				staleSeconds: sched.staleMs === null ? null : Math.round(sched.staleMs / 1000),
			},
			claimLoop: workerOn
				? {
						started: claim?.started ?? false,
						owner: claim?.owner ?? null,
						lastTickAt: claim?.lastTickAt?.toISOString() ?? null,
						staleSeconds: claim?.staleMs == null ? null : Math.round(claim.staleMs / 1000),
					}
				: 'in-web',
		},
		{ status: healthy ? 200 : 503 },
	)
}
