import {
	and,
	appDomains,
	appRepos,
	asc,
	createId,
	db,
	deploys,
	desc,
	eq,
	isNotNull,
	isNull,
	notInArray,
	powderMeta,
	prefixes,
	sql,
} from './db'
import type { Deploy } from './db'
import {
	DEPLOY_SETTLE_META_KEY,
	SETTLE_WAITING_PREFIX,
	effectiveSettleSeconds,
	heldSql,
	isSettleTrigger,
	settleNote,
	settleNoteFor,
} from './deploy-settle'
import { isPgError } from './pg-error'
import { redactNullable, redactSecrets } from './secret-text'
import type { ServerConfig } from './servers'
import { ALL_PROFILES } from './deploy/compose-hash'
import {
	composeFileArgs,
	envFileCandidatesFor,
	healthCheckContainer,
	inspectContainer,
	livenessCheckContainer,
	restoreEnvSnapshot,
	rollbackToImage,
	runCommand,
	shellQuote,
} from './ssh'

type Kind = 'env_change' | 'image_update' | 'manual_apply' | 'restart' | 'git_deploy' | 'rollback' | 'stop' | 'delete'

// When set, deploys are executed by the separate deploy-worker process instead
// of inline in the web request. startDeploy then inserts 'queued' (the worker
// claims it) rather than 'running' (web runs it immediately). Flipping this off
// runs deploys in the web process instead (in-web mode).
export function deployWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return ['1', 'true', 'yes', 'on'].includes((env.POWDER_DEPLOY_WORKER ?? '').trim().toLowerCase())
}

// Thrown by startDeploy when the partial unique index `deploys_in_flight_unique`
// rejects a second running row for the same (serverId, containerName). That index
// is our deploy lock; this error signals "another deploy already holds it."
export class DeployInFlightError extends Error {
	readonly serverId: string
	readonly containerName: string
	/** True when the request was folded into an already-QUEUED deploy for the
	 *  same app (it will build the branch HEAD, which includes this push) -
	 *  nothing was dropped, so no catch-up is needed. */
	readonly coalesced: boolean
	/** The queued row it was folded into (set when coalesced). */
	readonly queuedId: string | null
	/** True when an urgent request folded into a row that was HELD on its settle window
	 *  (deploy-settle.ts) and released it: that row now deploys at once. */
	readonly released: boolean
	constructor(serverId: string, containerName: string, coalesced = false, fold?: { queuedId: string; released: boolean }) {
		super(`deploy already in flight for ${serverId}/${containerName}`)
		this.name = 'DeployInFlightError'
		this.serverId = serverId
		this.containerName = containerName
		this.coalesced = coalesced
		this.queuedId = fold?.queuedId ?? null
		this.released = fold?.released ?? false
	}
}

// Thrown by startDeploy while the app is being deleted (a running 'delete' row):
// a push or catch-up that lands mid-delete is refused, not queued behind it.
export class AppBeingDeletedError extends Error {
	constructor(serverId: string, containerName: string) {
		super(`app ${serverId}/${containerName} is being deleted`)
		this.name = 'AppBeingDeletedError'
	}
}

/** True while a delete of the app runs (its 'running' row with kind 'delete'). */
export async function appDeleteInFlight(serverId: string, containerName: string): Promise<boolean> {
	const [row] = await db
		.select({ id: deploys.id })
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, serverId),
				eq(deploys.containerName, containerName),
				eq(deploys.status, 'running'),
				eq(deploys.kind, 'delete'),
			),
		)
		.limit(1)
	return !!row
}

