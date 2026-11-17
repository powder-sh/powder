import { gitCmd, gitHardenShellFunctions } from '../git-harden'
import { randomBytes } from 'node:crypto'
import { BUILDER_SCRIPT_RESERVE_SEC, DEPLOY_BUDGET_SEC, budgetExhausted, outerTimeoutSec, remainingBudgetSec, sshWallMs, TIMEOUT_KILL_SEC } from '../deploy-budget'
import { BuilderTestGateFailedError, DeployStepError } from '../deploy-failure'
import type { ServerConfig } from '../servers'
import { type BridgeVerdict, type NginxUpstreamVerdict, buildPullEnabled, composeFileArgs, parseBridgeVerdict, parseNginxUpstreamVerdict, projectChangedMarkerFor, resolveInfraServices, testGateMemOverride } from './fragments'
import type { SwapCheckPlan } from './fragments'
import { buildDeployScript } from './script'
import { type StabilityMarkers, parseStabilityMarkers, stabilityMarkerFilter, stripStabilityMarkers } from './stability'
import { ComposeGuardError, checkComposeForDeploy } from './compose-check'
import { composeChangedMarkerFor } from './compose-hash'
import type { ComposeView } from './compose-diff'
import { runSelfDeploy, selfDeployDecision } from './self-deploy'
import {
	appLockPath,
	hasMarkerLine,
	supersededMarkerFor,
	swapPrevPath,
	swapStampPath,
} from '../deploy-supersede'
import { appLockShell } from './fragments'
import { shq } from '../shell'
import type { PushDecision } from '../deploy-push-policy'
import { withRegistryCreds } from '../docker-env'
import { runCommand } from '../ssh/connection'
import { writeFileViaSftp } from '../ssh/files'
import { randomTempPath } from '../temp-path'
import { ephemeralCacheNamespace } from '../build-cache'
import { builderDirSlug } from '../builder-slug'
import { isPowderTempComposeFile } from '../compose-override'
import { GIT_REF_RE, workdirComposeFiles } from '../ssh/git'
import { atomicWriteShellRaw } from '../repo-symlinks'

// Time constants live in deploy-budget.ts (one place, ordering tested).
export { DEPLOY_BUDGET_SEC }

/** Run a deploy script on the server under ONE deadline: upload it via SFTP (no
 *  32 KB exec-channel ceiling, nothing in argv), run it under `timeout -k` so
 *  the whole process group dies at the deadline (killing the SSH channel alone
 *  left the remote script running until its next write — sometimes mid-`up`),
 *  and hold the SSH wall just above that. */
