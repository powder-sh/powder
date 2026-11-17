// In-process cron scheduler. Ticks every 60s, fires due jobs, records results.
// Powder owns the schedule (not host crontab) so logs and history land in our
// own DB and writing the host crontab can't go wrong.

import { NO_BASE_DOMAIN_MESSAGE, firstLiveHostByRepo } from './app-hosts'
import type { HostServer } from './app-hosts'
import { CappedOutput } from './capped-output'
import { notify, shouldNotifyCronFailure } from './cron-notify'
import { decryptSecret, encryptSecret } from './crypto'
import {
	and,
	appDomains,
	appEnvVars,
	appRepos,
	createId,
	cronJobRuns,
	cronJobs,
	db,
	eq,
	isNull,
	lte,
	or,
	prefixes,
	schedulerHeartbeat,
	sql,
} from './db'
import type { CronJob } from './db'
import {
	argvToDisplay,
	buildExecHostCommand,
	clampTimeout,
	computeNextRun,
	isValidEnvName,
	normalizeCronPath,
	staleRunCutoff,
} from './managed-crons'
import { cronTargetBlocked, guardedAppFetch } from './notify-url-guard'
import { pruneRateLimitBuckets } from './rate-limit'
import { redactNullable, redactSecrets } from './secret-text'
import { getServer } from './servers'
import { cronBearerIsDefault } from './session-only'
import { assertSafeName, shq } from './shell'
import { runCommand } from './ssh'
import { resolveUrl } from './uptime'

const TICK_MS = 60_000
const UPTIME_TICK_MS = 5 * 60_000
// Backup ticks every hour; backupTick itself skips apps whose last successful
// backup is <23h old, so this just gives us a 1h ceiling on detection latency.
const BACKUP_TICK_MS = 60 * 60_000
const MAX_OUTPUT_LEN = 16_000

let started = false
let timer: NodeJS.Timeout | null = null
let uptimeTimer: NodeJS.Timeout | null = null
let backupTimer: NodeJS.Timeout | null = null

// Heartbeat lives in a DB row, NOT in-process. The scheduler runs in the
// separate deploy-worker process (POWDER_DEPLOY_WORKER), so the web process's
// /api/health route can't read an in-memory stamp — they're different
// processes. The owning process upserts scheduler_heartbeat(id='scheduler')
// each tick; web reads it back to know the scheduler is alive cross-process.
// (When the flag is off, web itself owns the scheduler and stamps owner='web'.)
const HEARTBEAT_ID = 'scheduler'
// Second heartbeat row, owned by the deploy-worker's claim loop. The cron
// scheduler and the claim loop are independent timers in the same process; when
// the claim loop wedges, crons keep ticking, so the 'scheduler' row
// stays fresh and /api/health never notices deploys have stopped. This row makes
// the claim loop separately observable: the worker stamps it each self-heal tick
// and /api/health treats it stale as a 503 (only when the worker is enabled).
const CLAIM_HEARTBEAT_ID = 'deploy-claim'
let currentOwner = 'web'

export type HeartbeatHealth = {
	started: boolean
	lastTickAt: Date | null
	staleMs: number | null
	owner: string | null
}

async function upsertHeartbeat(
	id: string,
	isStarted: boolean,
	owner: string,
	lastTickAt: Date,
): Promise<void> {
	await db
		.insert(schedulerHeartbeat)
		.values({ id, started: isStarted, lastTickAt, owner })
		.onConflictDoUpdate({
			target: schedulerHeartbeat.id,
			set: { started: isStarted, lastTickAt, owner },
		})
}

async function readHeartbeat(id: string): Promise<HeartbeatHealth> {
	try {
		const [row] = await db
			.select()
			.from(schedulerHeartbeat)
			.where(eq(schedulerHeartbeat.id, id))
			.limit(1)
		if (!row) return { started: false, lastTickAt: null, staleMs: null, owner: null }
		return {
			started: row.started,
			lastTickAt: row.lastTickAt ?? null,
			staleMs: row.lastTickAt ? Date.now() - row.lastTickAt.getTime() : null,
			owner: row.owner ?? null,
		}
	} catch {
		return { started: false, lastTickAt: null, staleMs: null, owner: null }
	}
}

