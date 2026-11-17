// The one place a deploy actually executes. Both the in-process (in-web
// mode, POWDER_DEPLOY_WORKER off) path and the deploy-worker call this with an already-'running' deploy
// row. It unifies the three trigger routes (webhook, git-deploy, manual
// redeploy) so none carries its own fire-and-forget IIFE: derive compose info, render env, build, health-gate (+auto-rollback),
// finish, then the best-effort tail (GH status, failure email, ship post,
// domain sync, image prune).
//
// Streaming: every chunk is (a) published to the in-memory deploy-bus and (b)
// accumulated and debounce-flushed to deploys.output. Terminal events ('end' /
// 'error') are published too. The bus reaches an SSE subscriber only when it
// lives in THIS process, i.e. in-web mode, where the deploy runs in the web process.
// In worker mode the worker process has no subscribers, so every publish is a
// harmless no-op there and the web SSE route instead polls deploys.output (the
// debounce-flush) for live output and the row's status for the terminal flip.

import { applyDomainsToCompose, routeHostsFor } from './app-domains'
import { defaultHostFor } from './app-hosts'
import { UnsafeOverrideError } from './compose-override-io'
import { isTraefikServer } from './traefik-servers'
import { and, appRepos, db, deploys, eq, gte, previewDeploys } from './db'
import type { AppRepo, Deploy } from './db'
import { chunkPublisher, publishTerminal } from './deploy-bus'
import { deployDeadlineAt } from './deploy-budget'
import { deployFailureFromError } from './deploy-failure'
import { SUPERSEDED_MARKER, isSupersededBy } from './deploy-supersede'
import { runOnServer } from './deploy-queue'
import { autoRollback, finishDeploy, lastSuccessfulComposeHash, lastSuccessfulComposeView, lastSuccessfulGitSha, resolveHealthProbe, rollbackSummary, verifyDeployHealth } from './deploys'
import { notifyDeploymentFinished } from './github-deployments'
import { extractBuilderFallback, healthUrlState, portsLeftPublicLines, reportDeployToHq, reportDeployWarningsToHq } from './hq'
import { notifyDeployFailed, notifyDeploySucceeded } from './notifications'
import { getServer } from './servers'
import type { ServerConfig } from './servers'
import {
	inspectContainer,
	rebuildDeploy,
	resolveSwapCheckPlan,
	runCommand,
	snapshotEnvForDeploy,
	removeLeakedBridges,
	tagDeployImage,
	verifyRunningImage,
} from './ssh'
import { restoreSharedTagAfterAbort } from './deploy/run'
import { parseComposeView } from './deploy/compose-diff'
import { lockedPruneShell } from './deploy/prune-lock'
import { loadDeployPushDecision } from './deploy-push'
import { backupEnvBeforeRender, dropEnvPreRender, recordEnvRender, restoreEnvBeforeRender } from './ssh/files'
import { CappedOutput } from './capped-output'
import { syncDeploymentMd } from './sync-deployment-md'
import { dashboardUrl } from './hosts'
import { type SafeText, redactSecrets } from './secret-text'

const PARTIAL_FLUSH_MS = 1500
// Executor liveness stamp (deploys.heartbeat_at, 0035). The watchdog reaps a
// running row whose stamp goes stale — i.e. this process died — instead of
// guessing from elapsed time, which false-reaped long-but-alive deploys.
const HEARTBEAT_MS = 30_000

// Remote-script phases that run AFTER the old container may already be gone
// (the up-retry path removes it). A failure here must roll back, not just be
// recorded — otherwise the app is left DOWN.
const POST_SWAP_STEPS = new Set(['docker compose up', 'normalize (enforce restart + mem cap)', 'resolve image'])

/** Should a failed deploy trigger an auto-rollback? Pure (exported for tests).
 *  `containerRunning` = the app container is up right now (null = unknown). */
export function shouldRollbackAfterFailure(
	failedStep: string | null,
	containerRunning: boolean | null,
): boolean {
	if (failedStep && POST_SWAP_STEPS.has(failedStep)) return true
	// No step marker (SSH drop, deadline kill, thrown error): judge by outcome —
	// if the app is not running now, restoring the last good version is the only
	// way back. A known PRE-swap step (build, test gate, migrate…) never touched
	// the running container, so a stopped app there was already stopped.
	if (!failedStep) return containerRunning === false
	return false
}