export async function runDeployScript(
	server: ServerConfig,
	script: string,
	deployId: string | undefined,
	/** `stream` is unset for powder's own lines about the run. */
	onChunk?: (chunk: string, stream?: 'stdout' | 'stderr') => void,
	/** Budget this script was built with (its in-script DEADLINE). */
	budgetSec: number = DEPLOY_BUDGET_SEC,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const outer = outerTimeoutSec(budgetSec)
	const wallMs = sshWallMs(budgetSec)
	// Unique per RUN: two runs for one id (previews, retries) must not share a file.
	const path = `${randomTempPath(`/tmp/powder-deploy-${(deployId ?? `t${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '')}`)}.sh`
	const runIt = () =>
		runCommand(
			server,
			`timeout -k ${TIMEOUT_KILL_SEC} ${outer} bash ${shq(path)}; rc=$?; rm -f ${shq(path)}; exit $rc`,
			wallMs,
			onChunk,
		)
	let uploaded = false
	try {
		await writeFileViaSftp(server, path, script, 0o700, 30_000, true, true)
		uploaded = true
		return await runIt()
	} catch (err) {
		// SFTP unavailable on this server: upload the script over plain exec channels
		// in small base64 chunks (a 40 KB script does not fit one exec payload), then
		// run it exactly like the SFTP path. Only an upload failure may fall back.
		// A drop DURING the run must not start the whole script a second time (the
		// first may still be alive).
		if (uploaded) throw err
		// A failure BEFORE the script started (connect, SFTP, chunked upload) is a known
		// pre-swap step - the old container still serves, so the rendered env must go back.
		const preStart = (msg: string) =>
			new DeployStepError(`${msg}\n__POWDER_FAIL__ step=script upload code=1`)
		if (err instanceof Error && /SSH timeout/.test(err.message)) throw preStart(err.message)
		onChunk?.(`[deploy] script upload over SFTP failed (${err instanceof Error ? err.message : err}) - uploading it in chunks\n`)
		try {
			await uploadScriptChunked(server, path, script)
		} catch (e) {
			await runCommand(server, `rm -f ${shq(path)}`, 10_000).catch(() => {})
			throw preStart(`deploy script upload failed (SFTP: ${err instanceof Error ? err.message : err}; chunked: ${e instanceof Error ? e.message : e})`)
		}
		return await runIt()
	}
}

/** Base64 characters per exec upload chunk (a multiple of 4, so every chunk decodes on its own). */
const UPLOAD_CHUNK_B64 = 16 * 1024

/** SFTP-less script upload: append the script to `path` in UPLOAD_CHUNK_B64-sized pieces. */
async function uploadScriptChunked(server: ServerConfig, path: string, script: string): Promise<void> {
	const b64 = Buffer.from(script, 'utf8').toString('base64')
	for (let i = 0; i < b64.length; i += UPLOAD_CHUNK_B64) {
		const op = i === 0 ? '>' : '>>'
		const part = b64.slice(i, i + UPLOAD_CHUNK_B64)
		const r = await runCommand(server, `umask 077; printf %s ${shq(part)} | base64 -d ${op} ${shq(path)}`, 30_000)
		if (r.code !== 0) throw new Error(`chunk ${Math.floor(i / UPLOAD_CHUNK_B64) + 1} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`)
	}
}

/** After a deploy died with NO step marker (SIGKILL, dropped SSH session: the script's EXIT
 *  trap never ran), put the shared image tag back on the image the app was running before
 *  the swap gate moved it - but only when that image is still what runs (not swapped). Runs
 *  under the per-app lock, so a still-alive orphan script makes it a no-op instead of a race.
 *  Returns a log line ('' when there was nothing to do). Best effort, never throws. */
export async function restoreSharedTagAfterAbort(
	server: ServerConfig,
	p: { workingDir: string; service: string; containerName: string },
): Promise<string> {
	const prev = swapPrevPath(swapStampPath(p.workingDir, p.service, p.containerName))
	const lock = appLockPath(p.workingDir, p.service)
	const inner =
		appLockShell(lock) +
		`F=${shq(prev)}; [ -f "$F" ] || exit 0; ` +
		`PREV=$(sed -n 1p "$F"); REF=$(sed -n 2p "$F"); ` +
		`RUN=$(docker inspect -f '{{.Image}}' ${shq(p.containerName)} 2>/dev/null || true); ` +
		`if [ -n "$PREV" ] && [ -n "$REF" ] && [ "$RUN" = "$PREV" ]; then ` +
		`docker tag "$PREV" "$REF" && echo "[release] shared tag $REF restored to the running image after an aborted deploy"; ` +
		`else echo "[release] aborted deploy left an abort record but the app is not on the pre-swap image - tag left as is"; fi; rm -f "$F"`
	try {
		const r = await runCommand(server, `bash -c ${shq(inner)}`, 150_000)
		return r.code === 0 && r.stdout.trim() ? `\n${r.stdout.trim()}\n` : ''
	} catch {
		return ''
	}
}

/** what a failed compose override means for the deploy. Pure. `merge` = the
 *  failure was OverrideMergeError (the app's compose parses alone, not with the
 *  override): refuse. Anything else (server I/O) goes on as before, loudly. */
export function overrideFailureOutcome(err: unknown, app: string, merge: boolean): { refuse: string } | { log: string } {
	const msg = err instanceof Error ? err.message.slice(0, 300) : String(err)
	if (merge)
		return {
			refuse: `── compose override ──\ndeploy: refusing, powder's compose override cannot be merged with this app's compose (${msg}). The app's compose parses on its own; fix the part that conflicts with docker-compose.powder.yml (ports, labels, cap_drop) and redeploy. The old container keeps serving.\n`,
		}
	return {
		log: `── compose override ──\n[ports] override FAILED, continuing without it: ${msg}\n[compose-guard] WARN ${app.replace(/[^A-Za-z0-9._-]/g, '_')} override_failed the deploy runs WITHOUT powder's override (published ports may stay public, NET_RAW is not dropped); check the server (disk, permissions) and redeploy\n`,
	}
}

/** After the compose guard refused a deploy: put the src/ checkout back on the last
 *  successfully deployed commit, so the refused tree does not stay on disk for anything
 *  that reads it later (a hand `compose up`, a domain sync). In the workdir
 *  layout a hard reset would revert the server-local runtime docker-compose.yml (the sync
 *  preserves it, so the repo never changes it); there every OTHER compose file the app
 *  runs with that the repo tracks (a tracked docker-compose.prod.yml, whose repo copy
 *  wins in warn mode) is written back to its content at the last successful commit, and
 *  logged. The recreate paths (apply, domain apply, rollbacks) re-run the deploy's guard
 *  anyway (lib/recreate-guard.ts). Returns a log line; never throws. */