async function stampHeartbeat(isStarted: boolean): Promise<void> {
	try {
		await upsertHeartbeat(HEARTBEAT_ID, isStarted, currentOwner, new Date())
	} catch (err) {
		console.error('[scheduler] heartbeat write failed:', err)
	}
}

// Called by the deploy-worker's self-heal tick. `lastAttemptAt` is the in-memory
// timestamp of the worker's most recent claim ATTEMPT — passing it (rather than
// `now`) means the row reflects whether the claim loop is actually firing, not
// just whether this independent self-heal timer is alive. If the loop wedges,
// lastAttemptAt freezes and this row goes stale even while the self-heal timer
// keeps stamping.
export async function stampClaimHeartbeat(isStarted: boolean, lastAttemptAt: Date): Promise<void> {
	try {
		await upsertHeartbeat(CLAIM_HEARTBEAT_ID, isStarted, 'worker', lastAttemptAt)
	} catch (err) {
		console.error('[worker] claim heartbeat write failed:', err)
	}
}

export function getSchedulerHealth(): Promise<HeartbeatHealth> {
	return readHeartbeat(HEARTBEAT_ID)
}

export function getClaimLoopHealth(): Promise<HeartbeatHealth> {
	return readHeartbeat(CLAIM_HEARTBEAT_ID)
}

// Call once during process boot. Idempotent. `owner` records which process owns
// the scheduler ('worker' normally, 'web' in in-web mode, POWDER_DEPLOY_WORKER off).
export function startCronScheduler(owner = 'web'): void {
	if (started) return
	started = true
	currentOwner = owner
	void stampHeartbeat(true)
	timer = setInterval(() => {
		cronTick().catch((err) => console.error('[cron] tick failed:', err))
	}, TICK_MS)
	cronTick().catch((err) => console.error('[cron] initial tick failed:', err))

	// Uptime ping every 5 min (separate timer so a slow ping doesn't delay crons).
	uptimeTimer = setInterval(() => {
		import('./uptime')
			.then(({ uptimeTick }) => uptimeTick())
			.catch((err) => console.error('[uptime] tick failed:', err))
		// Piggyback expired snapshot cleanup on the same 5-min cadence.
		import('./deploy-snapshots')
			.then(({ cleanupExpiredSnapshots }) => cleanupExpiredSnapshots())
			.catch((err) => console.error('[snapshots] cleanup failed:', err))
		// Mark stuck "running" deploys as failed (an SSH disconnect can leave a
		// row running with no process behind it).
		import('./deploy-watchdog')
			.then(({ reapStuckDeploys }) => reapStuckDeploys())
			.catch((err) => console.error('[deploy-watchdog] reap failed:', err))
		import('./deploy-watchdog')
			.then(({ checkLeftoverCandidates }) => checkLeftoverCandidates())
			.catch((err) => console.error('[deploy-watchdog] candidate check failed:', err))
		// Aggregate Traefik access logs into per-app per-hour traffic buckets.
		import('./traffic-stats')
			.then(({ trafficAggregateTick }) => trafficAggregateTick())
			.catch((err) => console.error('[traffic-stats] tick failed:', err))
		// Evict stale rate-limit buckets so the in-memory map doesn't grow forever.
		pruneRateLimitBuckets()
		// Scrape each server's journalctl for host-cron firings → cron_runs table.
		// Powers the cron leg of /activity, since cron_jobs is mostly inert.
		import('./cron-observer')
			.then(({ cronObserverTick }) => cronObserverTick())
			.catch((err) => console.error('[cron-observer] tick failed:', err))
	}, UPTIME_TICK_MS)
	import('./uptime')
		.then(({ uptimeTick }) => uptimeTick())
		.catch((err) => console.error('[uptime] initial tick failed:', err))
	// Fire the cron observer immediately on boot so /activity backfills within
	// the first 5 min after a powder restart instead of waiting for the tick.
	import('./cron-observer')
		.then(({ cronObserverTick }) => cronObserverTick())
		.catch((err) => console.error('[cron-observer] initial tick failed:', err))

	// Backups: every hour, fire any due (23h-old) backups for apps with postgres.
	// Skipped silently if BACKUP_S3_* env vars aren't configured.
	backupTimer = setInterval(() => {
		import('./backups')
			.then(({ backupTick }) => backupTick())
			.catch((err) => console.error('[backup] tick failed:', err))
	}, BACKUP_TICK_MS)
	import('./backups')
		.then(({ backupTick }) => backupTick())
		.catch((err) => console.error('[backup] initial tick failed:', err))
}

