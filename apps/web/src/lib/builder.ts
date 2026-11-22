// Dedicated-builder deploy phase ("builds off the app server").
//
// When a server has `build_host` set, the expensive half of a deploy (fresh
// clone, docker build, test gate) runs on the builder server instead of the
// production server, and the finished image is STREAMED through powder to the
// target (`docker save | gzip` on the builder piped into `gunzip | docker
// load` on the target over two ssh2 connections). The target's deploy script
// then runs with POWDER_PREBUILT=1, skipping its local build + test gate and
// `up`-ing the already-loaded image.
//
// Trust model: no new edges. The builder only holds the powder master PUBkey
// (so powder can reach it); it has no key of its own to anywhere, so build
// code (npm postinstalls etc.) that compromises the builder reaches nothing.
// The app's read-only deploy key is written to the builder for the clone and
// deleted immediately after.
//
// Scope guard: apps whose compose build section uses `secrets:` or
// `additional_contexts:` are NOT builder-eligible (those inputs live on the
// target). `args:` ARE supported — `docker compose config` on the target
// resolves them to literal values which we replay as --build-arg. On any
// builder-phase failure the caller falls back to a local build with a loud
// warning; a builder outage degrades to today's behavior, never blocks
// deploys.

import type { TestGate } from '@powder/db/schema'
import { builtShaMarkerFor, parseStabilityMarkers, stabilityMarkShell, stabilityMarkerFilter, testGateResultMark } from './deploy/stability'
import { POWDER_GIT_NOREPO, gitCmd, gitHardenShellFunctions } from './git-harden'
import { protectExistingIgnoreShell, writeDockerignoreShell } from './app-runtime-files'
import { TEST_GATE_TESTS_FAILED_EXIT, childTimeoutPrefix, composeFileArgs, fontFetchRetryShellFunctions, readComposeConfig, testGateMemOverride, testGateShell, testGateStopShell } from './deploy/fragments'
import { BuilderTestGateFailedError } from './deploy-failure'
import { BuilderAppBuildFailedError, builderAppVerdictEnabled, classifyBuilderFailure } from './builder-failure'
import { composeGuardEnforced } from './deploy/compose-check'
import {
	DEPLOY_BUDGET_SEC,
	IMAGE_STREAM_MAX_MS,
	TIMEOUT_KILL_SEC,
	outerTimeoutSec,
	sshWallMs,
} from './deploy-budget'
import { stageImageTag } from './deploy-supersede'
import { buildLockShell } from './build-lock'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { Client } from 'ssh2'
import { GITHUB_KNOWN_HOSTS_SETUP, GIT_SSH_HOSTKEY_OPTS, runCommand, sshConnectConfig, writeFileSecret, writeFileViaSftp } from './ssh'
import type { ServerConfig } from './servers'
import { repoSymlinkGuardShell } from './repo-symlinks'
import { targetLinkGuardShell } from './target-links'
import { randomTempPath } from './temp-path'
import { cacheAppSlug, dockerfileAuthorityShell, dockerfileRewriteFunctions, ephemeralCacheNamespace, withOsPatchWeek } from './build-cache'
import type { DockerfileImageAuthority } from './compose-safety'
import { shq } from './shell'
import { sshCommand } from './docker-env'
import { BUILDER_PRUNE_RUN_TIMEOUT_SEC, builderCapPruneShell, builderPruneLogLine, builderPruneVerdict, builderPullGuardFunctions, parseBuilderPruneResult } from './builder-prune'
import { reportBuildHostDiskToHq } from './hq'

interface BuilderOpts {
	host: string
	repoUrl: string
	/** Decrypted read-only deploy key (PEM). */
	deployKeyPriv: string
}

export interface ComposeBuildFacts {
	image: string
	/** Absolute build context on the target, e.g. /opt/apps/app/src or …/src/api */
	context: string
	dockerfile: string
	args: Record<string, string>
	hasSecrets: boolean
	hasAdditionalContexts: boolean
}

function builderConfig(server: ServerConfig, host: string): ServerConfig {
	return { ...server, id: `builder:${host}`, name: 'powder-builder', host, port: 22 }
}

/** Read the service's resolved image + build section from the TARGET's runtime
 *  compose. Uses `config --format json` (compose v2), which interpolates env —
 *  build args arrive as literal values. */