export async function resetCheckoutAfterRefusal(
	server: ServerConfig,
	workingDir: string,
	baseSha: string | null | undefined,
	composeFiles: string[] = [],
): Promise<string> {
	const base = baseSha && /^[0-9a-f]{40}$/.test(baseSha) ? baseSha : null
	if (!base)
		return '[compose-guard] no earlier successful commit is known: the refused tree stays on disk; the next deploy and every recreate (apply, domain apply, rollback) re-check it with the deploy\'s rules\n'
	const g = gitCmd(shq('*'))
	const gw = gitCmd(shq(workingDir))
	const extra = workdirComposeFiles(workingDir, composeFiles).filter((f) => f !== 'docker-compose.yml')
	const workdirRestore =
		`RS=''; for F in ${extra.map(shq).join(' ')}; do ` +
		`if [ -n "$(${gw} ls-files -- "$F" 2>/dev/null)" ] && ${gw} cat-file -e ${shq(`${base}:`)}"$F" 2>/dev/null; then ` +
		`T=$(mktemp -p "$(dirname -- "$F")" .dc.XXXXXX) && ${gw} show ${shq(`${base}:`)}"$F" > "$T" && { ${atomicWriteShellRaw('"$F"', '"$T"')}; } && RS="$RS $F" || { rm -f -- "$T" 2>/dev/null; echo "__POWDER_RESTORE_FAILED__ $F"; }; fi; done; `
	const cmd = [
		gitHardenShellFunctions(),
		`cd ${shq(workingDir)} 2>/dev/null || exit 0; `,
		`if [ -d src/.git ] && [ ! -L src ]; then cd src && ${g} cat-file -e ${shq(`${base}^{commit}`)} 2>/dev/null && ${g} reset -q --hard ${shq(base)} && ${g} clean -fdxq -e .deploy-key && echo __POWDER_RESET_OK__; `,
		`elif [ -d .git ] && [ ! -L .git ]; then `,
		extra.length ? workdirRestore : `RS=''; `,
		'echo "__POWDER_RESET_WORKDIR__$RS"; ',
		'else echo __POWDER_RESET_NONE__; fi',
	].join('')
	try {
		const r = await runCommand(server, cmd, 60_000)
		if (r.stdout.includes('__POWDER_RESET_OK__'))
			return `[compose-guard] src/ reset to the last successful commit ${base.slice(0, 12)} after the refusal\n`
		const failed = [...r.stdout.matchAll(/__POWDER_RESTORE_FAILED__ (\S+)/g)].map((m) => m[1])
		const workdirLine = /__POWDER_RESET_WORKDIR__([^\n]*)/.exec(r.stdout)
		if (workdirLine) {
			const restored = (workdirLine[1] ?? '').trim()
			return (
				(restored
					? `[compose-guard] workdir layout: restored the tracked compose file(s) ${restored} to the last successful commit ${base.slice(0, 12)} after the refusal (the runtime docker-compose.yml is server-local and stays)\n`
					: '[compose-guard] workdir layout: no tracked compose file to restore (the runtime docker-compose.yml is server-local and stays); the next deploy and every recreate re-check the compose\n') +
				(failed.length ? `[compose-guard] WARN could not restore ${failed.join(', ')}; the next deploy and every recreate re-check it\n` : '')
			)
		}
		return `[compose-guard] could not reset the checkout to ${base.slice(0, 12)}; the next deploy and every recreate re-check the compose\n`
	} catch {
		return `[compose-guard] could not reset the checkout to ${base.slice(0, 12)}; the next deploy and every recreate re-check the compose\n`
	}
}

/** The rollback tag a deploy gets (`<repo>:deploy-<id>`), or null when the image ref is unusable. */
function deployImageTag(image: string, deployId: string): string | null {
	if (!/^[A-Za-z0-9._\-:/@]+$/.test(image) || image === ':') return null
	const base = image.includes(':') ? image.slice(0, image.lastIndexOf(':')) : image
	return `${base}:deploy-${deployId.replace(/^dep_/, '')}`
}

/** the shell that tags a proven deploy and pushes the tag when the repo is a
 *  registry path AND deployPushDecision (deploy-push-policy.ts) allowed it: the push runs
 *  with root's registry logins. A refused push is a WARN line; the deploy is unaffected. */
export function tagDeployCommand(image: string, deployId: string, push: PushDecision): string {
	const base = image.includes(':') ? image.slice(0, image.lastIndexOf(':')) : image
	const tag = deployImageTag(image, deployId) as string
	const why = push.reason.replace(/[^\x20-\x7e]/g, '?').slice(0, 300)
	return (
		`docker tag ${shq(image)} ${shq(tag)} && echo ${shq(`tagged: ${tag}`)} && ` +
		(!base.includes('/')
			? `echo "(local-only image, no remote push)"`
			: push.allow
				? `(${withRegistryCreds(`docker push ${shq(tag)}`, push)} >/dev/null 2>&1 && echo ${shq(`pushed: ${tag}`)} || echo "(registry push unavailable - tag stays local; prune-protected)")`
				: `echo ${shq(`WARN not pushing ${tag}: ${why}. The tag stays local (prune-protected); the deploy is not affected.`)}`)
	)
}

/** Tag the image a deploy just shipped as its rollback target
 *  (`<repo>:deploy-<id>`), and push it when the repo is a registry path.
 *  Called only after the deploy passed its health gate + image readback, so
 *  every `:deploy-*` tag on a server is a known-good image. Returns the tag, or
 *  null when tagging failed (the deploy then records no rollback target). */
export async function tagDeployImage(
	server: ServerConfig,
	image: string,
	deployId: string,
	push: PushDecision,
): Promise<{ imageTag: string | null; output: string }> {
	if (!/^[A-Za-z0-9._\-:/@]+$/.test(image) || image === ':') return { imageTag: null, output: '(skipped tagging: no usable image)\n' }
	const tag = deployImageTag(image, deployId) as string
	const cmd = tagDeployCommand(image, deployId, push)
	try {
		const { stdout, stderr, code } = await runCommand(server, cmd, 120_000)
		if (code !== 0) return { imageTag: null, output: `(tagging failed: ${(stderr || stdout).trim().slice(0, 300)})\n` }
		return { imageTag: tag, output: stdout }
	} catch (err) {
		return { imageTag: null, output: `(tagging failed: ${err instanceof Error ? err.message : err})\n` }
	}
}