export function stopCronScheduler(): void {
	if (timer) clearInterval(timer)
	if (uptimeTimer) clearInterval(uptimeTimer)
	if (backupTimer) clearInterval(backupTimer)
	timer = null
	uptimeTimer = null
	backupTimer = null
	started = false
	void stampHeartbeat(false)
}

// In-flight guard: a tick that takes longer than TICK_MS (slow DB, many jobs)
// must not overlap the next interval tick.
let ticking = false

/** Exported for tests. */
export async function cronTick(): Promise<void> {
	if (ticking) return
	ticking = true
	try {
		await tickOnce()
	} finally {
		ticking = false
	}
}

async function tickOnce(): Promise<void> {
	const now = new Date()
	void stampHeartbeat(true)
	const due = await db.select().from(cronJobs).where(lte(cronJobs.nextRunAt, now))

	for (const job of due) {
		if (!job.enabled || !job.nextRunAt) continue
		// Claim the firing atomically: advance next_run_at only while it is still
		// due (<= now). Once one pass advances it past now, an overlapping tick or
		// a second process that read the same row gets zero rows back. A range
		// check, not equality on the Date: a microsecond-precision timestamp would
		// never equal the millisecond JS value and the job would never fire.
		const next = computeNextRun(job.schedule, now, job.timezone)
		const claimed = await db
			.update(cronJobs)
			.set({ nextRunAt: next })
			.where(and(eq(cronJobs.id, job.id), lte(cronJobs.nextRunAt, now)))
			.returning({ id: cronJobs.id })
		if (claimed.length === 0) continue
		runJob(job, 'schedule').catch((err) => console.error(`[cron ${job.id}] run failed:`, err))
	}

	// Schedule any jobs that don't have a next_run_at yet (e.g. just created).
	const pending = await db.select().from(cronJobs).where(eq(cronJobs.enabled, true))
	for (const job of pending) {
		if (job.nextRunAt) continue
		const next = computeNextRun(job.schedule, now, job.timezone)
		if (next) await db.update(cronJobs).set({ nextRunAt: next }).where(eq(cronJobs.id, job.id))
	}
}

// Output kept per run: first 4 KB + last 12 KB (the tail is what explains a failure).
const RUN_OUTPUT_HEAD = 4 * 1024
const RUN_OUTPUT_TAIL = 12 * 1024
// Newest runs kept per job; older rows are pruned after each run.
const CRON_RUNS_KEEP = 50

type RunStatus = 'success' | 'failed' | 'timeout'
type RunTrigger = 'schedule' | 'manual'

export type RunJobResult =
	| { skipped: true; runId: string }
	| { skipped: false; runId: string; status: RunStatus }

/**
 * Run one job now. Overlap policy: skip if the previous run is still running.
 * The guard is a conditional UPDATE on cron_jobs.running_since, so it holds
 * across processes (scheduler in the worker, "run now" in web). A mark older
 * than timeout + grace is stale (the run's process died) and may be reclaimed.
 */
