// Marks deploys that have been "running" for too long as failed, releasing the
// in-flight lock (the partial unique index on (server_id, container_name)).
// A deploy can get stuck in running when SSH disconnects mid-build: the runner
// hangs without throwing, finishDeploy never runs, and the row stays running
// forever — the dashboard shows fake "deploying…" AND the lock blocks the next
// real deploy.

import { and, db, deploys, eq, or, sql } from './db'
import { HARD_CAP_MIN, HEARTBEAT_STALE_MIN, STUCK_AFTER_MIN } from './deploy-budget'
import { reportSwapCheckLeftoverToHq } from './hq'
import { listAllServers } from './servers'
import { runCommand } from './ssh'

// A swap-check candidate (`<app>-next`, label powder.candidate=1) lives for
// seconds to ~1 minute; one older than this was leaked by a killed deploy.
const CANDIDATE_LEFTOVER_MIN = 30

/** Parse `name|age-seconds` lines from the server probe into leftover names. Pure. */
export function parseLeftoverCandidates(stdout: string, minAgeMin = CANDIDATE_LEFTOVER_MIN): string[] {
	const out: string[] = []
	for (const line of stdout.split('\n')) {
		const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\|(\d+)$/)
		if (m && Number(m[2]) > minAgeMin * 60) out.push(m[1] ?? '')
	}
	return out
}

// Every watchdog tick: one SSH per server listing candidate containers and their
// age. Emits one deduped `swap-check leftover` card per server (resolved when clean).
export async function checkLeftoverCandidates(): Promise<void> {
	const servers = await listAllServers()
	await Promise.all(
		servers.map(async (server) => {
			try {
				const { stdout, code } = await runCommand(
					server,
					`now=$(date +%s); for id in $(docker ps -aq --filter label=powder.candidate=1 2>/dev/null); do n=$(docker inspect -f '{{.Name}}' "$id" | sed 's#^/##'); c=$(date -d "$(docker inspect -f '{{.Created}}' "$id")" +%s 2>/dev/null || echo "$now"); echo "$n|$((now - c))"; done`,
					20_000,
				)
				if (code !== 0) return
				await reportSwapCheckLeftoverToHq(server.id, server.name, parseLeftoverCandidates(stdout))
			} catch {
				// unreachable server: the uptime/server checks own that signal
			}
		}),
	)
}

// Executor-liveness reap (0035): the process running a deploy stamps
// deploys.heartbeat_at every 30s (deploy-runner). A stamp older than this means
// that process is gone (crash, restart, OOM) — reap within minutes, regardless
// of how long the deploy has legitimately been running.
// (HEARTBEAT_STALE_MIN, HARD_CAP_MIN and STUCK_AFTER_MIN live in deploy-budget.ts,
// next to the budget constants they must stay ordered with.)
// Hard cap for heartbeating rows. MUST stay above the deploy's own deadline
// chain — script budget (DEPLOY_BUDGET_SEC, 55m) + outer timeout + SSH wall
// (~57.5m) — so the executor's timeout always fires first and reports the
// failure itself; at equal limits the two raced (reap released the lock while
// the SSH session was still alive → resurrect/double-deploy).
// Rows with NO heartbeat (inline routes: first deploy, rollback, restart; or a
// pre-0035 executor): elapsed-time backstop, above the same 57.5m SSH wall.
// Early-silence: a healthy deploy emits step banners ("git pull", "docker
// compose pull/build") within seconds. Zero persisted output after this long
// means the SSH session wedged before doing anything — reap fast so the lock
// frees in minutes, not a quarter hour. `output` stays NULL until the runner's
// first debounce-flush, so NULL/'' is a reliable "produced nothing yet" signal.
const SILENT_AFTER_MIN = 5
// 'queued' rows the worker never claims (worker down/wedged, or a server
// permanently excluded from the claim set) hold the queued slot FOREVER —
// every later push folds into a row that never runs. Generous threshold: a
// queued row legitimately waits behind the app's own running deploy plus a
// couple of serialized builds on the server (each capped at ~57m), and an HQ receiver's
// reconciliation sweep may already warn; this reap is the release valve.
const QUEUED_STUCK_AFTER_MIN = 180

/** WHERE clause of the running-row reap. Exported for tests. The no-output rule
 *  ignores a row whose executor heartbeat is fresh: in in-web mode a
 *  deploy can wait in runOnServer behind another app's build with output still
 *  NULL while perfectly alive. */
export function runningReapCondition() {
	return and(
		eq(deploys.status, 'running'),
		or(
			sql`${deploys.heartbeatAt} IS NOT NULL AND ${deploys.heartbeatAt} < now() - (${HEARTBEAT_STALE_MIN} * interval '1 minute')`,
			sql`${deploys.heartbeatAt} IS NOT NULL AND ${deploys.startedAt} < now() - (${HARD_CAP_MIN} * interval '1 minute')`,
			sql`${deploys.heartbeatAt} IS NULL AND ${deploys.startedAt} < now() - (${STUCK_AFTER_MIN} * interval '1 minute')`,
			sql`(${deploys.output} IS NULL OR ${deploys.output} = '') AND ${deploys.startedAt} < now() - (${SILENT_AFTER_MIN} * interval '1 minute') AND (${deploys.heartbeatAt} IS NULL OR ${deploys.heartbeatAt} < now() - (${HEARTBEAT_STALE_MIN} * interval '1 minute'))`,
		),
	)
}

export async function reapStuckDeploys(): Promise<void> {
	const result = await db
		.update(deploys)
		.set({
			status: 'failed',
			finishedAt: new Date(),
			error: `[watchdog] deploy stuck in running (executor heartbeat >${HEARTBEAT_STALE_MIN}m stale, >${HARD_CAP_MIN}m elapsed, >${STUCK_AFTER_MIN}m without a heartbeat, or >${SILENT_AFTER_MIN}m with no output) — executor died or SSH wedged; lock released`,
		})
		.where(runningReapCondition())
		.returning({ id: deploys.id, containerName: deploys.containerName })

	if (result.length > 0) {
		console.warn(
			`[deploy-watchdog] reaped ${result.length} stuck deploys:`,
			result.map((r) => `${r.containerName}/${r.id}`).join(', '),
		)
	}

	const queuedReaped = await db
		.update(deploys)
		.set({
			status: 'failed',
			finishedAt: new Date(),
			error: `[watchdog] deploy stuck in queued (>${QUEUED_STUCK_AFTER_MIN}m, worker never claimed it) — lock released`,
		})
		.where(
			and(
				eq(deploys.status, 'queued'),
				sql`${deploys.startedAt} < now() - (${QUEUED_STUCK_AFTER_MIN} * interval '1 minute')`,
			),
		)
		.returning({ id: deploys.id, containerName: deploys.containerName })

	if (queuedReaped.length > 0) {
		console.warn(
			`[deploy-watchdog] reaped ${queuedReaped.length} never-claimed queued deploys:`,
			queuedReaped.map((r) => `${r.containerName}/${r.id}`).join(', '),
		)
	}
}