export async function resolveComposeBuildFacts(
	server: ServerConfig,
	configFile: string,
	service: string,
	/** the compose file args the deploy's guard checked (every merged file plus
	 *  powder's override: composeFileArgs(configFile, composeFiles)). Default: the config
	 *  file and the override only. */
	cf: string = composeFileArgs(configFile),
): Promise<ComposeBuildFacts | null> {
	const parsed = await readComposeConfig(server, cf)
	if (parsed === null) return null
	const svc = (parsed as { services?: Record<string, Record<string, unknown>> }).services?.[service]
	if (!svc) return null
	const image = typeof svc.image === 'string' ? svc.image : null
	const build = svc.build as
		| { context?: string; dockerfile?: string; args?: Record<string, unknown>; secrets?: unknown; additional_contexts?: unknown }
		| string
		| undefined
	if (!image || !build) return null
	if (typeof build === 'string') {
		return { image, context: build, dockerfile: 'Dockerfile', args: {}, hasSecrets: false, hasAdditionalContexts: false }
	}
	const args: Record<string, string> = {}
	for (const [k, v] of Object.entries(build.args ?? {})) {
		if (v !== null && v !== undefined) args[k] = String(v)
	}
	return {
		image,
		context: build.context ?? '.',
		dockerfile: build.dockerfile ?? 'Dockerfile',
		args,
		hasSecrets: !!build.secrets,
		hasAdditionalContexts: !!build.additional_contexts,
	}
}

/** the names a `docker load` line may give the expected unique tag: as written,
 *  and in its canonical Docker Hub forms (`docker.io/library/x`, `docker.io/org/x`). */
export function loadedNameVariants(uniq: string): string[] {
	const forms = (ref: string): string[] => {
		const first = ref.split('/')[0] ?? ''
		const hasHost = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')
		if (hasHost) return [ref]
		return [ref, ref.includes('/') ? `docker.io/${ref}` : `docker.io/library/${ref}`]
	}
	// an untagged `image: myapp` makes the unique tag `myapp-b<id>`, which docker
	// load reports as `myapp-b<id>:latest`.
	const last = uniq.split('/').pop() ?? ''
	const untagged = !last.includes(':') && !uniq.includes('@')
	return untagged ? [...forms(uniq), ...forms(`${uniq}:latest`)] : forms(uniq)
}

/** the target side of the image stream. `docker load` runs as root and applies
 *  every tag the tar names, so a builder (build code runs there) could ship a tar that
 *  retags any image on the target (another app's, postgres:16). Every `Loaded image:`
 *  line must be the expected unique tag: any other name is untagged again (docker rmi;
 *  an image only that name held is removed) and the stream fails, before anything is
 *  retagged to `image`. The unique tag must have been loaded. Ends with the retag. */
export function targetImageLoadShell(uniq: string, image: string): string {
	const ok = loadedNameVariants(uniq).map(shq).join('|')
	return (
		`TL_OUT=$(gunzip | docker load 2>&1); TL_RC=$?; printf '%s\n' "$TL_OUT"; [ "$TL_RC" = 0 ] || exit "$TL_RC"; ` +
		`TL_SEEN=0; TL_BAD=""; ` +
		`while IFS= read -r TL_L; do case "$TL_L" in "Loaded image: "*) TL_N=\${TL_L#Loaded image: }; case "$TL_N" in ${ok}) TL_SEEN=1;; *) TL_BAD="$TL_BAD $TL_N"; docker rmi -- "$TL_N" >/dev/null 2>&1 || true;; esac;; esac; done <<TL_EOF
$TL_OUT
TL_EOF
` +
		`if [ -n "$TL_BAD" ]; then echo "[builder] refusing the streamed image: the tar also named$TL_BAD (only ${uniq.replace(/[^A-Za-z0-9._/:-]/g, '_')} may be loaded); those names were untagged again, an image they pointed to before is not restored"; docker rmi -- ${shq(uniq)} >/dev/null 2>&1 || true; exit 1; fi; ` +
		`if [ "$TL_SEEN" != 1 ]; then echo "[builder] refusing the streamed image: docker load did not report ${uniq.replace(/[^A-Za-z0-9._/:-]/g, '_')}"; exit 1; fi; ` +
		`docker tag ${shq(uniq)} ${shq(image)} && docker rmi ${shq(uniq)}`
	)
}

/** the builder's built-sha marker carries the phase's random nonce (like the
 *  deploy's synced-sha marker), so build or test-gate output cannot print it.
 *  Defined with the other run markers (deploy/stability.ts), which strip it from the log. */
export { builtShaMarkerFor }

/** the built commit from the LAST whole line `<marker> <sha>`; anything else in
 *  stdout (an unnonced `[builder] built-sha` line included) is ignored. */
export function parseBuiltSha(stdout: string, nonce: string): string | null {
	if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) return null
	const all = [...stdout.matchAll(new RegExp(`^${builtShaMarkerFor(nonce)} ([0-9a-f]{40})$`, 'gm'))]
	return all[all.length - 1]?.[1] ?? null
}

/** the Dockerfile path on the builder clone, or a reason to refuse. An absolute
 *  dockerfile must be the target context or inside it; a relative one may not leave the
 *  clone's src dir (`../` past it). */