async function runJob(job: CronJob, trigger: RunTrigger): Promise<RunJobResult> {
	const claimedAt = new Date()
	const runId = createId(prefixes.cronJobRun)
	const cutoff = staleRunCutoff(claimedAt, job.timeoutSeconds)
	const claim = await db
		.update(cronJobs)
		.set({ runningSince: claimedAt })
		.where(
			and(
				eq(cronJobs.id, job.id),
				or(isNull(cronJobs.runningSince), lte(cronJobs.runningSince, cutoff)),
			),
		)
		.returning({ id: cronJobs.id })
	if (claim.length === 0) {
		await db.insert(cronJobRuns).values({
			id: runId,
			cronJobId: job.id,
			trigger,
			status: 'skipped',
			startedAt: claimedAt,
			finishedAt: claimedAt,
			durationMs: 0,
			error: 'previous run still running',
		})
		return { skipped: true, runId }
	}

	await db.insert(cronJobRuns).values({
		id: runId,
		cronJobId: job.id,
		trigger,
		status: 'running',
		startedAt: claimedAt,
	})

	let status: RunStatus = 'success'
	let httpStatus: number | null = null
	let exitCode: number | null = null
	let output = ''
	let error: string | null = null

	try {
		if (job.kind === 'http') {
			const res = await fireHttp(job)
			httpStatus = res.status
			output = res.body
			if (!res.ok) {
				status = 'failed'
				error = `${res.status} ${res.statusText}`.trim()
			}
		} else if (job.kind === 'exec') {
			const res = await fireExec(job)
			exitCode = res.code
			output = res.output
			// coreutils timeout exits 124 (TERM) or 137 (KILL after the grace).
			if (res.code === 124 || res.code === 137) {
				status = 'timeout'
				error = `timed out after ${clampTimeout(job.timeoutSeconds)}s`
			} else if (res.code !== 0) {
				status = 'failed'
				error = `exit ${res.code}`
			}
		} else {
			status = 'failed'
			error = `unknown cron kind: ${job.kind}`
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'unknown error'
		status = msg === 'timeout' || /timeout/i.test(msg) ? 'timeout' : 'failed'
		error = msg.slice(0, MAX_OUTPUT_LEN)
	}

	const finishedAt = new Date()
	const durationMs = finishedAt.getTime() - claimedAt.getTime()
	// Masked at write (lib/secret-text.ts): run output and errors are shown to
	// tokens and sent to notification targets.
	const capped = new CappedOutput(RUN_OUTPUT_HEAD, RUN_OUTPUT_TAIL)
	capped.push(redactSecrets(output))
	error = redactNullable(error)

	try {
		await db
			.update(cronJobRuns)
			.set({
				status,
				finishedAt,
				durationMs,
				httpStatus,
				exitCode,
				output: capped.toString(),
				error,
			})
			.where(eq(cronJobRuns.id, runId))
	} catch (err) {
		console.error(`[cron ${job.id}] run row update failed:`, err)
	}
	await db
		.update(cronJobs)
		.set({
			lastRunAt: claimedAt,
			lastRunStatus: status,
			lastRunError: error,
			lastRunHttpStatus: httpStatus,
		})
		.where(eq(cronJobs.id, job.id))
	// Release the overlap guard only if it is still OUR mark: a stale reclaim by
	// a later run must not be cleared by this (older) run finishing.
	await db
		.update(cronJobs)
		.set({ runningSince: null })
		.where(and(eq(cronJobs.id, job.id), eq(cronJobs.runningSince, claimedAt)))

	if (shouldNotifyCronFailure(job.lastRunStatus, status)) {
		await notify('cron_failed', {
			app: job.containerName,
			server: job.serverId,
			jobId: job.id,
			schedule: `${job.schedule} ${job.timezone}`,
			target: describeTarget(job),
			status: status as 'failed' | 'timeout',
			error: error ?? status,
		}).catch(() => false)
	}

	try {
		await db.execute(
			sql`delete from cron_job_runs where cron_job_id = ${job.id} and id not in (select id from cron_job_runs where cron_job_id = ${job.id} order by started_at desc limit ${CRON_RUNS_KEEP})`,
		)
	} catch (err) {
		console.error(`[cron ${job.id}] prune failed:`, err)
	}

	return { skipped: false, runId, status }
}

/** "Run now" from the dashboard. Same overlap guard as the scheduler. */
export async function runJobNow(jobId: string): Promise<RunJobResult | null> {
	const [job] = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1)
	if (!job) return null
	return runJob(job, 'manual')
}

function describeTarget(job: CronJob): string {
	if (job.kind === 'http') return `${job.httpMethod} ${job.urlPath ?? ''}`
	if (job.execArgv && job.execArgv.length > 0)
		return `exec ${argvToDisplay(job.execArgv)}`.slice(0, 200)
	return `exec ${job.execCommand ?? ''}`.slice(0, 200)
}

const CRON_BODY_CAP_BYTES = 4096

/** read at most `cap` bytes of a response body, then cancel the stream. */
export async function readBodyCapped(res: Response, cap: number): Promise<string> {
	if (!res.body) return ''
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (total < cap) {
			const { done, value } = await reader.read()
			if (done || !value) break
			chunks.push(value)
			total += value.byteLength
		}
	} catch {
		// partial body is fine
	} finally {
		await reader.cancel().catch(() => {})
	}
	const buf = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, cap)
	return buf.toString('utf8')
}