/** After the health gate: remove any `powder.bridge=<workdir>|<service>` container
 *  still around (SIGKILLed/timed-out deploy leaked it). Returns a log line, or ''
 *  when nothing was left. Best-effort, never throws. */
export async function removeLeakedBridges(server: ServerConfig, workingDir: string, service: string): Promise<string> {
	const filter = shq(`label=powder.bridge=${workingDir}|${service}`)
	try {
		const { stdout } = await runCommand(
			server,
			`IDS=$(docker ps -aq --filter ${filter} 2>/dev/null); if [ -n "$IDS" ]; then printf '%s\n' "$IDS" | xargs -r docker rm -f >/dev/null 2>&1; echo "LEAKED_BRIDGES_REMOVED: $IDS"; fi`,
			60_000,
		)
		return stdout.includes('LEAKED_BRIDGES_REMOVED') ? `\n!! [bridge] a leaked bridge container was still present after the deploy and was removed: ${stdout.trim()}\n` : ''
	} catch {
		return ''
	}
}

/** The synced commit from the nonce-tagged marker (`__POWDER_SHA_<nonce>__ <sha> <branch>`),
 *  the LAST whole-line match. Anything else in stdout is ignored. */
export function parseSyncedSha(stdout: string, nonce: string): { sha: string | null; branch: string | null } {
	if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) return { sha: null, branch: null }
	const all = [...stdout.matchAll(new RegExp(`^__POWDER_SHA_${nonce}__ ([0-9a-f]{40}) (\\S+)$`, 'gm'))]
	const m = all[all.length - 1]
	return { sha: m?.[1] ?? null, branch: m?.[2] ?? null }
}

/** The image the deploy script reports on its final `echo "image: $IMG"` line.
 *  Earlier lines (build, test gate, migrate output) may contain "image: X" too:
 *  only a whole line `image: <ref>` counts, and the LAST one wins. */
export function parseDeployedImage(stdout: string): string | null {
	const all = [...stdout.matchAll(/^image: (\S+)$/gm)]
	return all.at(-1)?.[1] ?? null
}