export function builderDockerfilePath(
	dockerfile: string,
	context: string,
	ctx: string,
	srcRoot: string,
): { df: string } | { refuse: string } {
	if (dockerfile.startsWith('/')) {
		const d = posix.normalize(dockerfile)
		const c = posix.normalize(context).replace(/\/+$/, '')
		if (d !== c && !d.startsWith(`${c}/`))
			return { refuse: `the dockerfile ${dockerfile} is outside the build context ${context}` }
		return { df: `${ctx}${d.slice(c.length)}` }
	}
	const df = posix.normalize(`${ctx}/${dockerfile}`)
	const r = posix.normalize(srcRoot).replace(/\/+$/, '')
	if (df !== r && !df.startsWith(`${r}/`)) return { refuse: `the dockerfile ${dockerfile} leaves the repo checkout` }
	return { df }
}

/** Stream `docker save | gzip` on the builder into `gunzip | docker load` on
 *  the target, piping through powder. Backpressure via Node stream pipe. */
async function streamImage(
	builder: ServerConfig,
	target: ServerConfig,
	/** unique builder-side tag that is saved (never shared between deploys) */
	uniq: string,
	/** the tag the target must end up with */
	image: string,
	onChunk?: (s: string) => void,
	timeoutMs: number = IMAGE_STREAM_MAX_MS,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const src = new Client()
		const dst = new Client()
		let srcCode: number | null = null
		let dstCode: number | null = null
		let settled = false
		const fail = (err: Error) => {
			if (settled) return
			settled = true
			src.end()
			dst.end()
			reject(err)
		}
		const maybeDone = () => {
			if (settled || srcCode === null || dstCode === null) return
			settled = true
			src.end()
			dst.end()
			if (srcCode !== 0) return reject(new Error(`docker save exited ${srcCode} on builder`))
			if (dstCode !== 0) return reject(new Error(`docker load exited ${dstCode} on target`))
			resolve()
		}
		const timer = setTimeout(() => fail(new Error(`image stream timed out (${Math.round(timeoutMs / 60_000)}m)`)), timeoutMs)
		const clear = () => clearTimeout(timer)

		dst.on('ready', () => {
			dst.exec(sshCommand(targetImageLoadShell(uniq, image)), (dErr, dStream) => {
				if (dErr) return fail(dErr)
				dStream.on('close', (code: number | null) => {
					// null exit code = channel died mid-transfer; a truncated
					// `docker load` must not read as success (fallback-to-local
					// handles the resulting failure).
					dstCode = code ?? 255
					clear()
					maybeDone()
				})
				dStream.on('data', (c: Buffer) => onChunk?.(c.toString('utf8')))
				dStream.stderr.on('data', (c: Buffer) => onChunk?.(c.toString('utf8')))

				src.on('ready', () => {
					src.exec(sshCommand(`docker save ${shq(uniq)} | gzip -1`), (sErr, sStream) => {
						if (sErr) return fail(sErr)
						sStream.on('close', (code: number | null) => {
							srcCode = code ?? 255
							// end the target's stdin so gunzip/docker load finish
							dStream.end()
							maybeDone()
						})
						sStream.stderr.on('data', (c: Buffer) => onChunk?.(c.toString('utf8')))
						sStream.pipe(dStream, { end: false })
					})
				})
				src.on('error', fail)
				src.connect(sshConnectConfig(builder, { readyTimeout: 8000 }))
			})
		})
		dst.on('error', fail)
		dst.connect(sshConnectConfig(target, { readyTimeout: 8000 }))
	})
}

/** Concurrent build slots on the dedicated builder (env POWDER_BUILD_SLOTS,
 *  default 2, clamped 1..8). Slot i is the flock file `<lock>.i` (buildLockShell). */
export function builderBuildSlots(): number {
	const n = Number.parseInt(process.env.POWDER_BUILD_SLOTS ?? '', 10)
	return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 2
}

/** Shell function `plock <waitSec> cmd...`: run cmd holding whichever slot lock
 *  frees first. Tries each slot with `flock -n`, sleeps 2s between sweeps, gives
 *  up (exit 124, like a timeout: the test gate counts it as infra, not failed tests) once <waitSec> has elapsed. Returns cmd's own
 *  exit code. 213 = "slot busy" sentinel (flock -E), never cmd's code. */
export function plockFn(slots: number): string {
	// The wrapped command runs inside `sh -c`, which remaps its OWN exit 213
	// to 212 so it can never be mistaken for the "slot busy" sentinel.
	// The flock call is `|| __pr=$?` so a busy slot (rc 213) never trips
	// `set -e`, whatever context plock is called from.
	return (
		`plock() { __pe=$(( $(date +%s) + $1 )); shift; __pm=0; ` +
		`while :; do __pi=0; while [ "$__pi" -lt ${slots} ]; do __pr=0; ` +
		`flock -n -E 213 ${buildLockShell('.$__pi')} sh -c '"$@"; r=$?; [ "$r" -eq 213 ] && r=212; exit "$r"' _ "$@" || __pr=$?; ` +
		`if [ "$__pr" -ne 213 ]; then return "$__pr"; fi; __pi=$((__pi+1)); done; ` +
		`if [ "$(date +%s)" -ge "$__pe" ]; then echo "[build-lock] no free build slot before the wait budget elapsed"; return 124; fi; ` +
		`if [ "$__pm" -eq 0 ]; then echo "[build-lock] all ${slots} build slots busy, waiting"; __pm=1; fi; sleep 2; done; }; `
	)
}