async function fireHttp(job: CronJob): Promise<{
	ok: boolean
	status: number
	statusText: string
	body: string
}> {
	const path = normalizeCronPath(job.urlPath)
	if (!path) throw new Error('http cron has no valid path')
	const url = await resolveAppUrl(job, path)
	const token = await resolveBearer(job)
	const method = job.httpMethod === 'GET' ? 'GET' : 'POST'
	const ctrl = new AbortController()
	const t = setTimeout(() => ctrl.abort(), clampTimeout(job.timeoutSeconds) * 1000)
	try {
		// the address connected to may not be loopback, link-local or private
		// (guardedAppFetch checks it at connect time, so DNS rebinding cannot reach
		// powder's own networks); an app's public domain passes.
		const res = await guardedAppFetch(url, {
			method,
			headers: token ? { Authorization: `Bearer ${token}` } : {},
			signal: ctrl.signal,
			// never follow a redirect (SSRF to internal services, bearer token leak).
			redirect: 'manual',
			// never a private overlay network address (100.64/10, fd7a:115c:a1e0::/48) either
			blocked: cronTargetBlocked,
		})
		const isRedirect = res.status >= 300 && res.status < 400
		const body = isRedirect ? '' : await readBodyCapped(res, CRON_BODY_CAP_BYTES)
		return {
			ok: res.ok && !isRedirect,
			status: res.status,
			statusText: isRedirect ? `${res.statusText} (redirects are not followed)` : res.statusText,
			body,
		}
	} catch (err) {
		if (ctrl.signal.aborted) throw new Error('timeout')
		throw err
	} finally {
		clearTimeout(t)
	}
}

// Bearer for an http job: the named app env var (powder env DB first, then the
// running container's env), else the per-app POWDER_CRON_TOKEN.
async function resolveBearer(job: CronJob): Promise<string | null> {
	const name = job.bearerEnvVar?.trim()
	// the same test as session-only.ts cronBearerIsDefault
	if (cronBearerIsDefault(job.bearerEnvVar)) return getOrCreateAppCronToken(job.serverId, job.containerName)
	if (!name) return null
	if (!isValidEnvName(name)) throw new Error(`invalid bearer env var name "${name}"`)
	const [repo] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, job.serverId), eq(appRepos.containerName, job.containerName)))
		.limit(1)
	if (repo) {
		const [row] = await db
			.select({ valueEncrypted: appEnvVars.valueEncrypted })
			.from(appEnvVars)
			.where(
				and(
					eq(appEnvVars.appRepoId, repo.id),
					eq(appEnvVars.key, name),
					eq(appEnvVars.scope, 'production'),
				),
			)
			.limit(1)
		if (row) return decryptSecret(row.valueEncrypted)
	}
	const server = await getServer(job.serverId)
	if (!server) throw new Error(`unknown server ${job.serverId}`)
	const { stdout, code } = await runCommand(
		server,
		`docker exec ${assertSafeName(job.containerName)} printenv ${shq(name)}`,
		10_000,
	)
	const value = stdout.replace(/\r?\n$/, '')
	if (code !== 0 || !value)
		throw new Error(`bearer env var ${name} is not set for ${job.containerName}`)
	return value
}

async function fireExec(job: CronJob): Promise<{ code: number; output: string }> {
	const server = await getServer(job.serverId)
	if (!server) throw new Error(`unknown server ${job.serverId}`)
	const secs = clampTimeout(job.timeoutSeconds)
	let command: string
	if (job.execArgv && job.execArgv.length > 0) {
		// argv: every element shq-quoted, no shell interpretation anywhere.
		command = buildExecHostCommand(job.containerName, job.execArgv, secs)
	} else if (job.execCommand) {
		// A row with execCommand: one string that runs via sh -c.
		command = `timeout --kill-after=5 ${secs} docker exec ${assertSafeName(job.containerName)} sh -c ${shq(job.execCommand)}`
	} else {
		throw new Error('exec cron has no command')
	}
	// SSH backstop a little past the host-side timeout + kill grace.
	const { code, stdout, stderr } = await runCommand(server, `${command} 2>&1`, (secs + 15) * 1000)
	return { code, output: `${stdout}${stderr}` }
}

/** URL for an http job, resolved like uptime (lib/uptime.ts resolveUrl): the
 *  first live custom domain, else the server default host. `path` must already
 *  be a normalised path (normalizeCronPath), never an absolute URL. */