export async function startDeploy(opts: {
	serverId: string
	containerName: string
	kind: Kind
	triggeredBy?: string
	// The caller executes the work ITSELF in this process (apply / restart /
	// rollback / first-deploy routes). Insert 'running' even in worker mode -
	// a 'queued' row from these routes gets CLAIMED by the worker, which then
	// runs a full git rebuild concurrently with the route's inline work. For
	// a rollback that means the worker rebuilds latest HEAD and UNDOES the
	// rollback moments after it lands.
	inline?: boolean
	/** The commit to build (push payload `after`); NULL/absent = branch HEAD. */
	requestedSha?: string | null
	/** Never hold this request on the settle window (deploy-settle.ts), and release a held
	 *  queued row it folds into: manual redeploy, powder_force, a `[urgent]` commit. */
	urgent?: boolean
}): Promise<Deploy> {
	const status = opts.inline || !deployWorkerEnabled() ? 'running' : 'queued'
	// A queued row would wait behind the delete and then run for an app that no
	// longer exists. The delete also fails any queued row that slips past this
	// check before it releases the app, and the executor refuses an unregistered
	// name without a container (resolveComposeFacts).
	if (opts.kind !== 'delete' && (await appDeleteInFlight(opts.serverId, opts.containerName))) {
		throw new AppBeingDeletedError(opts.serverId, opts.containerName)
	}
	// Inline work (rollback / restart / apply) must not slip in ahead of a push
	// that is already waiting - the queued deploy would run right after and undo
	// it. Same answer as before the queued/running split: "already in flight".
	// Except a push HELD on its settle window (heldSql): it would block a manual
	// rollback or an emergency stop for the whole window, so rollback / restart / apply /
	// stop / delete go ahead. Rollback and stop then cancel the held row
	// (cancelHeldDeploys), delete fails every queued row of the app itself; after a
	// restart or apply the held push deploys as planned.
	if (status === 'running') {
		const [waiting] = await db
			.select({ id: deploys.id, held: sql<boolean>`${sql.raw(heldSql('"deploys"', new Date()))}` })
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, opts.serverId),
					eq(deploys.containerName, opts.containerName),
					eq(deploys.status, 'queued'),
				),
			)
			.limit(1)
		if (waiting && !(PASS_HELD_KINDS.includes(opts.kind) && waiting.held === true))
			throw new DeployInFlightError(opts.serverId, opts.containerName)
	}
	// Settle window: a webhook push that is not urgent waits until not_before, so pushes
	// right after it fold into this one row (deploy-settle.ts). Off (null) by default.
	const notBefore =
		status === 'queued' && opts.kind === 'git_deploy' && !opts.urgent && isSettleTrigger(opts.triggeredBy)
			? await settleNotBefore(opts.serverId, opts.containerName)
			: null
	// The lock is two partial unique indexes (0035): at most one running and
	// one queued row per app. ON CONFLICT DO NOTHING (untargeted, so it covers
	// both partial indexes) turns a second one into "no row back" instead of a
	// 23505 that postgres logs as an ERROR on every push that lands mid-deploy.
	// The 23505 catch stays as a fallback for anything that still raises it.
	let row: Deploy | undefined
	try {
		;[row] = await db
			.insert(deploys)
			.values({
				id: createId(prefixes.deploy),
				serverId: opts.serverId,
				containerName: opts.containerName,
				kind: opts.kind,
				// 'queued' → the deploy-worker claims and runs it. 'running' → the
				// caller runs it in-process (inline routes, or the web process in in-web mode).
				// A push that lands mid-deploy is stored as THE queued row - a
				// durable catch-up - rather than rejected.
				status,
				queuedAt: new Date(),
				triggeredBy: opts.triggeredBy ?? null,
				requestedSha: opts.requestedSha && /^[0-9a-f]{40}$/.test(opts.requestedSha) ? opts.requestedSha : null,
				// only when held: the row's log line says why it waits and how to skip it
				...(notBefore ? { notBefore, output: `[settle] ${settleNoteFor(notBefore)}\n` } : {}),
			})
			.onConflictDoNothing()
			.returning()
	} catch (err) {
		if (!isPgError(err, '23505')) throw err
		row = undefined
	}
	if (row) return row
	// Lock conflict. A queued row already exists: fold this request into it.
	// Unpin it so it builds the branch HEAD - which contains this push AND the
	// one it was queued for. (0 rows updated = the conflict was a RUNNING row
	// → a genuine rejection; caller schedules a catch-up.)
	// Settle window: a non-urgent push never moves the held row's not_before (the delay
	// stays counted from the first push); an urgent one clears it, so it deploys now.
	if (status === 'queued') {
		const queuedOfApp = and(
			eq(deploys.serverId, opts.serverId),
			eq(deploys.containerName, opts.containerName),
			eq(deploys.status, 'queued'),
		)
		let wasHeld = false
		if (opts.urgent) {
			const [cur] = await db
				.select({ held: sql<boolean>`${sql.raw(heldSql('"deploys"', new Date()))}` })
				.from(deploys)
				.where(queuedOfApp)
				.limit(1)
				.catch(() => [])
			wasHeld = cur?.held === true
		}
		const folded = await db
			.update(deploys)
			.set(
				opts.urgent
					? {
							requestedSha: null,
							notBefore: null,
							...(wasHeld ? { output: `[settle] released early (${opts.triggeredBy ?? 'urgent'}): deploying now\n` } : {}),
						}
					: { requestedSha: null },
			)
			.where(queuedOfApp)
			.returning({ id: deploys.id })
			.catch(() => [])
		const queuedId = folded[0]?.id
		if (queuedId) throw new DeployInFlightError(opts.serverId, opts.containerName, true, { queuedId, released: wasHeld })
	}
	throw new DeployInFlightError(opts.serverId, opts.containerName)
}

/** Kinds of inline work that may run while a push is held on its settle window. */
const PASS_HELD_KINDS: Kind[] = ['rollback', 'restart', 'manual_apply', 'env_change', 'stop', 'delete']

/** The not_before for a new webhook push of this app, or null when the window is off.
 *  Read at insert time: app_repos.deploy_settle_seconds, else powder_meta, else off.
 *  A settings read that fails means no hold (deploy at once, as before the window). */