/** Shell for the builder's clone (+ pinned fetch/checkout), retried like the local
 *  path: 3 attempts, 5s then 15s backoff, only on exit 128 with "Permission denied
 *  (publickey)" or "Could not read from remote repository" (transient GitHub/DNS
 *  blips). Each retry starts from a clean src dir. Ends with `&& ` so it chains.
 *  Pure string builder: unit-tested under bash with a stub git. */
export function builderCloneShell(dir: string, repoUrl: string, branch: string | null, sha: string | null): string {
	const src = shq(`${dir}/src`)
	const attempt =
		`${POWDER_GIT_NOREPO} clone --depth 1 ${branch ? `--branch ${shq(branch)} ` : ''}-- ${shq(repoUrl)} ${src}` +
		// A webhook sha is only honoured when it IS the branch tip
		// the clone just got. An older (replayed, still validly signed) sha would
		// otherwise roll the app back; then the tip is built and reported as the
		// built sha, which the target server pins in strict mode.
		(sha
			? ` && { __tip=$(${gitCmd(src, src)} rev-parse HEAD); if [ "$__tip" = ${shq(sha)} ]; then echo "[builder] pinned to commit $__tip"; else echo "[builder] requested sha not at branch tip, building HEAD ($__tip)"; fi; }`
			: '')
	return (
		gitHardenShellFunctions() +
		`clone_all() { __a=0; while :; do __a=$((__a+1)); rm -rf ${src}; ` +
		`__o=$( { ${attempt}; } 2>&1 ) && { printf '%s\\n' "$__o"; return 0; }; __rc=$?; printf '%s\\n' "$__o"; ` +
		`if [ "$__a" -lt 3 ] && [ "$__rc" = 128 ] && printf '%s' "$__o" | grep -qE 'Permission denied \\(publickey\\)|Could not read from remote repository'; then ` +
		`echo "[builder] clone attempt $__a failed, retrying"; if [ "$__a" = 1 ]; then sleep 5; else sleep 15; fi; else return "$__rc"; fi; done; }; ` +
		`clone_all && `
	)
}

/** the symlink authority on the builder's fresh clone, as on every target
 *  checkout: a tracked symlink that is absolute, leaves the checkout or takes a
 *  powder-owned name is removed and the build refused (the builder runs `docker
 *  build` as root on that tree). Ends with `&& ` so it chains after builderCloneShell. */
export function builderSymlinkGuardShell(dir: string): string {
	return (
		`{ ${repoSymlinkGuardShell(`${dir}/src`)} || { echo "[builder] refusing: the repo tracks hostile symlink(s) (removed)"; exit 1; }; } && ` +
		// the one pre-checkout link authority on the clone (no container
		// binds the builder dir, so (i) has nothing to check there).
		`${targetLinkGuardShell({ dir: `${dir}/src`, target: 'HEAD', binds: false, who: '[builder]' })} && `
	)
}

/** guard for the builder path: before `docker build`, make sure the
 *  context has a .dockerignore (written from powder's default when missing) and
 *  FAIL the build if a deploy key or *.env file sits in the context root without
 *  being ignored. Ends with `&& ` so it chains. Pure string builder, unit-tested
 *  under bash. */
export function builderDockerignoreShell(ctx: string, df?: string): string {
	const c = shq(ctx)
	// a repo ignore file gets powder's protected entries LAST (a
	// later !negation cannot re-include them), and so does a <Dockerfile>.dockerignore,
	// which BuildKit reads instead of the context's file.
	const dfIgnore = df ? `${df}.dockerignore` : null
	return (
		`{ if [ -L ${c}/.dockerignore ]; then echo "[builder] refusing: .dockerignore is a symlink"; exit 1; fi; ${writeDockerignoreShell(ctx)}; } && ` +
		(dfIgnore
			? `{ if [ -e ${shq(dfIgnore)} ] || [ -L ${shq(dfIgnore)} ]; then ${protectExistingIgnoreShell(dfIgnore)}; fi; } && `
			: '') +
		`{ if [ -e ${c}/.deploy-key ] && ! grep -qxF -- '.deploy-key' ${c}/.dockerignore; then ` +
		`echo "[builder] refusing to build: .deploy-key is in the build context and not in .dockerignore"; exit 1; fi; } && ` +
		`{ for f in ${c}/*.env; do if [ -e "$f" ] && ! grep -qxF -- '*.env' ${c}/.dockerignore; then ` +
		`echo "[builder] refusing to build: $f is in the build context and *.env is not in .dockerignore"; exit 1; fi; done; } && `
	)
}