export async function rebuildDeploy(
	server: ServerConfig,
	workingDir: string,
	configFile: string,
	service: string,
	deployId?: string,
	onChunk?: (chunk: string) => void,
	opts?: {
		/** app_repos.build_mode — 'build' | 'registry' declare the deploy mode and
		 *  make the preflight fail loudly when the compose file disagrees;
		 *  'auto' (or unset) infers the mode from the compose file. */
		buildMode?: string
		/** Dedicated-builder phase (servers.build_host): clone+build+test-gate on
		 *  the builder, stream the image here, and skip the local build. Failure
		 *  falls back to a local build with a loud log line. */
		builder?: { host: string; repoUrl: string; deployKeyPriv: string }
		/** The powder app name (= container_name, = /opt/apps/<name>) to hand to
		 *  powder-migrate. NOT the compose service: for `services: app:` with
		 *  `container_name: example-app`, passing "app" made the script look for a
		 *  container called "app", find none, print "no DATABASE_URL — skip" and
		 *  exit 0: every deploy silently skipped migrations (an app's
		 *  backfill migration never ran). Defaults to `service`. */
		migrateApp?: string
		/** app_repos.branch — the branch this app deploys. The sync checks out
		 *  THIS branch, not whatever origin/HEAD points at (they differ for any
		 *  app tracking a non-default branch). Falls back to origin/HEAD with a
		 *  warning when the branch doesn't exist on the remote. */
		branch?: string | null
		/** The exact commit to build (the push payload's `after`). Falls back to
		 *  the branch HEAD with a warning when it can't be fetched. */
		sha?: string | null
		/** DB git_sha of the last successful deploy; the forward-only check uses it
		 *  as the base when the server has no HEAD of its own. Also the commit src/ is reset
		 *  to after a compose-guard refusal. */
		baseSha?: string | null
		/** compose_config_hash of the app's last successful deploy (0056). A probed config
		 *  with another hash (or none stored) gets the high-severity rules enforced. */
		approvedComposeHash?: string | null
		/** compose_config_view of that deploy (0062): the guard prints what differs from it. */
		approvedComposeView?: ComposeView | null
		/** All compose files (-f) the app was started with; defaults to [configFile]. */
		composeFiles?: string[]
		/** Ordering token (deploy claim time, ms). Enables the per-app lock,
		 *  supersede check and staged-image swap gate (see deploy-supersede.ts). */
		swapOrdinal?: number
		/** Pre-swap candidate probe plan (resolveSwapCheckPlan). Unset = no swap-check step. */
		swapCheck?: SwapCheckPlan
		/** The ONE deadline for this deploy (claim time + DEPLOY_BUDGET_SEC, ms
		 *  epoch; see deploy-budget.ts). The builder phase and the deploy script
		 *  both draw from what is left of it. */
		deadlineAt?: number
		/** Never run powder-migrate (a preview's env may point at the parent's database). */
		skipMigrate?: boolean
		/** Compose safety check inputs (compose-check.ts). routeHosts: the hosts this app may
		 *  route on Traefik (null = server not marked traefik); proxyRouteHosts: checked
		 *  instead when the probe sees a Docker-provider proxy on a server not marked traefik. */
		composeGuard?: { routeHosts: string[] | null; proxyRouteHosts?: string[]; extraEnvFiles?: string[]; otherApps?: string[]; envTarget?: string | null }
		/** BuildKit cache namespace (build-cache.ts loadCacheNamespace). Unset = a fresh
		 *  random one: the build is isolated but starts with a cold cache. */
		cacheNamespace?: string | null
		/** who the target container is (its name and compose project label, from
		 *  docker inspect). Self-deploy is decided by identity (selfDeployDecision); without
		 *  this a deploy never self-deploys. */
		selfIdentity?: { containerName: string; composeProject: string | null }
	},
): Promise<{
	output: string
	sha: string | null
	branch: string | null
	pulledGit: boolean
	imageBase: string | null
	/** The image the service runs after the deploy (e.g. `app:latest`). Tag it
	 *  as a rollback target ONLY after the deploy is proven healthy
	 *  (tagDeployImage) — never before, or failed deploys evict good targets. */
	image: string | null
	/** Always null since tagging moved after the health gate; kept for callers. */
	imageTag: string | null
	/** Structural hash of the compose config the deploy ran with (store it on success as
	 *  compose_config_hash), null when unread. */
	composeHash: string | null
	/** the view of that structure (store it with the hash as compose_config_view). */
	composeView?: ComposeView | null
	/** The script stopped because a newer deploy already swapped (nonce-tagged marker). */
	superseded: boolean
	/** the port normaliser's `left public:` notes, straight from powder's plan
	 *  (never parsed back out of the output, which build or test output can print to). */
	portsLeftPublic?: string[]
	/** the bridge step's verdict from its nonce-tagged marker, null when unknown. */
	bridgeVerdict?: BridgeVerdict | null
	/** host-port mode's nginx upstream check verdict from its nonce-tagged marker, null when unknown. */
	nginxUpstreamVerdict?: NginxUpstreamVerdict | null
	/** the deploy-setup checks' nonce-tagged markers (deploy/stability.ts); each part null when unknown. */
	stability?: StabilityMarkers | null
}> {
	// A spent budget never starts a build: fail before touching anything, as a
	// known pre-swap step (the old container keeps serving).
	if (budgetExhausted(opts?.deadlineAt)) {
		throw new DeployStepError('deploy: the deploy budget is already spent before the build could start - nothing was touched\n__POWDER_FAIL__ step=budget code=1')
	}
	// A file list read from a container label may still name powder's deleted
	// per-deploy temp overrides (discovery drops them; this is the second line).
	const composeFiles = opts?.composeFiles?.filter((f) => !isPowderTempComposeFile(f))
	// if .git/ exists, pull first; otherwise just rebuild from whatever's on disk.
	// keeps a single deploy flow for both git-tracked and rsync'd apps.
	const tagSuffix = deployId ? `deploy-${deployId.replace(/^dep_/, '')}` : ''
	const declaredMode = opts?.buildMode ?? 'auto'

	// Self-deploy: powder is deploying the container that runs powder.
	// `up -d --force-recreate` will kill this process; the SSH session dies and
	// SIGHUPs the remote docker compose mid-recreate (container left in Created).
	// Fix: do pull+build+tag synchronously (these don't kill us), then fire the
	// recreate detached via setsid so it survives ssh disconnect.
	// by identity (container, server, project, source dir), never by the compose
	// service label alone: an app may name a service like powder's on its own network.
	const selfDecision = opts?.selfIdentity
		? selfDeployDecision({
				serverId: server.id,
				service,
				containerName: opts.selfIdentity.containerName,
				composeProject: opts.selfIdentity.composeProject,
				workingDir,
				configFile,
			})
		: 'normal'
	if (typeof selfDecision === 'object')
		throw new DeployStepError(`self-deploy: refusing, ${selfDecision.refuse}\n__POWDER_FAIL__ step=preflight code=1`)
	if (selfDecision === 'self') {
		// powder's own deploy is not compose-guarded (docs/SECURITY-COMPOSE.md): no hash to store.
		const self = await runSelfDeploy(server, workingDir, configFile, service, tagSuffix, onChunk, {
			deployId,
			budgetSec: remainingBudgetSec(opts?.deadlineAt),
		})
		return { ...self, composeHash: null, superseded: false }
	}

	// powder's compose override (docker-compose.powder.yml): loopback bindings for published
	// ports, labels preserved as written by the domain sync. The user's compose is never edited.
	// an override the app's compose cannot be merged with (OverrideMergeError: the
	// user's own config parses, the merged one does not) REFUSES the deploy, because
	// going on would run the app without the override's protections (loopback ports,
	// cap_drop NET_RAW). Any other failure (server I/O: mkdir, write, ssh) keeps the old
	// best-effort behaviour with a WARN line, so a transient server problem never blocks
	// an unchanged app.
	let overrideLog = ''
	let portsLeftPublic: string[] = []
	const { applyComposeOverride, OverrideMergeError } = await import('../compose-override-io')
	try {
		const r = await applyComposeOverride(
			server,
			{ workingDir, configFile, composeFiles, service },
			{ appName: opts?.migrateApp ?? service },
		)
		overrideLog = `── compose override ──\n${r.log}`
		portsLeftPublic = r.log.split('\n').filter((l) => l.startsWith('left public: '))
	} catch (err) {
		const o = overrideFailureOutcome(err, opts?.migrateApp ?? service, err instanceof OverrideMergeError)
		if ('refuse' in o) throw new DeployStepError(o.refuse)
		overrideLog = o.log
	}
	onChunk?.(overrideLog)

	// ── compose safety check (the one authority) ───────────────────
	// Runs on the RESOLVED config after powder's override is in place and before
	// anything is built or pulled; the script pins the hash (compose-hash.ts).
	const guardCf = composeFileArgs(configFile, composeFiles)
	const guardParams = {
		// The stored structural hash ignores powder's own override (domain/route labels).
		userCf: composeFileArgs(configFile, composeFiles, { override: false }),
		appName: opts?.migrateApp ?? service,
		workingDir,
		composeFiles: composeFiles && composeFiles.length > 0 ? composeFiles : [configFile],
		routeHosts: opts?.composeGuard?.routeHosts ?? null,
		proxyRouteHosts: opts?.composeGuard?.proxyRouteHosts,
		extraEnvFiles: opts?.composeGuard?.extraEnvFiles,
		envTarget: opts?.composeGuard?.envTarget ?? null,
		otherApps: opts?.composeGuard?.otherApps,
	}
	const refusedReset = () => resetCheckoutAfterRefusal(server, workingDir, opts?.baseSha, guardParams.composeFiles)
	const guard = await checkComposeForDeploy(server, guardCf, {
		...guardParams,
		approvedHash: opts?.approvedComposeHash ?? null,
		approvedView: opts?.approvedComposeView ?? null,
	}).catch(async (err) => {
		if (err instanceof ComposeGuardError) throw new DeployStepError(`${overrideLog}${err.message}\n${await refusedReset()}`)
		throw err
	})
	onChunk?.(guard.log)
	overrideLog += guard.log

	// ── dedicated-builder phase (servers.build_host) ──────────────────────────
	// Build on the builder server, stream the image here, skip the local build.
	// Any failure degrades to a local build — a builder outage never blocks
	// deploys, it just puts the compile back on the production server for that run.
	let prebuilt = false
	let builderLog = overrideLog
	const wantBranch = opts?.branch && GIT_REF_RE.test(opts.branch) ? opts.branch : null
	let wantSha = opts?.sha && /^[0-9a-f]{40}$/.test(opts.sha) ? opts.sha : null
	// A builder-built image pins the target to the builder's commit: the image
	// and the synced src/ (migrations, git_sha) MUST describe the same commit.
	let shaIsStrict = false
	let stageImage: string | null = null
	if (opts?.builder && declaredMode !== 'registry') {
		const collect = (s: string) => {
			builderLog += s
			onChunk?.(s)
		}
		try {
			const { resolveComposeBuildFacts, runBuilderPhase } = await import('../builder')
			// the same compose files and override the guard checked (guardCf)
			const facts = await resolveComposeBuildFacts(server, configFile, service, guardCf)
			if (!facts) throw new Error('could not resolve the compose build section (config --format json)')
			if (facts.hasSecrets || facts.hasAdditionalContexts)
				throw new Error('compose build uses secrets/additional_contexts - those inputs live on the target; not builder-eligible')
			const built = await runBuilderPhase(
				server,
				opts.builder,
				facts,
				builderDirSlug(server.id, workingDir, opts.migrateApp ?? service),
				{ branch: wantBranch, sha: wantSha, deployId, cacheNamespace: opts.cacheNamespace ?? ephemeralCacheNamespace(), app: opts.migrateApp ?? service, dockerfileAuthority: guard.dockerfileAuthority ?? null },
				collect,
				// Builder gets the remaining budget minus a reserve for the script.
				Math.max(60, remainingBudgetSec(opts.deadlineAt) - BUILDER_SCRIPT_RESERVE_SEC),
			)
			prebuilt = true
			stageImage = built.stageImage
			if (built.sha) {
				wantSha = built.sha
				shaIsStrict = true
			}
		} catch (err) {
			// Failing tests fail the same way anywhere: no local retry on the production server. Nothing on the
			// target was touched yet (its checkout syncs in the deploy script), so this is a clean pre-swap stop.
			if (err instanceof BuilderTestGateFailedError) {
				collect(`[builder] ${err.message} - not falling back to a local build (the same tests would fail there)\n`)
				throw new DeployStepError(`${builderLog}__POWDER_FAIL__ step=test gate code=1`)
			}
			collect(
				`[builder] phase failed - ${err instanceof Error ? err.message : String(err)}\n` +
					`[builder] falling back to a LOCAL build on ${server.host}\n`,
			)
		}
	}
	const cf = composeFileArgs(configFile, composeFiles)
	// Infra services (db/cache/proxy) come from the resolved compose config —
	// image + volumes, not from a fixed list of service NAMES, which would miss
	// `database:`/`mysql:`/`mongo:` and then recreate (and on the retry path
	// `down`) the app's database on every deploy. null = the config couldn't
	// be read; the script falls back to a service-name heuristic.
	const infra = await resolveInfraServices(server, cf, service)
	const scriptBudgetSec = remainingBudgetSec(opts?.deadlineAt)
	const shaNonce = randomBytes(12).toString('hex')
	// the script's markers carry the nonce, so build output cannot fake them.
	const changedMarker = composeChangedMarkerFor(shaNonce)
	const scriptFor = (composeHash: string, budgetSec = scriptBudgetSec, recheck = !guard.enforce, hashEnforce = false) => buildDeployScript({
		composeHash,
		composeGuardEnforce: guard.enforce,
		composeGuardRecheck: recheck,
		composeHashEnforce: hashEnforce,
		buildPull: buildPullEnabled(),
		testGateMem: testGateMemOverride(),
		shaNonce,
		composeFiles: guardParams.composeFiles,
		workingDir,
		configFile,
		service,
		cf,
		declaredMode,
		prebuilt,
		migrateApp: opts?.migrateApp,
		infra,
		wantBranch,
		wantSha,
		shaIsStrict,
		baseSha: opts?.baseSha ?? null,
		swapOrdinal: opts?.swapOrdinal,
		stageId: deployId,
		stageImage,
		swapCheck: opts?.swapCheck,
		// Whatever the builder phase left of the single deploy budget.
		budgetSec,
		skipMigrate: opts?.skipMigrate ?? false,
		cacheNamespace: opts?.cacheNamespace ?? null,
		dockerfileAuthority: guard.dockerfileAuthority ?? null,
	})
	// SSH wall-clock for the whole build+up+tag script. MUST exceed the in-script
	// `timeout 1800` (30-min) build cap, or a heavy on-server build (close
	// to the 30-min cap) trips THIS 10-min wall first → bogus "SSH timeout" alert
	// while the build keeps grinding orphaned, holding the flock and starving the
	// next app's deploy into the same false timeout. 40 min = build cap + buffer,
	// aligned with the stuck-deploy watchdog backstop.
	// The live log (also what a failed deploy stores) never shows this run's marker lines.
	const live = stabilityMarkerFilter(shaNonce, onChunk)
	const runLive = async (script: string, budget: number) => {
		try {
			return await runDeployScript(server, script, deployId, live.push, budget)
		} finally {
			live.flush()
		}
	}
	let { stdout, code, stderr } = await runLive(scriptFor(guard.hash), scriptBudgetSec)
	const strip = (s: string) => stripStabilityMarkers(s, shaNonce)
	// What a success stores (compose_config_hash): the STRUCTURAL hash of the config the
	// script ran with (compose-check.ts structuralComposeHash), not the pinned tripwire hash.
	let approvalHash = guard.structuralHash
	let approvalView = guard.structuralView ?? null
	// A warn-mode re-check stop (CG_RECHECK) leaves a builder-staged image on the server
	// for the second run. Remove it on every path that does not reach that run.
	const keptStage =
		code !== 0 && prebuilt && !guard.enforce && !!stageImage && hasMarkerLine(stdout, changedMarker)
	const dropKeptStage = async () => {
		if (!keptStage || !stageImage) return
		await runCommand(server, `docker rmi ${shq(stageImage)} >/dev/null 2>&1 || true`, 30_000).catch(() => {})
	}
	if (keptStage && budgetExhausted(opts?.deadlineAt)) await dropKeptStage()
	// Warn mode keeps a builder-staged image across the stop (CG_RECHECK), so the
	// re-check also covers prebuilt deploys there; enforce mode keeps its old rule.
	if (code !== 0 && (!prebuilt || !guard.enforce) && hasMarkerLine(stdout, changedMarker) && !budgetExhausted(opts?.deadlineAt)) {
		// The git sync changed what the compose resolves to: check the NEW tree once
		// (nothing was built or swapped yet), then run the script again on that hash.
		// in warn mode this check refuses the high-severity rule codes
		// (the repo changed the compose); the second run warns on a further change.
		// re-render powder's override for the new tree first, so a service the
		// sync added (a new build service: pull_policy never, cap_drop) is covered in this
		// deploy, and the re-check and the second run's hash include it.
		try {
			const r2 = await applyComposeOverride(
				server,
				{ workingDir, configFile, composeFiles, service },
				{ appName: opts?.migrateApp ?? service },
			)
			builderLog += `── compose override (re-rendered after the sync) ──\n${r2.log}`
			onChunk?.(`── compose override (re-rendered after the sync) ──\n${r2.log}`)
		} catch (err) {
			const o = overrideFailureOutcome(err, opts?.migrateApp ?? service, err instanceof OverrideMergeError)
			if ('refuse' in o) {
				await dropKeptStage()
				throw new DeployStepError(strip([builderLog, stdout, o.refuse, await refusedReset()].join('\n')))
			}
			builderLog += o.log
		}
		const again = await checkComposeForDeploy(server, guardCf, {
			...guardParams,
			repoChanged: true,
			approvedHash: opts?.approvedComposeHash ?? null,
			approvedView: opts?.approvedComposeView ?? null,
			priorStructuralHash: guard.structuralHash,
		}).catch(async (err) => {
			await dropKeptStage()
			if (err instanceof ComposeGuardError) throw new DeployStepError(strip([builderLog, stdout, err.message, await refusedReset()].join('\n')))
			throw err
		})
		onChunk?.('[compose-guard] the compose changed during the git sync; re-checked, running the deploy again\n')
		builderLog += stdout.replace(/__POWDER_FAIL__[^\n]*/g, '[compose-guard] first run stopped here') + again.log
		// The second run pins the hash the re-check approved and REFUSES if it moves
		// again (any mode): a push landing between the re-check and this run must not
		// be built unchecked.
		;({ stdout, code, stderr } = await runLive(scriptFor(again.hash, remainingBudgetSec(opts?.deadlineAt), false, true), remainingBudgetSec(opts?.deadlineAt)))
		approvalHash = again.structuralHash
		approvalView = again.structuralView ?? null
	}
	if (code !== 0) {
		// a project-name refusal after the git sync puts the checkout back too.
		if (hasMarkerLine(stdout, changedMarker) || hasMarkerLine(stdout, projectChangedMarkerFor(shaNonce)))
			stderr = [stderr, await refusedReset()].filter(Boolean).join('\n')
		// Combine streams so the parser sees both the __POWDER_FAIL__ marker
		// (stdout, via the EXIT trap) and any raw stderr a step emitted.
		throw new DeployStepError(strip([builderLog, stdout, stderr].filter(Boolean).join('\n')) || 'deploy failed')
	}

	// Both sync paths (src/ and the workdir layout) print the same marker after the
	// human-readable banners; without it git_sha would stay NULL.
	// Only the nonce-tagged marker counts. A banner regex would match
	// anywhere in stdout, so build or test output could print a fake banner and set
	// the recorded git sha (and with it the forward-only base of the next deploy).
	const { sha, branch } = parseSyncedSha(stdout, shaNonce)
	const pulledGit = stdout.includes('── git pull ──')
	const image = parseDeployedImage(stdout)
	const imageBase = image ? (image.split(':')[0] ?? '') : null

	return {
		// the stability markers are parsed below (stability); the stored log drops them.
		output: stripStabilityMarkers(builderLog + stdout, shaNonce),
		sha,
		branch,
		pulledGit,
		imageBase,
		image,
		imageTag: null,
		composeHash: /^[0-9a-f]{64}$/.test(approvalHash) ? approvalHash : null,
		composeView: /^[0-9a-f]{64}$/.test(approvalHash) ? approvalView : null,
		superseded: hasMarkerLine(stdout, supersededMarkerFor(shaNonce)),
		portsLeftPublic,
		bridgeVerdict: parseBridgeVerdict(stdout, shaNonce),
		nginxUpstreamVerdict: parseNginxUpstreamVerdict(stdout, shaNonce),
		// never throws (a bad marker is "unknown"): warnings must not fail a deploy.
		stability: parseStabilityMarkers(stdout, shaNonce),
	}
}