async function settleNotBefore(serverId: string, containerName: string): Promise<Date | null> {
	try {
		const [app] = await db
			.select({ s: appRepos.deploySettleSeconds })
			.from(appRepos)
			.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
			.limit(1)
		let global: string | null = null
		if (app?.s === null || app?.s === undefined) {
			const [meta] = await db
				.select({ v: powderMeta.value })
				.from(powderMeta)
				.where(eq(powderMeta.key, DEPLOY_SETTLE_META_KEY))
				.limit(1)
			global = meta?.v ?? null
		}
		const seconds = effectiveSettleSeconds(global, app?.s)
		return seconds > 0 ? new Date(Date.now() + seconds * 1000) : null
	} catch (err) {
		console.error('[settle] could not read the settle window, deploying without one:', err instanceof Error ? err.message : err)
		return null
	}
}

/** A rollback or a stop must not be undone by a held push deploying (the broken code, or
 *  a started app) on top of it without a human: every queued row of the app still waiting
 *  on its settle window (not_before set) is closed the way the runner closes a superseded
 *  deploy (deploy-runner.ts): failed with failed_step 'superseded', a terminal 'superseded'
 *  event on the deploy bus, and its GitHub deployment set to 'failure'. No powder
 *  notification and no HQ deploy event is sent for it (the runner sends none for a
 *  superseded row either), and /api/internal/deploys leaves it out of the terminal rows the
 *  ops hub reconciles, so it is never paged as a failed deploy. Called by the rollback and
 *  stop routes once their own running row holds the app (so none can be claimed in
 *  between). Returns the cancelled ids. */
export async function cancelHeldDeploys(
	serverId: string,
	containerName: string,
	by: { id: string; kind: 'rollback' | 'stop' },
): Promise<string[]> {
	const msg = `cancelled by ${by.kind} ${by.id}: this push was waiting on the settle window; push again or redeploy to ship it`
	const rows = await db
		.update(deploys)
		.set({
			status: 'failed',
			finishedAt: new Date(),
			failedStep: 'superseded',
			error: msg,
			errorSummary: `cancelled by a ${by.kind} while waiting to bundle pushes`,
		})
		.where(
			and(
				eq(deploys.serverId, serverId),
				eq(deploys.containerName, containerName),
				eq(deploys.status, 'queued'),
				isNotNull(deploys.notBefore),
			),
		)
		.returning({ id: deploys.id })
	if (rows.length > 0) {
		const [{ publishTerminal }, { notifyDeploymentFinished }, { getRepoFor }] = await Promise.all([
			import('./deploy-bus'),
			import('./github-deployments'),
			import('./repos'),
		])
		const repo = await getRepoFor(serverId, containerName).catch(() => null)
		for (const r of rows) {
			publishTerminal(r.id, 'end', 'superseded')
			if (repo) await notifyDeploymentFinished(repo, r.id, 'failure', redactSecrets(msg))
		}
	}
	return rows.map((r) => r.id)
}

// Helper for UI route handlers: returns the Deploy on success, or a 409 Response
// when another deploy is already in flight. Mirrors the access.ts pattern.
// An urgent request (manual redeploy) that released a held queued row answers 200 with
// that row's id: the deploy the user asked for is starting now.
export async function tryStartDeploy(opts: {
	serverId: string
	containerName: string
	kind: Kind
	triggeredBy?: string
	inline?: boolean
	urgent?: boolean
}): Promise<Deploy | Response> {
	try {
		return await startDeploy(opts)
	} catch (err) {
		if (err instanceof AppBeingDeletedError) {
			return Response.json({ error: 'app is being deleted' }, { status: 409 })
		}
		if (err instanceof DeployInFlightError && err.released && err.queuedId) {
			return Response.json({ ok: true, deployId: err.queuedId, released: true })
		}
		if (err instanceof DeployInFlightError) {
			return Response.json(
				{
					error: 'deploy already in flight',
					serverId: opts.serverId,
					containerName: opts.containerName,
				},
				{ status: 409 },
			)
		}
		throw err
	}
}

/** How often inlineProgress stamps heartbeat_at; well under HEARTBEAT_STALE_MIN
 *  (deploy-budget.ts), the same period as the deploy runner's. */
const INLINE_HEARTBEAT_MS = 30_000

export interface InlineProgress {
	/** every line so far, for finishDeploy's output */
	readonly lines: readonly string[]
	/** append a line to the row's output and stamp its heartbeat */
	step(line: string): Promise<void>
	/** stop the heartbeat timer (call in a finally) */
	stop(): void
}

/** Liveness for a running deploys row whose work runs inline in a route (the app
 *  delete): heartbeat_at is stamped now, every INLINE_HEARTBEAT_MS and on each
 *  step, and each step's line is written to output, the way the deploy runner
 *  does. Without it the watchdog reads the row as silent (no output, no heartbeat)
 *  after SILENT_AFTER_MIN and reaps it while the work still runs, releasing the
 *  app's lock (deploy-watchdog.ts). Only a row still running is touched. Write
 *  failures are logged, never thrown: liveness must not fail the work itself. */