/** what the builder's EXIT trap removes after a FAILED build: the build's unique
 *  image tag and the clone dir, each only when its name is one powder makes
 *  (`/opt/builds/<slug>`, `<image>-b<id>`). Ends with `; ` (or is empty). */
export function builderFailCleanupShell(dir: string, uniq: string): string {
	const i = /^[A-Za-z0-9][A-Za-z0-9._/:-]*-b[A-Za-z0-9_.-]+$/.test(uniq) ? `docker rmi -- ${shq(uniq)} >/dev/null 2>&1 || true; ` : ''
	return i + builderDirCleanupShell(dir)
}

/** removes the clone dir (only a `/opt/builds/<slug>` one); the EXIT trap runs it
 *  after a successful build too, nothing reads the clone after the script.
 *  Ends with `; ` (or is empty). */
export function builderDirCleanupShell(dir: string): string {
	return /^\/opt\/builds\/[A-Za-z0-9._-]+$/.test(dir) && !/\/\.\.?$/.test(dir) ? `rm -rf -- ${shq(dir)} || true; ` : ''
}

const stateWarned = new Set<string>()

/** Run the build host's cap prune (builder-prune.ts), log it, and report a
 *  host over its cap (or never pruned) to HQ. Never throws. */
export async function capPruneBuildHost(builder: ServerConfig, host: string): Promise<void> {
	try {
		// up to 120s for a pull, 600s for the build slots, 900s of prune, plus
		// the measurements (builderCapPruneWorstSec, 1870s): wait 2400s.
		const res = await runCommand(builder, builderCapPruneShell({ slots: builderBuildSlots() }), BUILDER_PRUNE_RUN_TIMEOUT_SEC * 1000)
		for (const line of res.stdout.split('\n')) {
			if (!line.startsWith('[builder-prune]')) continue
			// an unwritable state or attempt path is said once per host and path,
			// not after every build.
			if (line.includes('is not writable')) {
				const key = `${host}|${line}`
				if (stateWarned.has(key)) continue
				stateWarned.add(key)
			}
			console.log(`[builder-prune] ${host}: ${line.slice(15).trim()}`)
		}
		const r = parseBuilderPruneResult(res.stdout)
		if (!r) {
			console.log(`[builder-prune] ${host}: no result (exit ${res.code})`)
			return
		}
		console.log(builderPruneLogLine(host, r))
		const v = builderPruneVerdict(r)
		if (v.post) await reportBuildHostDiskToHq(host, v.problem, v.afterPrune)
	} catch (err) {
		console.error(`[builder-prune] ${host}:`, err instanceof Error ? err.message : err)
	}
}

/** The builder-side shell: clone with the pinned GitHub host keys, build, test
 *  gate. Pure string builder (unit-tested): contains no key material, only the
 *  path of the SFTP-delivered key. */
