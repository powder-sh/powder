// Marks deploys that have been "running" for too long as failed, releasing the
// in-flight lock (the partial unique index on (server_id, container_name)).
// A deploy can get stuck in running when SSH disconnects mid-build: the runner
// hangs without throwing, finishDeploy never runs, and the row stays running
// forever — the dashboard shows fake "deploying…" AND the lock blocks the next
// real deploy.

import { and, db, deploys, eq, or, sql } from './db'
import { HARD_CAP_MIN, HEARTBEAT_STALE_MIN, STUCK_AFTER_MIN } from './deploy-budget'
import { deployCommit } from './deploy-commit'
import { QUEUED_REAP_NOTE, QUEUED_STUCK_AFTER_MIN, RUNNING_REAP_NOTE, SILENT_AFTER_MIN, watchdogReapReason } from './deploy-watchdog-reason'
import { reportDeployToHq, reportSwapCheckLeftoverToHq } from './hq'
import { opsEventFailureFields } from './deploy-failure'
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
// (SILENT_AFTER_MIN and QUEUED_STUCK_AFTER_MIN live in deploy-watchdog-reason.ts, which
// words each reaped row from the same limits.)
// 'queued' rows the worker never claims (worker down/wedged, or a server
// permanently excluded from the claim set) hold the queued slot FOREVER —
// every later push folds into a row that never runs. Generous threshold: a
// queued row legitimately waits behind the app's own running deploy plus a
// couple of serialized builds on the server (each capped at ~57m), and an HQ receiver's
// reconciliation sweep may already warn; this reap is the release valve.

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
			error: RUNNING_REAP_NOTE,
		})
		.where(runningReapCondition())
		.returning(reapedColumns())

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
			error: QUEUED_REAP_NOTE,
		})
		.where(
			and(
				eq(deploys.status, 'queued'),
				sql`${deploys.startedAt} < now() - (${QUEUED_STUCK_AFTER_MIN} * interval '1 minute')`,
			),
		)
		.returning(reapedColumns())

	if (queuedReaped.length > 0) {
		console.warn(
			`[deploy-watchdog] reaped ${queuedReaped.length} never-claimed queued deploys:`,
			queuedReaped.map((r) => `${r.containerName}/${r.id}`).join(', '),
		)
	}

	const reaped: Reaped[] = [
		...result.map((r) => withReason({ ...r, claimed: true })),
		...queuedReaped.map((r) => withReason({ ...r, claimed: false })),
	]
	if (reaped.length === 0) return
	// After both reaps (the lock is already released): say what happened on each row, and
	// send the failure event a normal failure sends, once per reaped row (a reap flips a row
	// only once). A late failure from an executor that was alive after all does not send a
	// second one (deploy-runner failDeploy).
	await recordReapReasons(reaped)
	for (const r of reaped) reportReapToHq(r)
	// GitHub only after both reaps are written: a slow or hung GitHub never delays a reap.
	// A queued row was never claimed: no commit status was pending, only its Deployment is closed.
	await closeOnGithub(reaped)
}

function withReason(r: Omit<Reaped, 'failedStep' | 'summary'>): Reaped {
	const reason = watchdogReapReason({
		queued: !r.claimed,
		heartbeatAt: r.heartbeatAt,
		startedAt: r.startedAt,
		queuedAt: r.queuedAt,
		hadOutput: r.hadOutput,
	})
	return { ...r, ...reason }
}

/** failed_step and error_summary of each reaped row (the deploy page's failure banner
 *  needs the summary). Guarded: a row a late success already flipped back is left alone.
 *  Best effort, never throws. */
async function recordReapReasons(rows: Reaped[]): Promise<void> {
	const { redactSecrets } = await import('./secret-text')
	await Promise.allSettled(
		rows.map(async (r) => {
			try {
				await db
					.update(deploys)
					.set({ failedStep: r.failedStep, errorSummary: redactSecrets(r.summary) })
					.where(and(eq(deploys.id, r.id), eq(deploys.status, 'failed'), sql`${deploys.errorSummary} IS NULL`))
			} catch (err) {
				console.error(`[deploy-watchdog] reason for ${r.id} not recorded:`, err instanceof Error ? err.message : err)
			}
		}),
	)
}