export function inlineProgress(deployId: string, intervalMs = INLINE_HEARTBEAT_MS): InlineProgress {
	const lines: string[] = []
	const write = async (set: { heartbeatAt: Date; output?: string | null }) => {
		try {
			await db
				.update(deploys)
				.set(set)
				.where(and(eq(deploys.id, deployId), eq(deploys.status, 'running')))
		} catch (err) {
			console.error(`[deploy ${deployId}] progress write failed:`, err instanceof Error ? err.message : err)
		}
	}
	void write({ heartbeatAt: new Date() })
	const timer = setInterval(() => void write({ heartbeatAt: new Date() }), intervalMs)
	timer.unref?.()
	return {
		lines,
		async step(line: string) {
			lines.push(line)
			await write({ heartbeatAt: new Date(), output: redactNullable(lines.join('\n')) })
		},
		stop() {
			clearInterval(timer)
		},
	}
}

export async function finishDeploy(
	id: string,
	result: {
		status: 'success' | 'failed'
		output?: string
		error?: string
		failedStep?: string | null
		exitCode?: number | null
		errorSummary?: string | null
		/** sha256 of the compose config the deploy ran with; stored on success only (0056). */
		composeConfigHash?: string | null
		/** the view of that structure (compose-diff.ts); stored with the hash only (0062). */
		composeConfigView?: unknown
	},
): Promise<void> {
	// Only transition NON-terminal rows. Once the watchdog has reaped a row as
	// failed (and thereby released the in-flight lock), a late finishDeploy from
	// the original executor must not flip it back - that reap/resurrect race
	// made a superseded deploy overwrite the row a NEWER deploy was relying on.
	// The store chokepoint for deploy text: every column is masked here, so no
	// reader (REST, MCP, search, activity) ever sees a raw secret.
	const updated = await db
		.update(deploys)
		.set({
			status: result.status,
			output: redactNullable(result.output),
			error: redactNullable(result.error),
			failedStep: redactNullable(result.failedStep),
			exitCode: result.exitCode ?? null,
			errorSummary: redactNullable(result.errorSummary),
			finishedAt: new Date(),
			...(result.status === 'success' && result.composeConfigHash && /^[0-9a-f]{64}$/.test(result.composeConfigHash)
				? {
						composeConfigHash: result.composeConfigHash,
						...(result.composeConfigView ? { composeConfigView: result.composeConfigView } : {}),
					}
				: {}),
		})
		.where(and(eq(deploys.id, id), notInArray(deploys.status, ['success', 'failed'])))
		.returning({ id: deploys.id })
	if (updated.length === 0) await recordLateResult(id, result.status)
}

// A result arriving after the row went terminal. Usually the watchdog reaped a
// deploy that was in fact still alive; its container swap then happened with
// the row saying "failed" - the dashboard lied about what is live. Record the
// truth: always annotate, and flip a reaped row to success when nothing newer
// has started for the app since (a newer deploy owns "what is live" then).
async function recordLateResult(id: string, status: 'success' | 'failed'): Promise<void> {
	const [row] = await db.select().from(deploys).where(eq(deploys.id, id)).limit(1)
	if (!row) return
	const reaped = row.status === 'failed' && (row.error ?? '').startsWith('[watchdog]')
	if (!reaped) {
		console.warn(`[finishDeploy] ${id}: row already terminal (duplicate finish) - late '${status}' result ignored`)
		return
	}
	const note = `\n[late result] the executor finished with '${status}' at ${new Date().toISOString()}, after the watchdog reap above.`
	let flip = false
	if (status === 'success') {
		const [newer] = await db
			.select({ id: deploys.id })
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, row.serverId),
					eq(deploys.containerName, row.containerName),
					sql`${deploys.startedAt} > ${row.startedAt}`,
				),
			)
			.limit(1)
		flip = !newer
	}
	await db
		.update(deploys)
		.set(
			flip
				? { status: 'success', error: null, errorSummary: null, failedStep: null, output: `${row.output ?? ''}${note}` }
				: { error: `${row.error ?? ''}${note}` },
		)
		.where(and(eq(deploys.id, id), eq(deploys.status, 'failed')))
	console.warn(`[finishDeploy] ${id}: late '${status}' after watchdog reap - ${flip ? 'row corrected to success' : 'annotated'}`)
}

// Resolves what the pre-swap health gate should actually probe, from
// app_repos.health_url (the same column uptime.ts reads - its semantics are
// untouched here; we only reuse the value).
//
// Two shapes exist in stored rows:
//   "https://x.com/api/health" → path /api/health, Host: x.com
//   "/api/health"              → path /api/health, Host: the app's primary
//                                live hostname (none → probe without a Host)
//
// Returning null means "no health URL configured" → the gate keeps its old
// 1xx-4xx-on-`/` behaviour, so unconfigured apps don't change at all.
export async function resolveHealthProbe(
	serverId: string,
	containerName: string,
): Promise<{ path: string; host?: string } | null> {
	const [repo] = await db
		.select({ id: appRepos.id, healthUrl: appRepos.healthUrl })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	const healthUrl = repo?.healthUrl?.trim()
	if (!repo || !healthUrl) return null

	const absolute = parseHealthUrl(healthUrl)
	if (absolute?.host) return absolute

	// Bare path: pair it with the app's primary live hostname. Same filter
	// uptime.ts uses (status='live', parent-app rows only - preview_deploy_id
	// NULL), but ordered so the choice is deterministic instead of whatever
	// postgres hands back: shortest hostname first (the apex/canonical name
	// beats `www.` and long preview-ish subdomains), then oldest, then by id.
	const liveDomains = await db
		.select({ hostname: appDomains.hostname })
		.from(appDomains)
		.where(
			and(
				eq(appDomains.appRepoId, repo.id),
				eq(appDomains.status, 'live'),
				isNull(appDomains.previewDeployId),
			),
		)
		.orderBy(sql`length(${appDomains.hostname})`, asc(appDomains.createdAt), asc(appDomains.id))
		.limit(1)

	return parseHealthUrl(healthUrl, liveDomains[0]?.hostname)
}