/** Restore the pre-render env file after this failure? Only when the failure is
 *  a KNOWN pre-swap step: the old container still serves, so the old env must
 *  stay on disk. A post-swap or unknown failure keeps the new env (the auto
 *  rollback restores the previous deploy's env itself). Pure (exported for tests). */
export function shouldRestoreEnv(failedStep: string | null): boolean {
	return !!failedStep && !POST_SWAP_STEPS.has(failedStep) && failedStep !== 'superseded'
}

interface ComposeFacts {
	configFile: string
	service: string
	workingDir: string
	composeFiles: string[]
	/** compose project label of the running container (null: no container yet) */
	project: string | null
}

// Compose info: prefer the running container's labels; fall back to the
// /opt/apps/<name> convention ONLY when the container doesn't exist (a first
// deploy that failed before). Any other inspect failure (SSH timeout,
// daemon hiccup) fails the deploy instead of deploying with a GUESSED
// compose file + service. A container that exists
// without compose labels was started via raw `docker run`; we can't drive it.
// The fallback is for a registered app or preview only: a name with neither row
// and no container is a deleted app (a push queued during the delete, a catch-up
// retry), and guessing its compose file would rebuild and start it untracked.
export async function resolveComposeFacts(server: ServerConfig, containerName: string, registered: boolean): Promise<ComposeFacts> {
	try {
		const c = (await inspectContainer(server, containerName)).compose
		if (!c.configFile || !c.service || !c.workingDir) {
			throw new Error(
				`container has no compose labels (started via raw 'docker run' instead of 'docker compose up'?). configFile=${c.configFile} service=${c.service} workingDir=${c.workingDir}`,
			)
		}
		return { configFile: c.configFile, service: c.service, workingDir: c.workingDir, composeFiles: c.configFiles, project: c.project ?? null }
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!/no such (object|container)/i.test(msg)) throw err
		if (!registered) {
			throw new Error(
				`refused: ${containerName} is not a registered app or preview on this server and has no container (deleted?). Nothing was built or started.`,
			)
		}
		const workingDir = `/opt/apps/${containerName}`
		return { configFile: `${workingDir}/docker-compose.yml`, service: containerName, workingDir, composeFiles: [], project: null }
	}
}

/** In-web mode (POWDER_DEPLOY_WORKER off) fire-and-forget: never an unhandled rejection in web. */
export function runInWeb(deploy: Deploy): void {
	executeDeploy(deploy).catch((err) => console.error(`[deploy-runner ${deploy.id}] in-web execution threw:`, err))
}