/** The failure event of a reaped row, the same shape the deploy runner sends. Never throws. */
function reportReapToHq(r: Reaped): void {
	const commit = deployCommit(r)
	// what the reap recorded on the row (watchdogReapReason): the event's step and summary
	const failedStep = r.failedStep
	const summary = r.summary
	void import('./secret-text')
		.then(({ redactSecrets }) => {
			const errorText = redactSecrets(summary)
			return reportDeployToHq({
				app: r.containerName,
				server: r.serverId,
				status: 'failure',
				sha: commit?.sha ?? null,
				shaSource: commit ? (commit.requested ? 'requested' : 'built') : null,
				branch: r.gitBranch,
				// `failed during: watchdog · <why>` (or `queue`), plus failedStep: the same
				// event shape as the runner's (deploy-failure.ts opsEventFailureFields)
				...opsEventFailureFields(failedStep, null, errorText),
				deployId: r.id,
				deployKind: r.kind,
			})
		})
		.catch((err) => console.error(`[deploy-watchdog] failure event (${failedStep}) not sent:`, err instanceof Error ? err.message : err))
}

/** The columns a reap returns (exported for tests). */
export function reapedColumns() {
	return {
		id: deploys.id,
		serverId: deploys.serverId,
		containerName: deploys.containerName,
		kind: deploys.kind,
		gitSha: deploys.gitSha,
		// no built_sha (0070): the reap must not depend on a newer column, or a deferred
		// migration would fail it and leave rows running with their locks held. At reap time
		// it is NULL or equal to git_sha anyway.
		gitBranch: deploys.gitBranch,
		requestedSha: deploys.requestedSha,
		heartbeatAt: deploys.heartbeatAt,
		startedAt: deploys.startedAt,
		queuedAt: deploys.queuedAt,
		hadOutput: sql<boolean>`(${deploys.output} IS NOT NULL AND ${deploys.output} <> '')`,
	}
}

type Reaped = {
	id: string
	serverId: string
	containerName: string
	kind: string
	gitSha: string | null
	gitBranch?: string | null
	requestedSha: string | null
	heartbeatAt?: Date | string | null
	startedAt?: Date | string | null
	queuedAt?: Date | string | null
	hadOutput?: boolean
	claimed: boolean
	/** what happened, from watchdogReapReason (deploy-watchdog-reason.ts) */
	failedStep: string
	summary: string
}

/** Overall time the watchdog waits for the GitHub closes of one tick. Each call has its
 *  own limit too (github.ts); what is still running after this goes on in the background. */
export const WATCHDOG_GITHUB_CLOSE_MS = 10_000

/** A reaped row never reaches the runner's own exit, so its GitHub Deployment
 *  (and, for a claimed git deploy, its commit status) would stay in progress
 *  forever: close them as failed, all rows in parallel, waiting at most
 *  `limitMs`. Best effort, never throws. */
export async function closeOnGithub(
	rows: (Omit<Reaped, 'failedStep' | 'summary'> & Partial<Pick<Reaped, 'summary'>>)[],
	limitMs = WATCHDOG_GITHUB_CLOSE_MS,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const all = (async () => {
		const [{ notifyDeploymentFinished }, { getRepoFor }, { redactSecrets }] = await Promise.all([
			import('./github-deployments'),
			import('./repos'),
			import('./secret-text'),
		])
		await Promise.allSettled(
			rows.map(async (r) => {
				const repo = await getRepoFor(r.serverId, r.containerName).catch(() => null)
				if (!repo) return
				// the row's own summary (a never-claimed queued row says so); failedStep stays
				// null here: "failed at watchdog: stopped by the watchdog" would say it twice
				const summary = redactSecrets(r.summary ?? withReason(r).summary)
				await notifyDeploymentFinished(
					repo,
					r.id,
					'failure',
					summary,
					r.claimed ? { kind: r.kind, requestedSha: r.requestedSha, sha: r.gitSha, failedStep: null, errorSummary: summary, testGate: null } : undefined,
				)
			}),
		)
	})().catch((err) => console.error('[deploy-watchdog] GitHub status close failed:', err instanceof Error ? err.message : err))
	const limit = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			console.warn(`[deploy-watchdog] GitHub status closes still running after ${limitMs} ms; not waiting for them`)
			resolve()
		}, limitMs)
		timer.unref?.()
	})
	try {
		await Promise.race([all, limit])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