/** Pure half of resolveHealthProbe: health_url (+ the app's primary live
 *  hostname for bare paths) → what the gate probes. */
export function parseHealthUrl(
	healthUrl: string,
	primaryHost?: string,
): { path: string; host?: string } | null {
	const raw = healthUrl.trim()
	if (!raw) return null
	if (/^https?:\/\//i.test(raw)) {
		try {
			const u = new URL(raw)
			return { path: `${u.pathname}${u.search}` || '/', host: u.hostname || undefined }
		} catch {
			// Malformed absolute URL - fall through and treat it as a bare path.
		}
	}
	return { path: raw.startsWith('/') ? raw : `/${raw}`, host: primaryHost }
}

// Post-deploy health gate. Polls the new container's HTTP endpoint; if it
// can't get a non-5xx response within the timeout, looks for the most recent
// successful deploy with a tagged image and rolls back to it. The rollback
// path retags + recreates - a few seconds of downtime - but that beats
// leaving a crashing container live.
//
// Returns:
//   { healthy: true }                    - new container responded; nothing done
//   { healthy: 'skipped', ... }          - non-HTTP workload (queue, cron); no check possible
//   { healthy: false, rolledBackTo: X }  - rolled back to image X
//   { healthy: false, rolledBackTo: null } - unhealthy AND no previous tagged image to roll back to
export async function verifyDeployHealth(opts: {
	server: ServerConfig
	serverId: string
	containerName: string
	configFile: string
	service: string
	composeFiles?: string[]
	workingDir: string
	currentDeployId: string
	maxWaitMs?: number
	onChunk?: (chunk: string) => void
}): Promise<{
	healthy: true | false | 'skipped'
	output: string
	rolledBackTo: string | null
	rollbackError: string | null
	/** After a rollback: did the rolled-back container pass the same gate?
	 *  null = no rollback ran. */
	rollbackHealthy: boolean | null
}> {
	const gate = await runHealthGate(opts)
	if (gate.healthy !== false) {
		return { healthy: gate.healthy, output: gate.output, rolledBackTo: null, rollbackError: null, rollbackHealthy: null }
	}
	const rb = await autoRollback({ ...opts, reason: 'health check failed' })
	return {
		healthy: false,
		output: gate.output + rb.output,
		rolledBackTo: rb.rolledBackTo,
		rollbackError: rb.rollbackError,
		rollbackHealthy: rb.rollbackHealthy,
	}
}

// The gate itself: HTTP probe (health_url-aware), with the liveness fallback for
// non-HTTP workloads. true = healthy, 'skipped' = alive but not HTTP-checkable.
export async function runHealthGate(opts: {
	server: ServerConfig
	serverId: string
	containerName: string
	maxWaitMs?: number
	onChunk?: (chunk: string) => void
}): Promise<{ healthy: true | false | 'skipped'; output: string }> {
	// Read fresh on every deploy - never memoised - so flipping health_url in the
	// UI takes effect on the very next deploy rather than after a powder restart.
	const probe = await resolveHealthProbe(opts.serverId, opts.containerName)
	const health = await healthCheckContainer(opts.server, opts.containerName, {
		maxWaitMs: opts.maxWaitMs,
		healthPath: probe?.path,
		hostHeader: probe?.host,
		onChunk: opts.onChunk,
	})
	if (health.healthy) return { healthy: true, output: health.output }
	// Non-HTTP workload (queue worker, cron - no published/exposed port). The
	// HTTP probe can't judge it, so fall back to a docker-inspect liveness check:
	// running + not crash-looping.
	if (health.skipped) {
		const liveness = await livenessCheckContainer(opts.server, opts.containerName, { onChunk: opts.onChunk })
		return { healthy: liveness.alive ? 'skipped' : false, output: health.output + liveness.output }
	}
	return { healthy: false, output: health.output }
}