export async function executeDeploy(deploy: Deploy): Promise<void> {
	const { serverId, containerName } = deploy

	// Accumulate streamed output and debounce-flush it to the row so a cross-
	// process SSE reader sees partial logs. finishDeploy writes the canonical
	// full output at the end, so the flush is a best-effort live mirror only.
	// Everything entering `acc` or the bus is masked first (lib/secret-text.ts):
	// chunks through the line-buffered stream redactor, other text via accPush.
	const acc = new CappedOutput()
	const stream = chunkPublisher(deploy.id)
	const accPush = (s: string) => acc.push(redactSecrets(s))
	let dirty = false
	const flush = async () => {
		if (!dirty) return
		dirty = false
		try {
			await db.update(deploys).set({ output: acc.toString() }).where(eq(deploys.id, deploy.id))
		} catch (err) {
			console.error(`[deploy-runner ${deploy.id}] partial flush failed:`, err)
		}
	}
	// Started INSIDE the try below, so an early throw can never leak them.
	let flushTimer: ReturnType<typeof setInterval> | undefined
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined
	const onChunk = (chunk: string) => {
		acc.push(stream.chunk(chunk))
		dirty = true
	}
	// End of the stream: emit the held-back partial line.
	const drain = () => {
		acc.push(stream.flush())
		dirty = true
	}
	const beat = async () => {
		try {
			await db
				.update(deploys)
				.set({ heartbeatAt: new Date() })
				.where(and(eq(deploys.id, deploy.id), eq(deploys.status, 'running')))
		} catch (err) {
			console.error(`[deploy-runner ${deploy.id}] heartbeat failed:`, err)
		}
	}

	let repo: AppRepo | undefined
	let sha: string | null = null
	let br: string | null = null
	// Hoisted so the failure path can roll back with the same compose facts.
	let server: ServerConfig | null = null
	let facts: ComposeFacts | null = null
	// Set once the pre-render copy of the env file exists (see renderEnv).
	const envBackup: { path: string | null } = { path: null }
	try {
		flushTimer = setInterval(() => void flush(), PARTIAL_FLUSH_MS)
		void beat()
		heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS)
		;[repo] = await db
			.select()
			.from(appRepos)
			.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
			.limit(1)

		server = (await getServer(serverId)) ?? null
		if (!server) throw new Error(`server ${serverId} not found`)
		const srv = server
		const f = await resolveComposeFacts(srv, containerName, !!repo || (await isPreviewContainer(serverId, containerName)))
		facts = f

		// Render env vars DB → compose env_file before the build. No-op when
		// POWDER_ENV_VARS_DB_MODE is off or the project has no DB vars yet. The
		// drift guard REFUSES (keeps disk file) if disk has keys the DB lacks; we
		// surface that as a banner rather than silently clobbering. A render that
		// ERRORS (the file couldn't be read or written) stops the deploy before
		// the build: shipping new code on a silently stale env is the worse
		// outcome, and nothing has been touched yet, so the old version serves on.
		let notRunning = false
		let envWarningBanner = ''
		let envRefusedKeys: string[] | null = null
		let renderedEnvPath: string | null = null
		// the env file this deploy renders (or would, when the drift guard refused).
		let envTarget: string | null = null
		if (repo) {
			const rendered = await renderEnv(srv, repo, onChunk, deploy.id, envBackup)
			renderedEnvPath = rendered.path
			envTarget = rendered.target
			envRefusedKeys = rendered.refusedKeys
			if (rendered.banner) {
				envWarningBanner = rendered.banner
				acc.prepend(redactSecrets(envWarningBanner))
				dirty = true
			}
		}

		// Domain labels for THIS deploy are written into the compose file BEFORE the
		// build (file only, no `up`), so the deploy script's single `compose up`
		// carries the final labels and a normal deploy needs no second recreate.
		// A failure here stops the deploy before the build, nothing is touched.
		let domainPreNote = ''
		let labelFacts: {
			workingDir: string
			service: string
			configFile: string
			composeFiles: string[]
		} | null = null
		if (repo && (await isTraefikServer(srv))) {
			labelFacts = {
				workingDir: f.workingDir,
				service: f.service,
				configFile: f.configFile,
				composeFiles: f.composeFiles,
			}
			try {
				await applyDomainsToCompose(repo, labelFacts, { fileOnly: true })
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err)
				if (err instanceof UnsafeOverrideError) {
					// The only fatal case: the rewrite broke the compose safety check (original restored).
					const msg = `domain labels override refused - ${detail}. Deploy stopped before the build; nothing was touched.`
					onChunk(`── domain labels ──\n${msg}\n__POWDER_FAIL__ step=domain labels code=1\n`)
					throw new Error(`${msg}\n__POWDER_FAIL__ step=domain labels code=1`)
				}
				// Best effort, like the post-build sync: note it and carry on. labelFacts is
				// kept, so the post-build sync below still gets a chance to apply the labels.
				console.error('[powder.json] pre-build label rewrite failed:', err)
				domainPreNote = `\n── domain labels (pre) ──\ndomain labels (pre) FAILED: ${detail}\n`
				onChunk(domainPreNote)
			}
		}

		// Per-server serializer: one build at a time per server so simultaneous
		// pushes don't OOM the server with parallel `next build`s. In worker mode
		// the worker already gates one deploy per server, so this is belt-and-
		// suspenders; in in-web mode it's the only serialization.
		const {
			output,
			sha: builtSha,
			branch: builtBranch,
			image,
			composeHash,
			composeView,
			superseded,
			portsLeftPublic,
			bridgeVerdict,
			nginxUpstreamVerdict,
			stability,
		} = await runOnServer(serverId, async () => {
			// Taken INSIDE the per-server slot: time spent waiting for the slot must
			// not burn the budget, the ordinal or the watchdog's hard cap. If the row
			// was reaped/finished while we waited, do not touch the server at all.
			const [claimed] = await db
				.update(deploys)
				.set({ startedAt: new Date(), heartbeatAt: new Date() })
				.where(and(eq(deploys.id, deploy.id), eq(deploys.status, 'running')))
				.returning({ startedAt: deploys.startedAt })
			if (!claimed) {
				notRunning = true
				return { output: '', sha: null, branch: null, image: null, composeHash: null, composeView: null, superseded: false, portsLeftPublic: [], bridgeVerdict: null, nginxUpstreamVerdict: null, stability: null }
			}
			const startedAt = claimed.startedAt
			// DB-side supersede guard: a newer deploy of this app is already running
			// or succeeded (this row was reaped/restarted underneath it), so do not
			// touch the server at all. The script re-checks on the server (the authority).
			const newer = await findSupersedingDeploy(deploy)
			if (newer) {
				return {
					output: `${SUPERSEDED_MARKER} newer deploy ${newer} already started for this app; skipping build and swap\n`,
					sha: null,
					branch: null,
					image: null,
					composeHash: null,
					composeView: null,
					superseded: true,
					portsLeftPublic: [],
					bridgeVerdict: null,
					nginxUpstreamVerdict: null,
					stability: null,
				}
			}
			// Dedicated-builder opts (servers.build_host): decrypt the app's RO
			// deploy key so the builder can clone. Registry-mode and repo-less
			// apps skip the builder path inside rebuildDeploy.
			let builder: { host: string; repoUrl: string; deployKeyPriv: string } | undefined
			if (srv.buildHost && repo?.repoUrl && repo?.deployKeyPrivEncrypted) {
				try {
					const { decryptSecret } = await import('./crypto')
					builder = {
						host: srv.buildHost,
						repoUrl: repo.repoUrl,
						deployKeyPriv: decryptSecret(repo.deployKeyPrivEncrypted),
					}
				} catch (err) {
					console.error(`[deploy-runner ${deploy.id}] builder key decrypt failed:`, err)
				}
			}
			// Pre-swap candidate probe plan (off via POWDER_SWAP_CHECK=off or
			// app_repos.swap_check=false). Resolution failures degrade to "skipped":
			// the probe is a safety net and must never be what breaks a deploy.
			let swapCheck: ReturnType<typeof resolveSwapCheckPlan> | undefined
			try {
				const probe = await resolveHealthProbe(serverId, containerName)
				swapCheck = resolveSwapCheckPlan({ appFlag: repo?.swapCheck, env: process.env, probe })
			} catch (err) {
				swapCheck = { skip: `plan failed: ${err instanceof Error ? err.message.slice(0, 80) : 'error'}` }
			}
			// Ancestry base for the webhook forward-only check when the server has no HEAD.
			const baseSha = await lastSuccessfulGitSha(serverId, containerName).catch(() => null)
			// Compose guard: the config hash the last successful deploy ran with (0056).
			const approvedComposeHash = await lastSuccessfulComposeHash(serverId, containerName).catch(() => null)
			// and what that config looked like, so a refusal can say what changed.
			const approvedComposeView = parseComposeView(
				await lastSuccessfulComposeView(serverId, containerName, approvedComposeHash).catch(() => null),
			)
			// Compose guard: on a Traefik server the app may only route its own verified hosts.
			// the same list is checked on any server where the probe sees a
			// Docker-provider proxy running (proxyRouteHosts), whatever servers.proxy says.
			// A failed lookup refuses on a traefik server (as before) and, elsewhere, leaves no host
			// allowed: it matters only when a proxy is seen, and then fails closed.
			const hostsOf = async () =>
				repo
					? await routeHostsFor(srv, repo.id, containerName)
					: [defaultHostFor(srv, containerName)].filter((h): h is string => !!h)
			const routeHosts = (await isTraefikServer(srv)) ? await hostsOf() : null
			const ownRouteHosts = routeHosts ?? (await hostsOf().catch((): string[] => []))
			// Compose guard: the other apps on this server, whose local images a
			// service without a build section may not run.
			const otherApps = await otherAppsOnServer(serverId, containerName)
			// this app's BuildKit cache namespace (per-app salt in powder_meta).
			const { loadCacheNamespace } = await import('./build-cache')
			const cacheNamespace = await loadCacheNamespace(serverId, containerName)
			return rebuildDeploy(srv, f.workingDir, f.configFile, f.service, deploy.id, onChunk, {
				cacheNamespace,
				composeGuard: { routeHosts, proxyRouteHosts: ownRouteHosts, otherApps, envTarget },
				swapCheck,
				buildMode: repo?.buildMode,
				builder,
				migrateApp: containerName,
				selfIdentity: { containerName, composeProject: f.project },
				branch: repo?.branch ?? null,
				sha: deploy.requestedSha ?? null,
				baseSha,
				approvedComposeHash,
				approvedComposeView,
				composeFiles: f.composeFiles,
				swapOrdinal: new Date(startedAt).getTime(),
				deadlineAt: deployDeadlineAt(startedAt),
			})
		})
		if (notRunning) {
			// Reaped while waiting for the slot: nothing was built, so the env the render
			// replaced must go back (the old container still serves).
			if (envBackup.path) {
				await restoreEnvBeforeRender(srv, envBackup.path, deploy.id).catch((e) =>
					console.error(`[deploy-runner ${deploy.id}] env restore failed:`, e),
				)
			}
			console.warn(`[deploy-runner ${deploy.id}] row is no longer running (reaped while queued for the server); skipping`)
			return
		}
		// a flag, not a search of the output (build output could print the marker).
		if (superseded) {
			// Not a failure and not a success: this deploy lost to a newer one and
			// deliberately did nothing. No health gate (it would judge the NEWER
			// deploy's containers), no rollback, no failure email.
			const msg = redactSecrets(
				`superseded by a newer deploy of ${containerName}; this older deploy did not build or swap`,
			)
			drain()
			await finishDeploy(deploy.id, {
				status: 'failed',
				output: `${envWarningBanner}${output}`,
				error: msg,
				failedStep: 'superseded',
				errorSummary: msg,
			}).catch((e) => console.error(`[deploy-runner ${deploy.id}] finishDeploy(superseded) failed:`, e))
			publishTerminal(deploy.id, 'end', 'superseded')
			if (repo) await notifyDeploymentFinished(repo, deploy.id, 'failure', msg)
			return
		}
		sha = builtSha
		br = builtBranch
		if (sha || br) {
			await db.update(deploys).set({ gitSha: sha, gitBranch: br }).where(eq(deploys.id, deploy.id))
		}

		// Domain/powder.json sync. It may recreate the container (only when the
		// rewritten compose differs), so it runs BEFORE the health gate: the gate
		// then judges the container that will actually keep serving. Awaited while
		// this deploy still owns the slot (it takes the per-app lock on the server),
		// never fire-and-forget after the worker freed the server.
		let domainNote = ''
		if (repo && labelFacts) {
			try {
				// Safety net: the file already has this deploy's labels, so this is a no-op
				// (no `up`) unless something changed since, e.g. powder.json in the new checkout.
				await applyDomainsToCompose(repo, labelFacts)
			} catch (err) {
				console.error('[powder.json] sync failed:', err)
				domainNote = `\n── domain sync ──\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`
				onChunk(domainNote)
			}
		}

		const health = await verifyDeployHealth({
			server: srv,
			serverId,
			containerName,
			configFile: f.configFile,
			service: f.service,
			composeFiles: f.composeFiles,
			workingDir: f.workingDir,
			currentDeployId: deploy.id,
			onChunk,
		})
		const fullOutput = `${envWarningBanner}${output}\n${health.output}`

		if (health.healthy === false) {
			const errorMessage = redactSecrets(rollbackSummary('health check failed', health))
			drain()
			await failDeploy(deploy, repo, sha, br, {
				output: fullOutput,
				error: errorMessage,
				failedStep: 'health check',
				errorSummary: errorMessage,
			})
			return
		}

		// Truth readback: is the container actually running the image we just
		// built/pulled? A mismatch = the "reports success but ships old code"
		// class — fail the deploy loudly instead. No auto-rollback here: the
		// running (old) image IS the previous good state.
		const readback = await verifyRunningImage(srv, containerName)
		onChunk(`\n── image readback ──\n${readback.detail}\n`)
		if (!readback.match) {
			const errorMessage = redactSecrets(`image readback failed: ${readback.detail}`)
			drain()
			await failDeploy(deploy, repo, sha, br, {
				output: `${fullOutput}\n── image readback ──\n${readback.detail}\n`,
				error: errorMessage,
				failedStep: 'image readback',
				errorSummary: errorMessage,
			})
			return
		}

		// A bridge that outlived its deploy (SIGKILL path) would keep serving the
		// OLD image behind Traefik: remove it now that the new one is proven good.
		const leaked = await removeLeakedBridges(srv, f.workingDir, f.service)
		if (leaked) onChunk(leaked)

		// Proven good → NOW it becomes a rollback target. Tagging before the gate
		// let failed deploys fill the prune's newest-N `:deploy-*` slots and evict
		// the last good image. Env snapshot likewise: a rollback to THIS deploy
		// restores the env it actually ran with.
		let tagOutput = ''
		if (image) {
			const tagged = await tagDeployImage(srv, image, deploy.id, await loadDeployPushDecision(containerName, image))
			tagOutput = `\n── tagging image ──\n${tagged.output}`
			onChunk(tagOutput)
			if (tagged.imageTag) {
				await db.update(deploys).set({ imageTag: tagged.imageTag }).where(eq(deploys.id, deploy.id))
			}
		}
		if (renderedEnvPath) {
			await snapshotEnvForDeploy(srv, renderedEnvPath, deploy.id).catch((err) =>
				console.error(`[deploy-runner ${deploy.id}] env snapshot failed:`, err),
			)
		}

		drain()
		await finishDeploy(deploy.id, {
			status: 'success',
			composeConfigHash: composeHash,
			composeConfigView: composeView ?? null,
			output: `${fullOutput}\n── image readback ──\n${readback.detail}\n${tagOutput}${domainPreNote}${domainNote}`,
		})
		publishTerminal(deploy.id, 'end', 'success')
		void reportDeployToHq({
			app: containerName,
			server: serverId,
			status: 'success',
			sha,
			branch: br,
			durationMs: deploy.startedAt ? Date.now() - new Date(deploy.startedAt).getTime() : null,
			deployId: deploy.id,
			deployKind: deploy.kind,
		})
		void reportDeployWarningsToHq({
			app: containerName,
			server: serverId,
			envRefusedKeys,
			builderFallback: extractBuilderFallback(fullOutput),
			portsLeftPublic: portsLeftPublicLines(portsLeftPublic),
			bridge: bridgeVerdict ?? null,
			nginxUpstream: nginxUpstreamVerdict ?? null,
			composeDrift: stability?.composeDrift ?? null,
			migratePath: stability?.migratePath ?? null,
			// no health_url: the gate accepted any 1xx-4xx from `/` (health.ts); only
			// when it judged HTTP at all (a worker's liveness fallback is n/a).
			healthUrl: healthUrlState(repo, health.healthy),
			testGate: stability?.testGate ?? null,
		})

		// ── best-effort tail (never fails the deploy) ──
		if (repo) {
			await notifyDeploymentFinished(
				repo,
				deploy.id,
				'success',
				redactSecrets(sha ? `deployed ${sha.slice(0, 7)}` : 'deployed'),
			)
			syncDeploymentMd(repo, sha)
				.then((res) => {
					if (!res.ok) {
						console.error(`[deployment-md] sync skipped for ${containerName}: ${res.reason}`)
					}
				})
				.catch((err) => console.error('[deployment-md] sync threw:', err))
			void notifyDeploySucceeded(repo, deploy.id, sha)
		}

		// Reclaim disk: dangling images + build cache, and per-repo deploy-tag
		// retention (keep 10 newest `<repo>:deploy-<id>` per repo, rmi the rest).
		// Every `:deploy-*` tag is a proven-good deploy now (tagged after the gate).
		void (async () => {
			try {
				// Under the hourly prune's lock, and the dangling-image prune only
				// while no image pull/build runs on the server (see deploy/prune-lock).
				const prune = lockedPruneShell({
					label: '[post-deploy-prune]',
					lockWaitSec: 240,
					busyWaitSec: 180,
					imagePrune: 'docker image prune -f >/dev/null 2>&1',
					rest: [
						'docker builder prune -f --filter unused-for=24h >/dev/null 2>&1',
						`docker images --format '{{.Repository}}|{{.Tag}}|{{.CreatedAt}}' 2>/dev/null \\
						| awk -F'|' '$2 ~ /^deploy-/' \\
						| sort -t'|' -k1,1 -k3r \\
						| awk -F'|' '{ if ($1 != prev) { c=0; prev=$1 } c++; if (c > 10) print $1 ":" $2 }' \\
						| xargs -r docker rmi -f >/dev/null 2>&1`,
					],
				})
				await runCommand(srv, prune, 540_000)
			} catch (err) {
				console.error('[post-deploy-prune] failed:', err)
			}
		})()
	} catch (err) {
		const fail = deployFailureFromError(err)
		// Failed BEFORE the swap: the old container still serves, so the env file
		// goes back to what it runs with (the render already replaced it).
		if (server && envBackup.path && shouldRestoreEnv(fail.failedStep)) {
			try {
				const r = await restoreEnvBeforeRender(server, envBackup.path, deploy.id)
				accPush(`\n${r.output}`)
			} catch (e) {
				accPush(`\n[env] could not restore the pre-render env file (${e instanceof Error ? e.message : e})\n`)
			}
		}
		// A deploy that died during/after the swap may have left the app with NO
		// running container (the up-retry removes the old one before its second
		// attempt). Roll back to the last good image exactly like a failed health
		// gate would, instead of only recording the failure.
		if (server && facts) {
			let running: boolean | null = null
			try {
				running = (await inspectContainer(server, containerName)).state === 'running'
			} catch (e) {
				running = /no such (object|container)/i.test(e instanceof Error ? e.message : String(e)) ? false : null
			}
			// No step marker + the app still runs: the script's EXIT trap may not have
			// run, so the shared tag could still point at the rejected build.
			if (!fail.failedStep && running !== false) {
				const note = await restoreSharedTagAfterAbort(server, {
					workingDir: facts.workingDir,
					service: facts.service,
					containerName,
				})
				if (note) accPush(note)
			}
			if (shouldRollbackAfterFailure(fail.failedStep, running)) {
				const rb = await autoRollback({
					server,
					serverId,
					containerName,
					configFile: facts.configFile,
					service: facts.service,
					composeFiles: facts.composeFiles,
					workingDir: facts.workingDir,
					currentDeployId: deploy.id,
					reason: `deploy failed during ${fail.failedStep ?? 'an unknown step'}`,
					onChunk,
				}).catch((e) => ({
					output: `\n[rollback] crashed: ${e instanceof Error ? e.message : e}\n`,
					rolledBackTo: null,
					rollbackError: e instanceof Error ? e.message : String(e),
					rollbackHealthy: null,
				}))
				fail.errorSummary = redactSecrets(rollbackSummary(fail.errorSummary, rb))
			}
		}
		drain()
		await failDeploy(deploy, repo, sha, br, { output: acc.toString(), ...fail })
	} finally {
		if (flushTimer) clearInterval(flushTimer)
		if (heartbeatTimer) clearInterval(heartbeatTimer)
		// The pre-render copy has done its job on every path (restore removes it itself).
		if (server && envBackup.path) await dropEnvPreRender(server, envBackup.path, deploy.id).catch(() => {})
	}
}