export function buildBuilderScript(p: {
	dir: string
	keyPath: string
	repoUrl: string
	branch: string | null
	sha: string | null
	image: string
	uniq: string
	ctx: string
	df: string
	buildArgs: string
	/** the build args as a map (the same values as buildArgs): the Dockerfile
	 *  check resolves FROM / --from refs with them, as the build will. */
	args?: Record<string, string>
	/** ignored, the builder always builds with `--pull`: its Dockerfile image check
	 *  runs with the TARGET server's lists (dockerfileImageAuthority), so a local image only
	 *  the builder has must never be what FROM resolves to. */
	pull?: boolean
	/** BuildKit cache namespace of the app (build-cache.ts); unset = a fresh
	 *  random one (isolated, cold cache). */
	cacheNamespace?: string
	/** The app name the cache ids carry (default: the workdir name). */
	app?: string
	/** the deploy's compose-guard image authority (dockerfileImageAuthority). */
	dockerfileAuthority?: DockerfileImageAuthority | null
	/** the nonce of the built-sha marker (builtShaMarkerFor). */
	shaNonce?: string
	/** Seconds the builder phase may run (gates the next/font fetch retry). */
	budgetSec?: number
}): string {
	const { dir, ctx } = p
	const pull = true
	const nsIn = (p.cacheNamespace ?? '').replace(/[^0-9a-f]/g, '')
	const ns = nsIn.length >= 16 ? nsIn : ephemeralCacheNamespace()
	const app = p.app ?? dir.split('/').pop() ?? 'app'
	return (
		`set -e; DFR_DIR=""; ` +
		plockFn(builderBuildSlots()) +
		// image pulls of this script never overlap the build host's cap prune.
		builderPullGuardFunctions() +
		// one retry of a build that failed on a next/font Google Fonts fetch (shared with
		// the target's local build), only while 15 min of the builder budget are left.
		// DEADLINE = end of the builder budget: each build attempt's timeout is taken
		// from it (childTimeoutPrefix, after the slot wait), so a retry never runs into
		// the outer kill and the local fallback keeps its reserve.
		`DEADLINE=$(( $(date +%s) + ${Math.max(60, Math.floor(p.budgetSec ?? DEPLOY_BUDGET_SEC))} )); ` +
		fontFetchRetryShellFunctions(`[ $(( DEADLINE - $(date +%s) )) -ge 900 ]`) +
		dockerfileRewriteFunctions(app) +
		// The inline rm after checkout only runs on success; a failed clone left
		// the private key on the builder. EXIT covers both.
		// a failed build also removes its unique image; the clone goes either way (a
		// success keeps the image: runBuilderPhase streams it to the target, then removes it).
		`trap ${shq(`__rc=$?; rm -f ${p.keyPath}; rm -f "\${__ffo:-}"; if [ -n "$DFR_DIR" ]; then rm -rf "$DFR_DIR"; fi; ${testGateStopShell(`builder|${dir}`)}; if [ "$__rc" != 0 ]; then :; ${builderFailCleanupShell(dir, p.uniq)}else :; ${builderDirCleanupShell(dir)}fi`)} EXIT; ` +
		`rm -rf ${shq(dir)} && mkdir -p ${shq(dir)} && ` +
		`chmod 600 ${shq(p.keyPath)} && ` +
		// 077 would make every cloned file root-only; COPY preserves perms into the
		// image and a non-root runtime user (USER nextjs) then EACCESes on /app
		// (a builder deploy crash-loops exactly this way).
		`umask 022 && ` +
		`echo ${shq(`[builder] fresh clone of ${p.repoUrl}`)} && ` +
		// Same pinned github.com host keys as the target path: no
		// accept-new, no trust on first use on a fresh builder.
		GITHUB_KNOWN_HOSTS_SETUP +
		`export GIT_SSH_COMMAND="ssh -i ${shq(p.keyPath)} -o IdentitiesOnly=yes ${GIT_SSH_HOSTKEY_OPTS}"; ` +
		builderCloneShell(dir, p.repoUrl, p.branch, p.sha) +
		`rm -f ${shq(p.keyPath)} && ` +
		builderSymlinkGuardShell(dir) +
		`__bs=$(${gitCmd(shq(`${dir}/src`), shq(`${dir}/src`))} rev-parse HEAD) && echo "[builder] built-sha $__bs" && ` +
		(p.shaNonce ? `echo "${builtShaMarkerFor(p.shaNonce)} $__bs" && ` : '') +
		`echo ${shq(`[builder] docker build ${p.image} (context ${ctx})`)} && ` +
		builderDockerignoreShell(ctx, p.df) +
		// the build reads the cache-id rewrite of the Dockerfile from a temp dir
		// outside the context (its <Dockerfile>.dockerignore copied along, protected).
		`DFR_DIR=$(mktemp -d /tmp/powder-dfr.XXXXXX) && ` +
		`DFR_NS=${shq(ns)}; DFR_APP=${shq(cacheAppSlug(app))}; DFR_MODE=${composeGuardEnforced() ? 'enforce' : 'warn'}; DFR_PULL=${pull ? 1 : 0}; DFR_OWN=${shq(p.image)}; ${dockerfileAuthorityShell(p.dockerfileAuthority)}` +
		// the build args override ARG defaults in the image refs (KEY=VALUE lines;
		// a newline in a value becomes a space, an invalid ref the check refuses).
		`printf '%s\\n' ${Object.entries(p.args ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => shq(`${k}=${String(v).replace(/[\r\n]/g, ' ')}`)).join(' ') || "''"} > "$DFR_DIR/args" && ` +
		`dfr_src ${shq(p.df)} ${shq(ctx)} && dfr_one ${shq(p.df)} "$DFR_DIR/Dockerfile" '' "$DFR_DIR/args" && rm -f "$DFR_DIR/args" && dfr_bases && ` +
		`{ if [ -L ${shq(`${p.df}.dockerignore`)} ]; then echo "[builder] refusing: ${p.df.replace(/[^A-Za-z0-9._/-]/g, '_')}.dockerignore is a symlink"; exit 1; fi; if [ -e ${shq(`${p.df}.dockerignore`)} ]; then cp ${shq(`${p.df}.dockerignore`)} "$DFR_DIR/Dockerfile.dockerignore" && ( ${protectExistingIgnoreShell('$DFR_DIR/Dockerfile.dockerignore').replace(/'\$DFR_DIR\/Dockerfile\.dockerignore'/g, '"$DFR_DIR/Dockerfile.dockerignore"')} ); fi; } && ` +
		`font_retry plock 2400 ${childTimeoutPrefix(1800, 60)} docker build ${pull ? '--pull ' : ''}-t ${shq(p.uniq)} -f "$DFR_DIR/Dockerfile" ${p.buildArgs} ${shq(ctx)} 2>&1 && ` +
		`if [ -f ${shq(`${ctx}/.powder/test.sh`)} ]; then echo '── test gate ──'; ` +
		testGateShell({ dir: shq(ctx), label: `builder|${dir}`, run: 'plock 2400 timeout 900', tag: '[builder test-gate]', testsFailedExit: TEST_GATE_TESTS_FAILED_EXIT, mem: testGateMemOverride(), enforce: composeGuardEnforced(), app: dir.split('/').pop(), loginSelf: p.dockerfileAuthority?.self || app, loginHosts: p.dockerfileAuthority?.loginHosts ?? [], resultMark: p.shaNonce ? testGateResultMark(p.shaNonce) : undefined }) +
		`else echo "[builder test-gate] no .powder/test.sh - skipped"; ${p.shaNonce ? stabilityMarkShell(p.shaNonce, 'test-gate-result', 'none') : ''}fi`
	)
}