// Roll the app back to its most recent SUCCESSFUL tagged deploy: restore the env
// file that image last ran with, retag + recreate, then run the SAME health gate
// against the result - a rollback is only "done" when the old version actually
// serves. Used after a failed health gate AND after a deploy that died during /
// after `docker compose up` (the up-retry path may already have removed the old
// container, so doing nothing there leaves the app DOWN).
export async function autoRollback(opts: {
	server: ServerConfig
	serverId: string
	containerName: string
	configFile: string
	service: string
	composeFiles?: string[]
	/** Compose working dir (the per-app lock path derives from it). */
	workingDir: string
	currentDeployId: string
	reason: string
	onChunk?: (chunk: string) => void
}): Promise<{ output: string; rolledBackTo: string | null; rollbackError: string | null; rollbackHealthy: boolean | null }> {
	const say = (line: string) => {
		opts.onChunk?.(line)
		return line
	}
	let output = ''
	const [prev] = await db
		.select()
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, opts.serverId),
				eq(deploys.containerName, opts.containerName),
				eq(deploys.status, 'success'),
				sql`${deploys.imageTag} IS NOT NULL`,
				sql`${deploys.id} <> ${opts.currentDeployId}`,
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	if (!prev || !prev.imageTag) {
		output += say('\n[rollback] no previous tagged deploy available - leaving the current state in place for a manual fix\n')
		return { output, rolledBackTo: null, rollbackError: null, rollbackHealthy: null }
	}

	// The name the service's image goes by - rollbackToImage retags the historical
	// image to it. From the live container when there is one; after a failed `up`
	// there may be none, so ask compose.
	let currentImage: string | null = null
	try {
		currentImage = (await inspectContainer(opts.server, opts.containerName)).image
	} catch {
		const r = await runCommand(
			opts.server,
			`docker compose ${composeFileArgs(opts.configFile, opts.composeFiles)} ${ALL_PROFILES} config --images ${shellQuote(opts.service)} 2>/dev/null | head -1`,
			20_000,
		).catch(() => null)
		currentImage = r?.code === 0 ? r.stdout.trim() || null : null
	}
	if (!currentImage) {
		output += say('\n[rollback] could not determine the service image name (container gone and compose config unreadable)\n')
		return { output, rolledBackTo: null, rollbackError: 'could not determine the service image', rollbackHealthy: null }
	}

	output += say(`\n── auto-rollback (${opts.reason}) → ${prev.imageTag} ──\n`)
	try {
		const envPath = (await envFileCandidatesFor(opts.server, opts.containerName))[0]
		if (envPath) output += say((await restoreEnvSnapshot(opts.server, envPath, prev.id)).output)
	} catch (err) {
		output += say(`[env] could not restore the env snapshot (${err instanceof Error ? err.message : err}) - rolling back with the current env\n`)
	}
	try {
		// the deploy's compose guard on the compose on disk (after the env restore).
		const { checkComposeForRecreate } = await import('./recreate-guard')
		const approval = await checkComposeForRecreate(opts.server, {
			app: opts.containerName,
			configFile: opts.configFile,
			composeFiles: opts.composeFiles,
			workingDir: opts.workingDir,
			what: 'auto-rollback',
		})
		const result = await rollbackToImage(
			opts.server,
			opts.configFile,
			opts.service,
			prev.imageTag,
			currentImage,
			opts.onChunk,
			{ composeFiles: opts.composeFiles, workingDir: opts.workingDir, app: opts.containerName, approval },
		)
		output += result.output
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'rollback failed'
		output += say(`\n[rollback] failed: ${msg}\n`)
		return { output, rolledBackTo: null, rollbackError: msg, rollbackHealthy: null }
	}
	output += say('\n── post-rollback health check ──\n')
	const after = await runHealthGate({
		server: opts.server,
		serverId: opts.serverId,
		containerName: opts.containerName,
		onChunk: opts.onChunk,
	})
	output += after.output
	const rollbackHealthy = after.healthy !== false
	if (!rollbackHealthy) output += say('\n[rollback] the rolled-back version is ALSO unhealthy - the app needs a manual fix\n')
	return { output, rolledBackTo: prev.imageTag, rollbackError: null, rollbackHealthy }
}

/** One-line outcome for a deploy that ended in a rollback attempt. */
export function rollbackSummary(
	reason: string,
	rb: { rolledBackTo: string | null; rollbackError: string | null; rollbackHealthy: boolean | null },
): string {
	if (rb.rolledBackTo)
		return rb.rollbackHealthy === false
			? `${reason}; auto-rolled back to ${rb.rolledBackTo}, but the rolled-back version is ALSO unhealthy`
			: `${reason}; auto-rolled back to ${rb.rolledBackTo}`
	if (rb.rollbackError) return `${reason}; rollback also failed: ${rb.rollbackError}`
	return `${reason}; no previous tagged image to roll back to (left the current state in place)`
}