/** True when `containerName` is a preview container (preview_deploys) of an app on the server. */
async function isPreviewContainer(serverId: string, containerName: string): Promise<boolean> {
	const rows = await db
		.select({ id: previewDeploys.id })
		.from(previewDeploys)
		.innerJoin(appRepos, eq(previewDeploys.appRepoId, appRepos.id))
		.where(and(eq(appRepos.serverId, serverId), eq(previewDeploys.containerName, containerName)))
		.limit(1)
	return rows.length > 0
}

// Id of a deploy of the same app that started AFTER this one and is running or
// already succeeded, else null. A DB read failure never blocks a deploy (the
// on-server stamp check is the authority).
async function findSupersedingDeploy(deploy: Deploy): Promise<string | null> {
	try {
		const rows = await db
			.select({ id: deploys.id, status: deploys.status, kind: deploys.kind, startedAt: deploys.startedAt })
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, deploy.serverId),
					eq(deploys.containerName, deploy.containerName),
					gte(deploys.startedAt, deploy.startedAt),
				),
			)
			.limit(20)
		return isSupersededBy(deploy, rows)?.id ?? null
	} catch (err) {
		console.error(`[deploy-runner ${deploy.id}] supersede lookup failed (continuing):`, err)
		return null
	}
}

// DB → disk env render with the drift guard. Returns the rendered path (for the
// post-success snapshot) and the REFUSED banner, if any; throws when the render
// itself errored so the caller stops before building.
async function renderEnv(
	server: ServerConfig,
	repo: AppRepo,
	onChunk: (chunk: string) => void,
	deployId: string,
	envBackup: { path: string | null },
): Promise<{ path: string | null; target: string | null; banner: string; refusedKeys: string[] | null }> {
	const { prepareEnvFileForDeploy } = await import('./env-vars-db')
	let result: Awaited<ReturnType<typeof prepareEnvFileForDeploy>>
	try {
		result = await prepareEnvFileForDeploy(server, repo, 'production', {
			// Copy the file aside right before the render overwrites it.
			beforeWrite: async (path) => {
				await backupEnvBeforeRender(server, path, deployId)
				envBackup.path = path
			},
		})
	} catch (err) {
		const msg = `env render failed: ${err instanceof Error ? err.message : String(err)}. Deploy stopped before the build; the running version is untouched. Redeploy once the server is reachable.`
		onChunk(`── env render ──\n${msg}\n__POWDER_FAIL__ step=env render code=1\n`)
		throw new Error(`${msg}\n__POWDER_FAIL__ step=env render code=1`)
	}
	if (result.rendered) {
		// Remember what this render wrote so a late restore cannot clobber a newer deploy's env.
		await recordEnvRender(server, result.path, deployId).catch((e) => console.error(`[deploy-runner ${deployId}] recordEnvRender failed:`, e))
		return { path: result.path, target: result.path, banner: '', refusedKeys: null }
	}
	if ('unsafeTarget' in result && result.unsafeTarget) {
		const msg = `env render REFUSED: ${result.message} Deploy stopped before the build; the running version is untouched.`
		onChunk(`── env render ──\n${msg}\n__POWDER_FAIL__ step=env render code=1\n`)
		throw new Error(`${msg}\n__POWDER_FAIL__ step=env render code=1`)
	}
	if ('refused' in result && result.refused) {
		// Key names only: the old "(disk has sk_t…)" preview put secret prefixes
		// into deploys.output.
		const keyList = result.conflicts.map((c) => `  - ${c.key}`).join('\n')
		return {
			path: null,
			target: result.path,
			refusedKeys: result.conflicts.map((c) => c.key),
			banner: `── ⚠ env render REFUSED — disk has keys not in powder DB ──\nThe on-disk file at ${result.path} has ${result.conflicts.length} key(s) that powder DB does not know about. Rendering DB → disk would silently DELETE them.\nDisk-only keys:\n${keyList}\nBuild is proceeding with the EXISTING disk file. To resume DB → disk renders, sync these keys into powder via ${dashboardUrl()}/projects/${repo.id}/env\n──────────────────────────────────────────────────────────\n\n`,
		}
	}
	return { path: null, target: null, banner: '', refusedKeys: null }
}