export function resolveCronUrl(
	server: HostServer | undefined,
	containerName: string,
	liveHostnames: string[],
	path: string,
): string {
	const url = resolveUrl({ containerName, healthUrl: path }, liveHostnames[0] ?? null, server)
	if (!url) throw new Error(`http cron needs a host: ${NO_BASE_DOMAIN_MESSAGE}`)
	return url
}

async function resolveAppUrl(job: CronJob, path: string): Promise<string> {
	const server = await getServer(job.serverId)
	const rows = await db
		.select({
			appRepoId: appDomains.appRepoId,
			hostname: appDomains.hostname,
			createdAt: appDomains.createdAt,
		})
		.from(appDomains)
		.innerJoin(appRepos, eq(appDomains.appRepoId, appRepos.id))
		.where(
			and(
				eq(appRepos.serverId, job.serverId),
				eq(appRepos.containerName, job.containerName),
				eq(appDomains.status, 'live'),
				isNull(appDomains.previewDeployId),
			),
		)
	// Same pick as uptime (oldest live domain), never the arbitrary first row.
	const live = [...firstLiveHostByRepo(rows).values()]
	return resolveCronUrl(server, job.containerName, live.slice(0, 1), path)
}

// Per-app token used for Authorization: Bearer <token>. Generated on first
// cron creation, persisted (encrypted) on app_repos and shown once. Powder does
// not put it in the app's env: the user adds POWDER_CRON_TOKEN on the env page
// and redeploys so the app can verify the header.
async function getOrCreateAppCronToken(
	serverId: string,
	containerName: string,
): Promise<string | null> {
	return (await ensureAppCronToken(serverId, containerName))?.token ?? null
}

/** the app's cron token and whether THIS call minted it (a create that finds
 *  the token already set must not hand it out again). null when no app row matches. */
export async function ensureAppCronToken(
	serverId: string,
	containerName: string,
): Promise<{ token: string; minted: boolean } | null> {
	// Match on BOTH columns — filtering by server alone and checking the first
	// row's name returned null for every app but one on a shared server, so their
	// http crons fired with no Authorization header.
	const [match] = await db
		.select()
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	if (!match) return null
	if (match.cronTokenEncrypted) return { token: decryptSecret(match.cronTokenEncrypted), minted: false }

	const token = randomToken(32)
	// Only when still unset: two concurrent creates must not both mint (and reveal).
	const set = await db
		.update(appRepos)
		.set({ cronTokenEncrypted: encryptSecret(token) })
		.where(and(eq(appRepos.id, match.id), isNull(appRepos.cronTokenEncrypted)))
		.returning({ id: appRepos.id })
	if (set.length > 0) return { token, minted: true }
	const [again] = await db
		.select({ cronTokenEncrypted: appRepos.cronTokenEncrypted })
		.from(appRepos)
		.where(eq(appRepos.id, match.id))
		.limit(1)
	return again?.cronTokenEncrypted ? { token: decryptSecret(again.cronTokenEncrypted), minted: false } : null
}

/** mint a NEW cron token for the app and store it (encrypted), replacing the
 *  current one. The caller reveals it once (an admin browser session only: the rotate
 *  route is SESSION_ONLY). A token minted earlier through an API token or the scheduler
 *  is never revealed, so this is how an operator gets one to put in the app's env.
 *  Existing http crons keep working: they read the current token when they fire, so they
 *  send the new one from now on. null when no app row matches. */
export async function rotateAppCronToken(serverId: string, containerName: string): Promise<string | null> {
	const token = randomToken(32)
	const set = await db
		.update(appRepos)
		.set({ cronTokenEncrypted: encryptSecret(token) })
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.returning({ id: appRepos.id })
	return set.length > 0 ? token : null
}

/** whether the app has a cron token (never the token itself). */
export async function appCronTokenSet(serverId: string, containerName: string): Promise<boolean> {
	const [row] = await db
		.select({ cronTokenEncrypted: appRepos.cronTokenEncrypted })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	return !!row?.cronTokenEncrypted
}

function randomToken(len: number): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
	const bytes = new Uint8Array(len)
	crypto.getRandomValues(bytes)
	let out = ''
	for (let i = 0; i < len; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length]
	return out
}