// Hand a just-claimed row back to the queue (worker shutting down). Returns what
// happened. A newer 'queued' row of the same app (two partial unique indexes: one
// running + one queued per app) already covers it: it builds the branch HEAD,
// which includes this push, so this row is closed instead of duplicated.
export async function requeueClaimedDeploy(id: string): Promise<'requeued' | 'folded' | 'gone'> {
	// The NOT EXISTS guard skips the flip when a queued sibling holds the
	// deploys_queued_unique slot, so the expected conflict never reaches the
	// index as a 23505 (which postgres would log as an ERROR). A sibling that
	// vanishes between the guard and the re-read gets another try; after that a
	// plain flip, so the row is never failed while nothing covers it.
	const flip = (guarded: boolean) =>
		db
			.update(deploys)
			.set({ status: 'queued', heartbeatAt: null })
			.where(
				and(
					eq(deploys.id, id),
					eq(deploys.status, 'running'),
					guarded
						? sql`NOT EXISTS (SELECT 1 FROM deploys q WHERE q.server_id = deploys.server_id AND q.container_name = deploys.container_name AND q.status = 'queued')`
						: undefined,
				),
			)
			.returning({ id: deploys.id })
	try {
		let covered = false
		for (let attempt = 0; attempt < 3 && !covered; attempt++) {
			if ((await flip(true)).length > 0) return 'requeued'
			const [still] = await db
				.select({
					id: deploys.id,
					covered: sql<boolean>`EXISTS (SELECT 1 FROM deploys q WHERE q.server_id = deploys.server_id AND q.container_name = deploys.container_name AND q.status = 'queued')`,
				})
				.from(deploys)
				.where(and(eq(deploys.id, id), eq(deploys.status, 'running')))
				.limit(1)
			if (!still) return 'gone'
			covered = still.covered
		}
		if (!covered) return (await flip(false)).length > 0 ? 'requeued' : 'gone'
	} catch (err) {
		// Fallback: a queued sibling inserted between the guard and the write.
		if (!isPgError(err, '23505')) throw err
	}
	await finishDeploy(id, {
		status: 'failed',
		error: 'worker shut down while claiming this deploy; a newer queued deploy of the app covers it',
		failedStep: 'superseded',
		errorSummary: 'worker shut down; folded into the newer queued deploy',
	})
	return 'folded'
}

// Atomically claim the oldest 'queued' deploy whose server is NOT already busy
// in this worker, flipping it to 'running'. Returns null when nothing claimable.
//
// `excludeServerIds` are the servers this worker is currently deploying to -
// we skip them so a server runs at most one deploy at a time (matching the old
// runOnServer per-server serialization) while different servers run in parallel.
//
// FOR UPDATE SKIP LOCKED makes the SELECT robust if this ever runs as more than
// one worker: each claims a different row instead of colliding on the same one.
// FIFO by queuedAt (insert time, never overwritten on claim).
// startedAt is reset to claim time so the watchdog's 15-min stuck-'running'
// reap measures execution time, not time spent waiting in the queue.
export async function claimNextQueuedDeploy(
	excludeServerIds: string[] = [],
): Promise<Deploy | null> {
	try {
		return await claimInTx(excludeServerIds)
	} catch (err) {
		// Fallback: an inline running insert committed between the guard and the
		// flip. The row stays queued; the next poll picks it up.
		if (isPgError(err, '23505')) return null
		throw err
	}
}

function claimInTx(excludeServerIds: string[]): Promise<Deploy | null> {
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({ id: deploys.id })
			.from(deploys)
			.where(
				and(
					eq(deploys.status, 'queued'),
					// Settle window (deploy-settle.ts heldSql): a held push is not claimable before
					// its not_before, unless the app's window has since been switched off. NULL
					// not_before (every row while the window is off) = claim as before.
					sql`NOT ${sql.raw(heldSql('"deploys"', new Date()))}`,
					excludeServerIds.length ? notInArray(deploys.serverId, excludeServerIds) : undefined,
					// A queued row can now wait behind a RUNNING deploy of the same app
					// (0035). Never claim it while that one runs - inline routes run
					// outside this worker, so excludeServerIds can't see them.
					sql`NOT EXISTS (SELECT 1 FROM deploys r WHERE r.server_id = ${deploys.serverId} AND r.container_name = ${deploys.containerName} AND r.status = 'running')`,
				),
			)
			.orderBy(asc(deploys.queuedAt))
			.limit(1)
			.for('update', { skipLocked: true })
		if (!candidate) return null
		const [row] = await tx
			.update(deploys)
			.set({ status: 'running', startedAt: new Date() })
			.where(
				and(
					eq(deploys.id, candidate.id),
					// The flip itself re-checks the running slot: an inline running row
					// inserted since the SELECT leaves this one queued (0 rows → null)
					// instead of raising 23505 on deploys_running_unique.
					sql`NOT EXISTS (SELECT 1 FROM deploys r WHERE r.server_id = deploys.server_id AND r.container_name = deploys.container_name AND r.status = 'running')`,
				),
			)
			.returning()
		// A held push carried its "[settle] waiting until ..." line in output; drop it now
		// it runs, so the live log (stream route deltas on output) starts from the build.
		// Only that line: a "[settle] released early ..." line stays in the log.
		if (row?.output?.startsWith(`[settle] ${SETTLE_WAITING_PREFIX}`)) {
			await tx.update(deploys).set({ output: null }).where(eq(deploys.id, row.id))
			row.output = null
		}
		return row ?? null
	})
}