// The single failure exit: row → failed, SSE error, HQ event, GitHub status,
// failure email. error/errorSummary are SafeText (they leave powder); output
// is masked by finishDeploy.
async function failDeploy(
	deploy: Deploy,
	repo: AppRepo | undefined,
	sha: string | null,
	br: string | null,
	fail: { output: string; error: SafeText; failedStep: string | null; exitCode?: number | null; errorSummary: SafeText },
): Promise<void> {
	await finishDeploy(deploy.id, { status: 'failed', ...fail }).catch((e) =>
		console.error(`[deploy-runner ${deploy.id}] finishDeploy(failed) failed:`, e),
	)
	publishTerminal(deploy.id, 'error', fail.errorSummary)
	void reportDeployToHq({
		app: deploy.containerName,
		server: deploy.serverId,
		status: 'failure',
		sha,
		branch: br,
		error: fail.errorSummary,
		deployId: deploy.id,
		deployKind: deploy.kind,
	})
	if (repo) {
		await notifyDeploymentFinished(repo, deploy.id, 'failure', fail.errorSummary)
		notifyDeployFailed(repo, {
			deployId: deploy.id,
			errorMessage: fail.errorSummary,
			gitSha: sha,
			gitBranch: br,
		}).catch((e) => console.error('[notify] deploy-failed webhook failed:', e))
	}
}