/** Run the builder phase: clone, build, test-gate on the builder, then stream
 *  the image to the target. Throws on any failure — the caller decides whether
 *  to fall back to a local build. Returns the log output. */
export async function runBuilderPhase(...a: Parameters<typeof runBuilderPhaseOnce>): ReturnType<typeof runBuilderPhaseOnce> {
	try {
		return await runBuilderPhaseOnce(...a)
	} finally {
		// the build host's disk cap, after every builder phase (success or not);
		// in the background, so it never delays or fails the deploy.
		const [server, opts] = a
		void capPruneBuildHost(builderConfig(server, opts.host), opts.host)
	}
}

async function runBuilderPhaseOnce(
	server: ServerConfig,
	builderOpts: BuilderOpts,
	facts: ComposeBuildFacts,
	/** Unique per-app slug for the builder workdir. MUST NOT be the compose
	 *  service name: many apps use `app`, and two concurrent builder
	 *  phases would rm -rf each other's in-flight clone (git exit 128). */
	dirSlug: string,
	/** What to build: the configured branch and, when known, the exact pushed
	 *  commit. The returned sha is what the TARGET must check out, so the image,
	 *  the recorded git_sha and powder-migrate all describe the same commit. */
	ref: { branch?: string | null; sha?: string | null; deployId?: string | null; cacheNamespace?: string; app?: string; dockerfileAuthority?: DockerfileImageAuthority | null },
	onChunk?: (s: string) => void,
	/** Seconds this phase may take (remaining deploy budget minus the script reserve). */
	budgetSec: number = DEPLOY_BUDGET_SEC,
): Promise<{ sha: string | null; stageImage: string; testGate: TestGate | null }> {
	const phaseStart = Date.now()
	const builder = builderConfig(server, builderOpts.host)
	// Map the target's absolute context to a path inside the builder clone:
	// context is /opt/apps/<app>/src[…] for the standard layout; everything
	// after "/src" is the in-repo subpath. Workdir-layout apps (context == the
	// app dir, no /src) are not builder-eligible.
	const m = facts.context.match(/\/src(\/.*)?$/)
	if (!m) throw new Error(`builder: context ${facts.context} is not a src/-layout path — not builder-eligible`)
	const sub = m[1] ?? ''
	const dir = `/opt/builds/${dirSlug.replace(/[^A-Za-z0-9._-]/g, '_')}`
	const ctx = `${dir}/src${sub}`
	const dfr = builderDockerfilePath(facts.dockerfile, facts.context, ctx, `${dir}/src`)
	if ('refuse' in dfr) throw new Error(`builder: ${dfr.refuse}`)
	const df = dfr.df
	const branch = ref.branch && /^[A-Za-z0-9._/-]+$/.test(ref.branch) ? ref.branch : null
	const sha = ref.sha && /^[0-9a-f]{40}$/.test(ref.sha) ? ref.sha : null
	// Unique builder-side tag: two concurrent builds of the same facts.image
	// would otherwise retag each other's result before `docker save`.
	const stageImage = stageImageTag(facts.image, ref.deployId ?? `t${Date.now()}`)
	const uniq = `${facts.image}-b${(ref.deployId ?? `t${Date.now()}`).replace(/^dep_/, '').replace(/[^A-Za-z0-9_.-]/g, '')}`
	// BUILDKIT_SYNTAX picks the frontend like `# syntax=` does; only the
	// Dockerfile directive is allow-listed (build-cache.ts), so the build arg is refused.
	if (Object.keys(facts.args).some((k) => k.toUpperCase() === 'BUILDKIT_SYNTAX'))
		throw new Error('build arg BUILDKIT_SYNTAX is not allowed (it selects a custom BuildKit frontend); use # syntax=docker/dockerfile:<version>')
	// OS_PATCH_WEEK (build-cache.ts): a Dockerfile that declares it refreshes its
	// OS upgrade layer weekly.
	const args = withOsPatchWeek(facts.args)
	const buildArgs = Object.entries(args)
		.map(([k, v]) => `--build-arg ${shq(`${k}=${v}`)}`)
		.join(' ')

	// The deploy key travels over SFTP (0600), never inside the exec'd command
	// line: sshd runs `bash -c '<script>'`, so anything in the script is world
	// readable in /proc/<pid>/cmdline for the whole build. The file sits
	// NEXT to the clone dir (the script rm -rf's the dir) and is removed by the
	// script's EXIT trap and, as a backstop, by the finally below.
	const shaNonce = randomBytes(12).toString('hex')
	const keyPath = `${dir}.k.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
	const script = buildBuilderScript({
		dir,
		keyPath,
		repoUrl: builderOpts.repoUrl,
		branch,
		sha,
		image: facts.image,
		uniq,
		ctx,
		df,
		buildArgs,
		args,
		cacheNamespace: ref.cacheNamespace,
		app: ref.app,
		dockerfileAuthority: ref.dockerfileAuthority ?? null,
		shaNonce,
		budgetSec,
	})

	onChunk?.(`── builder phase (${builderOpts.host}) ──\n`)
	let res: Awaited<ReturnType<typeof runCommand>>
	// the script carries the build args (often secrets). It is uploaded over SFTP
	// (0700, unique name) and run as `bash <path>`, like runDeployScript, so it never sits in
	// the exec'd command line (/proc/<pid>/cmdline) for the whole build.
	const scriptPath = `${randomTempPath('/tmp/powder-builder')}.sh`
	try {
		await writeFileSecret(builder, keyPath, builderOpts.deployKeyPriv.trimEnd() + '\n')
		await writeFileViaSftp(builder, scriptPath, script, 0o700, 30_000, true, true)
		// `timeout -k`: the builder script (and the docker build under it) dies at
		// the deadline instead of running on orphaned while holding a slot lock.
		// the live log (and the failed deploy's stored error built from it) never shows
		// this phase's marker lines: parsed from res.stdout below, stripped from the log.
		const live = stabilityMarkerFilter(shaNonce, onChunk)
		try {
			res = await runCommand(
				builder,
				`timeout -k ${TIMEOUT_KILL_SEC} ${outerTimeoutSec(budgetSec)} bash ${shq(scriptPath)}; rc=$?; rm -f ${shq(scriptPath)}; exit $rc`,
				sshWallMs(budgetSec),
				live.push,
			)
		} finally {
			live.flush()
		}
	} finally {
		await runCommand(builder, `rm -f ${shq(keyPath)} ${shq(scriptPath)}`, 10_000).catch(() => {})
	}
	// the commit this run checked out (nonced marker), also on a failure: the failure's
	// commit status goes on it, which is not the requested one when that was not the tip
	const ranSha = parseBuiltSha(res.stdout, shaNonce)
	if (res.code === TEST_GATE_TESTS_FAILED_EXIT) throw new BuilderTestGateFailedError(ranSha)
	if (res.code !== 0) {
		// the commit's own failure (builder-failure.ts) fails the deploy; anything else falls back,
		// and so does a build of another commit than the one asked for (the fallback builds that one).
		const verdict = classifyBuilderFailure(res.stdout, res.code, { requestedSha: sha, builtSha: ranSha })
		if (verdict.kind === 'app' && builderAppVerdictEnabled()) throw new BuilderAppBuildFailedError(verdict.reason, ranSha)
		if (verdict.kind === 'app') onChunk?.(`[builder] POWDER_BUILDER_APP_VERDICT=off: falling back although this looks like the commit's own failure (${verdict.reason.slice(0, 300)})\n`)
		throw new Error(`builder phase failed (exit ${res.code})`)
	}
	const builtSha = ranSha
	// the gate's outcome from this run's nonced mark (passed or none on a successful phase)
	const testGate = parseStabilityMarkers(res.stdout, shaNonce).testGateResult
	onChunk?.(`── builder → target image stream ──\n`)
	try {
		// Land the image on a unique per-deploy tag, NOT facts.image: the shared tag
		// is what the running compose uses and is only retagged at the swap gate.
		const streamMs = Math.min(IMAGE_STREAM_MAX_MS, Math.max(30_000, budgetSec * 1000 - (Date.now() - phaseStart)))
		await streamImage(builder, server, uniq, stageImage, onChunk, streamMs)
	} finally {
		await runCommand(builder, `docker rmi ${shq(uniq)} >/dev/null 2>&1 || true`, 10_000).catch(() => {})
	}
	onChunk?.(`[builder] image ${stageImage} loaded on ${server.host}\n`)
	return { sha: builtSha, stageImage, testGate }
}