/** git_sha of the app's most recent SUCCESSFUL git deploy (null if none). */
export async function lastSuccessfulGitSha(serverId: string, containerName: string): Promise<string | null> {
	const [row] = await db
		.select({ gitSha: deploys.gitSha })
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, serverId),
				eq(deploys.containerName, containerName),
				eq(deploys.kind, 'git_deploy'),
				eq(deploys.status, 'success'),
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	return row?.gitSha ?? null
}

/** compose_config_hash of the app's most recent SUCCESSFUL deploy that recorded one
 *  (0056; null if none). The compose guard enforces the high-severity rules when the
 *  config it probes hashes differently. */
export async function lastSuccessfulComposeHash(serverId: string, containerName: string): Promise<string | null> {
	const [row] = await db
		.select({ h: deploys.composeConfigHash })
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, serverId),
				eq(deploys.containerName, containerName),
				eq(deploys.status, 'success'),
				isNotNull(deploys.composeConfigHash),
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	return row?.h ?? null
}

/** compose_config_view (0062) of the app's most recent SUCCESSFUL deploy that stored
 *  `hash` as its compose_config_hash; null when that deploy stored none (an older row). */
export async function lastSuccessfulComposeView(serverId: string, containerName: string, hash: string | null): Promise<unknown> {
	if (!hash) return null
	const [row] = await db
		.select({ v: deploys.composeConfigView })
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, serverId),
				eq(deploys.containerName, containerName),
				eq(deploys.status, 'success'),
				eq(deploys.composeConfigHash, hash),
				isNotNull(deploys.composeConfigView),
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	return row?.v ?? null
}

/** Webhook replay guard: git_sha of the app's last `limit` SUCCESSFUL git deploys, newest first. The webhook
 *  ignores a push whose `after` is in this set (a replayed older signed push must not roll
 *  the app back or force a rebuild), unless the body carries powder_force. */
export async function recentSuccessfulGitShas(serverId: string, containerName: string, limit = 20): Promise<string[]> {
	const rows = await db
		.select({ gitSha: deploys.gitSha })
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, serverId),
				eq(deploys.containerName, containerName),
				eq(deploys.kind, 'git_deploy'),
				eq(deploys.status, 'success'),
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(limit)
	return [...new Set(rows.map((r) => r.gitSha).filter((x): x is string => !!x))]
}

// Per-app deploy list (dashboard app page, MCP list_deploys via the same
// route). Named columns only, and output/error cut to their last
// LIST_LOG_TAIL_CHARS: full rows carry every deploy's whole build log, which
// can be many MB. The full log stays on /deploys/<id> and
// GET /api/deploys/<id>. Columns not listed here are not read by any caller.
export const LIST_LOG_TAIL_CHARS = 16 * 1024
const LOG_CUT_NOTE = '[earlier output cut here, open the deploy for the full log]\n'

// `col` is a deploys text column (drizzle interpolates it as the column name).
const logTail = (col: unknown) =>
	sql<string | null>`CASE WHEN length(${col}) > ${LIST_LOG_TAIL_CHARS} THEN ${LOG_CUT_NOTE} || right(${col}, ${LIST_LOG_TAIL_CHARS}) ELSE ${col} END`

// A function, not a module-level object: tests mock './db' without `deploys`,
// and touching its columns at import time would break every importer.
export const deployListColumns = () => ({
	id: deploys.id,
	serverId: deploys.serverId,
	containerName: deploys.containerName,
	kind: deploys.kind,
	status: deploys.status,
	queuedAt: deploys.queuedAt,
	startedAt: deploys.startedAt,
	finishedAt: deploys.finishedAt,
	output: logTail(deploys.output),
	error: logTail(deploys.error),
	failedStep: deploys.failedStep,
	exitCode: deploys.exitCode,
	errorSummary: deploys.errorSummary,
	triggeredBy: deploys.triggeredBy,
	gitSha: deploys.gitSha,
	gitBranch: deploys.gitBranch,
	imageTag: deploys.imageTag,
	rolledBackFromId: deploys.rolledBackFromId,
	snapshotUrl: deploys.snapshotUrl,
	snapshotExpiresAt: deploys.snapshotExpiresAt,
	notBefore: deploys.notBefore,
})

export type DeployListRow = Pick<
	Deploy,
	Exclude<keyof ReturnType<typeof deployListColumns>, 'output' | 'error'>
> & {
	output: string | null
	error: string | null
	/** Set while the row is held on its settle window (deploy-settle.ts settleNote). */
	waiting: string | null
}

export async function listDeploysFor(
	serverId: string,
	containerName: string,
	limit = 20,
): Promise<DeployListRow[]> {
	const rows = await db
		.select(deployListColumns())
		.from(deploys)
		.where(and(eq(deploys.serverId, serverId), eq(deploys.containerName, containerName)))
		.orderBy(desc(deploys.startedAt))
		.limit(limit)
	// Deploy text is masked at write (finishDeploy); masked again here so rows
	// written before that (or by any older path) never leave unmasked.
	return rows.map((r) => ({
		...r,
		output: redactNullable(r.output),
		error: redactNullable(r.error),
		errorSummary: redactNullable(r.errorSummary),
		waiting: settleNote(r),
	}))
}