/** the other powder apps on a server (their container names), for the compose
 *  guard's image_foreign rule. Also the preview containers of the OTHER
 *  apps (preview_deploys; a preview's names belong to its parent app, so this app's
 *  own previews are left out). A failed lookup leaves its part empty (each
 *  query on its own); a lookup failure does not block the deploy. */
export async function otherAppsOnServer(serverId: string, self: string): Promise<string[]> {
	// two separate lookups, so a failed preview query keeps the registered names.
	let registered: string[] = []
	try {
		const rows = await db
			.select({ name: appRepos.containerName })
			.from(appRepos)
			.where(eq(appRepos.serverId, serverId))
		registered = rows.map((r) => r.name)
	} catch (err) {
		console.error(`[deploy-runner] other apps lookup failed for ${serverId}:`, err)
	}
	let previewNames: string[] = []
	try {
		const previews = await db
			.select({ name: previewDeploys.containerName, parent: appRepos.containerName })
			.from(previewDeploys)
			.innerJoin(appRepos, eq(previewDeploys.appRepoId, appRepos.id))
			.where(eq(appRepos.serverId, serverId))
		previewNames = previews.filter((p) => p.parent !== self).map((p) => p.name)
	} catch (err) {
		console.error(`[deploy-runner] preview names lookup failed for ${serverId}:`, err)
	}
	return [...new Set([...registered, ...previewNames])].filter((n) => !!n && n !== self)
}