// Post-`up` truth readback: the RUNNING container's image id must equal the id
// its image name currently resolves to. After `build/pull && up --force-recreate`
// that's an invariant — a mismatch means the recreate landed on an OLD image
// (the "deploy succeeds but ships old code" class, which preflight heuristics
// alone do not catch). Conservative by design: any uncertainty (inspect
// failed, empty ids) reports match=true with the reason in `detail` — this is
// a truth check, not a new way for healthy deploys to flake out.
export async function verifyRunningImage(
	server: ServerConfig,
	containerName: string,
): Promise<{ match: boolean; detail: string }> {
	const cmd =
		`RID=$(docker inspect ${shq(containerName)} --format '{{.Image}}' 2>/dev/null); ` +
		`NAME=$(docker inspect ${shq(containerName)} --format '{{.Config.Image}}' 2>/dev/null); ` +
		`IID=$(docker image inspect "$NAME" --format '{{.Id}}' 2>/dev/null); ` +
		`echo "name=$NAME running=$RID latest=$IID"`
	try {
		const { stdout, code } = await runCommand(server, cmd, 30_000)
		if (code !== 0) return { match: true, detail: `readback skipped (inspect exit ${code})` }
		const running = stdout.match(/running=(\S+)/)?.[1] ?? ''
		const latest = stdout.match(/latest=(\S+)/)?.[1] ?? ''
		const name = stdout.match(/name=(\S+)/)?.[1] ?? '?'
		if (!running || !latest) return { match: true, detail: `readback skipped (ids unavailable: ${stdout.trim()})` }
		if (running === latest) return { match: true, detail: `container runs current ${name} (${running.slice(7, 19)})` }
		return {
			match: false,
			detail: `container is on ${running.slice(7, 19)} but ${name} resolves to ${latest.slice(7, 19)} - the recreate did NOT pick up the new image`,
		}
	} catch (err) {
		return { match: true, detail: `readback skipped (${err instanceof Error ? err.message : 'error'})` }
	}
}
