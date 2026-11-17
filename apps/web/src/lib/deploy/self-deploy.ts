import { posix } from 'node:path'
import { gitCmd, gitHardenShellFunctions } from '../git-harden'
import { composeProjectNameFor, selfDeployNames } from '../compose-safety'

import { DeployStepError } from '../deploy-failure'
import { CONFIG_BAD_MARKER } from '../startup-checks'
import type { ServerConfig } from '../servers'
import { appLockPath } from '../deploy-supersede'
import { appLockShell } from './fragments'
import { lockedPruneShell } from './prune-lock'
import { targetLinkGuardShell } from '../target-links'
import { parseDeployedImage, runDeployScript } from './run'
import { shq } from '../shell'
import { buildLockShell } from '../build-lock'
import { runCommand } from '../ssh/connection'
import { GITHUB_KNOWN_HOSTS_SETUP, GIT_SSH_HOSTKEY_OPTS, workdirSyncShell } from '../ssh/git'

export type SelfDbLayout = 'private' | 'legacy' | 'fresh'

/** is this deploy powder's own (runSelfDeploy: no compose guard, no link guards)?
 *  Decided by identity, never by the compose service label alone (any app may name a
 *  service `powder` on its own network): the container name is the self container, the
 *  service the self service, the server POWDER_SELF_SERVER_ID, the compose project the
 *  self container's, and (when POWDER_SELF_SRC or POWDER_SRC is set) the working dir and
 *  compose file sit under that source dir's parent. A deploy that is not the self
 *  container takes the normal guarded path; the self container with any other mismatch
 *  (or with POWDER_SELF_SERVER_ID unset) is refused. Pure. */
export function selfDeployDecision(
	t: { serverId: string; service: string; containerName: string | null; composeProject: string | null; workingDir: string; configFile: string },
	env: Record<string, string | undefined> = process.env,
): 'self' | 'normal' | { refuse: string } {
	const names = selfDeployNames(env)
	if (!names.service || t.containerName !== names.container) return 'normal'
	const serverId = (env.POWDER_SELF_SERVER_ID ?? '').trim()
	if (!serverId)
		return { refuse: `POWDER_SELF_SERVICE is set but POWDER_SELF_SERVER_ID is not: powder cannot tell its own server from another one, so it does not self-deploy "${names.container}". Set POWDER_SELF_SERVER_ID in powder.env (or use bin/self-deploy.sh).` }
	if (serverId !== t.serverId) return 'normal'
	const why: string[] = []
	if (t.service !== names.service) why.push(`compose service "${t.service}" is not POWDER_SELF_SERVICE "${names.service}"`)
	if (t.composeProject !== composeProjectNameFor(names.container))
		why.push(`compose project "${t.composeProject ?? ''}" is not "${composeProjectNameFor(names.container)}"`)
	const src = (env.POWDER_SELF_SRC ?? env.POWDER_SRC ?? '').trim()
	if (src) {
		const root = posix.dirname(posix.normalize(src).replace(/\/+$/, '') || '/')
		const inside = (p: string) => {
			if (!p.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(p)) return false
			const n = posix.normalize(p)
			return root !== '/' && (n === root || n.startsWith(`${root}/`))
		}
		if (!inside(t.workingDir)) why.push(`working dir ${t.workingDir} is not under ${root}`)
		if (!inside(t.configFile)) why.push(`compose file ${t.configFile} is not under ${root}`)
	}
	return why.length ? { refuse: `the container "${names.container}" does not look like powder's own deploy (${why.join('; ')})` } : 'self'
}

/** Where the detached recreate of an in-app self-deploy logs when the ssh user is
 *  root: a root-only (0700) dir. A non-root ssh user logs to $HOME/.powder-logs. */
const SELF_LOG_DIR = '/var/lib/powder/logs'

/** prints the server's build cache id (docker/web.Dockerfile keys powder's own
 *  BuildKit cache mounts with it, so no app build or base-image ONBUILD can name
 *  them), creating it once. Same snippet as BUILD_CACHE_ID_SH in bin/self-deploy.sh.
 *  Never fails: no id means an empty one (still distinct from every app's ids). */
export const BUILD_CACHE_ID_SH =
	'f=/opt/apps/.powder-build-cache-id; if [ ! -s "$f" ] && [ -d /opt/apps ]; then (umask 077; od -An -N16 -tx1 /dev/urandom | tr -d " \\n" > "$f") 2>/dev/null; fi; cat "$f" 2>/dev/null'

/** Shell: which DB layout powder's server runs. The rule lives in bin/lib-db-layout.sh
 *  (POWDER_DB_LAYOUT_SH, used by bin/install.sh and bin/self-deploy.sh); this is the
 *  same text, kept byte-identical by a test. Reads PDB_DIR and PDB_ENVF, prints
 *  `private`, `legacy` (the shared-network layout) or `fresh`. */
export const DB_LAYOUT_SH = String.raw`if docker container inspect -f ok powder-postgres >/dev/null 2>&1; then echo private; elif docker container inspect -f "{{range .Mounts}}{{.Source}} {{end}}" postgres 2>/dev/null | grep -q powder-pgdata; then echo legacy; elif docker container inspect -f "{{json .NetworkSettings.Networks}}" powder 2>/dev/null | grep -q "\"internal\""; then echo legacy; else PDB_HOST=$(sed -n "s/^DATABASE_URL=//p" "$PDB_ENVF" 2>/dev/null | head -1 | tr -d "\"\047\r" | sed -e "s|^[A-Za-z][A-Za-z0-9+.-]*://||" -e "s|[/?#].*||" -e "s|.*@||" -e "s|^\([^:[]*\):.*|\1|" -e "s|^\[\([^]]*\)].*|\1|"); PDB_NET=$(sed -n "s/^POWDER_DB_NETWORK=//p" "$PDB_ENVF" 2>/dev/null | head -1 | tr -d "\"\047\r"); if [ "$PDB_HOST" = postgres ] && [ "$PDB_NET" != private ]; then echo legacy; elif [ -d "$PDB_DIR/powder-pgdata" ]; then echo private; else echo fresh; fi; fi`

/** The layout probe for powder's own server: DB_LAYOUT_SH with the data dir (parent of
 *  powder-pgdata) and powder's env file on that server. Plain paths only; anything
 *  else falls back to the defaults. */
export function selfDbLayoutShell(dataDir: string, envFile = '/opt/apps/powder.env'): string {
	const plain = (p: string, d: string) => (/^[A-Za-z0-9_./-]+$/.test(p) ? p : d)
	return `PDB_DIR=${shq(plain(dataDir, '/opt/apps'))}; PDB_ENVF=${shq(plain(envFile, '/opt/apps/powder.env'))}; ${DB_LAYOUT_SH}`
}

/** The layout the probe printed: its last non-empty stdout line (a login banner may
 *  come first), or null when that line is not exactly one of the known words. Pure. */
export function parseSelfDbLayout(stdout: string): SelfDbLayout | null {
	const last = stdout
		.split('\n')
		.map((l) => l.replace(/\r$/, ''))
		.filter((l) => l.trim() !== '')
		.at(-1)
	return last === 'private' || last === 'legacy' || last === 'fresh' ? last : null
}

/** Runs the layout probe on powder's own server. Fails closed: an ssh error, a
 *  timeout or an answer that is not a known layout throws DeployStepError, so nothing
 *  is recreated onto networks where powder cannot reach its DB. */
export async function detectSelfDbLayout(server: ServerConfig): Promise<SelfDbLayout> {
	const fail = (why: string) =>
		new DeployStepError(
			`self-deploy: refusing, the DB layout of powder's server could not be detected (${why}). Nothing was recreated. Check that the server answers over ssh, that docker runs there (docker ps -a --filter name=postgres) and that DATABASE_URL in powder's env file (POWDER_ENV_FILE, default /opt/apps/powder.env) names the DB host.\n__POWDER_FAIL__ step=preflight code=1`,
		)
	let stdout: string
	try {
		const r = await runCommand(
			server,
			selfDbLayoutShell(
				process.env.POWDER_DATA_DIR?.trim() || '/opt/apps',
				process.env.POWDER_ENV_FILE?.trim() || '/opt/apps/powder.env',
			),
			30_000,
		)
		stdout = r.stdout
	} catch (e) {
		throw fail(`probe failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
	}
	const layout = parseSelfDbLayout(stdout)
	if (!layout) {
		const got = stdout.trim().split('\n').at(-1)?.trim().slice(0, 80) ?? ''
		throw fail(got ? `unexpected answer: ${got}` : 'empty answer')
	}
	return layout
}

/** The compose -f args for powder's own deploy, mirroring bin/self-deploy.sh: the
 *  shared-network layout (docker-compose.shared-db.yml), POWDER_HARDEN=false
 *  (docker-compose.unharden.yml) and POWDER_WEB_READONLY=true
 *  (docker-compose.web-readonly.yml), all next to configFile. A server that asks for the
 *  private layout but still runs the shared-network layout is refused: the cutover recreates the DB
 *  and needs bin/self-deploy.sh --db-network-cutover. Pure. */
export function selfComposeFileArgs(
	configFile: string,
	layout: SelfDbLayout,
	env: Record<string, string | undefined> = process.env,
): { args: string; note: string; overlays: string[] } | { refuse: string } {
	const dbNet = (env.POWDER_DB_NETWORK ?? '').trim()
	const harden = (env.POWDER_HARDEN ?? '').trim()
	const webRo = (env.POWDER_WEB_READONLY ?? '').trim()
	if (!['', 'shared', 'private'].includes(dbNet))
		return { refuse: `POWDER_DB_NETWORK must be 'private', 'shared' or unset (got: ${dbNet.slice(0, 40)})` }
	if (!['', 'true', 'false'].includes(harden)) return { refuse: 'POWDER_HARDEN must be true or false' }
	if (!['', 'true', 'false'].includes(webRo)) return { refuse: 'POWDER_WEB_READONLY must be true or false' }
	if (dbNet === 'private' && layout === 'legacy')
		return {
			refuse:
				"POWDER_DB_NETWORK=private but this server still runs powder's DB as 'postgres' (shared-network layout). The cutover recreates the DB: run bin/self-deploy.sh --db-network-cutover from a workstation (docs/SELF-HOSTING.md \"DB network cutover\").",
		}
	const shared = dbNet === 'shared' || (dbNet === '' && layout === 'legacy')
	const dir = configFile.includes('/') ? configFile.slice(0, configFile.lastIndexOf('/')) : '.'
	const files = [configFile]
	const overlays: string[] = []
	if (shared) overlays.push(`${dir}/docker-compose.shared-db.yml`)
	if (harden === 'false') overlays.push(`${dir}/docker-compose.unharden.yml`)
	if (webRo === 'true') overlays.push(`${dir}/docker-compose.web-readonly.yml`)
	files.push(...overlays)
	const note = shared
		? "WARNING: powder's DB runs in the shared-network layout (container 'postgres' on the shared 'internal' network). Move it: docs/SELF-HOSTING.md \"DB network cutover\"."
		: ''
	return { args: files.map((f) => `-f ${shq(f)}`).join(' '), note, overlays }
}

/** before the recreate, run the config check (src/check-config.ts) in the
 *  NEW worker image with powder.env, so a weak BETTER_AUTH_SECRET or
 *  POWDER_ENCRYPTION_KEY stops the deploy while the old containers still serve,
 *  instead of recreating into a crash loop. Only a config finding (CONFIG_BAD_MARKER)
 *  refuses; a probe that could not run is a warning. No worker service: skipped.
 *  Ends with `&& ` so it chains. Same check as CONFIG_PREFLIGHT in bin/self-deploy.sh. */
export function selfConfigPreflightShell(F: string, workerSvc: string): string {
	const w = shq(workerSvc)
	return (
		`step "config preflight" && ` +
		`if docker compose ${F} config --services 2>/dev/null | grep -qx ${w}; then ` +
		`  CFG_OUT=$(docker compose ${F} run --rm --no-deps -T --entrypoint pnpm ${w} -F @powder/web exec tsx src/check-config.ts 2>&1) || true; ` +
		`  if printf '%s' "$CFG_OUT" | grep -q ${shq(CONFIG_BAD_MARKER)}; then printf '%s\\n' "$CFG_OUT" | grep -v '^$'; echo "self-deploy: refusing to recreate, fix powder.env first (the running powder keeps serving)"; exit 1; ` +
		`  elif printf '%s' "$CFG_OUT" | grep -q '\\[config-check\\]'; then echo "[config-check] ok"; ` +
		`  else echo "[config-check] WARN could not run the config check in the new image, continuing: $(printf '%s' "$CFG_OUT" | tail -2 | tr '\\n' ' ')"; fi; ` +
		`else echo "[config-check] no ${workerSvc} service, skipped"; fi && `
	)
}

// Self-deploy: pull + build + tag synchronously (these don't kill us); then
// fire `up -d --force-recreate` detached via setsid so it survives the SSH
// session ending when our own container restarts.
export async function runSelfDeploy(
	server: ServerConfig,
	workingDir: string,
	configFile: string,
	service: string,
	tagSuffix: string,
	onChunk?: (chunk: string) => void,
	/** deployId names the uploaded script; budgetSec bounds it (outer `timeout -k` + SSH wall, like every deploy script). */
	opts: { deployId?: string; budgetSec?: number } = {},
): Promise<{
	output: string
	sha: string | null
	branch: string | null
	pulledGit: boolean
	imageBase: string | null
	image: string | null
	imageTag: string | null
}> {
	// The web service and the deploy worker are two services of one compose file
	// (two Dockerfile targets): both must be rebuilt and recreated, or every
	// deploy keeps running the OLD worker code.
	const workerSvc = /^[A-Za-z0-9_.-]+$/.test(process.env.POWDER_SELF_WORKER_SERVICE ?? '')
		? (process.env.POWDER_SELF_WORKER_SERVICE as string)
		: 'worker'
	// Same compose files as bin/self-deploy.sh (DB layout, hardening opt-out, read-only web).
	const layout = await detectSelfDbLayout(server)
	const files = selfComposeFileArgs(configFile, layout)
	if ('refuse' in files) {
		throw new DeployStepError(`self-deploy: refusing, ${files.refuse}\n__POWDER_FAIL__ step=preflight code=1`)
	}
	if (files.note) onChunk?.(`[self-deploy] ${files.note}\n`)
	const F = files.args
	const hasWorkerShell = (_cfg: string) =>
		`docker compose ${F} config --services 2>/dev/null | grep -qx ${shq(workerSvc)}`
	const prepCmd =
		`set -e; ` +
		// Same self-reporting trap as rebuildDeploy (see note there). Additive:
		// step() emits the identical banner, the EXIT trap only appends a marker
		// on non-zero exit. Parsed by lib/deploy-failure.ts.
		`LAST_STEP=start; ` +
		`step() { LAST_STEP="$1"; echo "── $1 ──"; }; ` +
		`trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "__POWDER_FAIL__ step=$LAST_STEP code=$rc"; fi' EXIT; ` +
		// the overlay files come only from powder's own dir and must be regular
		// files there (not links, not missing): compose would otherwise read whatever a
		// link names, or recreate powder's DB in another layout.
		files.overlays
			.map((f) => `if [ ! -f ${shq(f)} ] || [ -L ${shq(f)} ]; then echo ${shq(`self-deploy: refusing, ${f} is missing, a link or not a regular file`)}; exit 1; fi; `)
			.join('') +
		// Retry wrapper for network-bound steps (git fetch, registry pull/push).
		// These flap on transient blips - DNS hiccup, registry 5xx, momentary
		// packet loss - and a single miss must not hard-fail the whole deploy.
		// 3 attempts, linear backoff (5s, 10s). Deterministic failures (auth,
		// not-found) still fail after the retries; the summarizer names them.
		// __-prefixed locals so we don't clobber LAST_STEP etc.
		// every git call below goes through powder_git (lib/git-harden.ts).
		gitHardenShellFunctions() +
		`retry() { __n=0; __max=3; until "$@"; do __rc=$?; __n=$((__n+1)); if [ "$__n" -ge "$__max" ]; then return $__rc; fi; echo "[retry] '$LAST_STEP' failed (rc=$__rc) - attempt $__n/$__max, retrying in $((__n*5))s"; sleep $((__n*5)); done; }; ` +
		// Same per-app deploy lock as buildDeployScript: a self-deploy must not overlap a
		// rollback / apply of the same service. Held until this script exits.
		appLockShell(appLockPath(workingDir, service)) +
		`{ cd ${shq(workingDir)} || { echo "preflight: cannot cd to the app directory "${shq(workingDir)}; exit 1; }; } && ` +
		`KEY=${shq(workingDir)}/.deploy-key; ` +
		`if [ -f "$KEY" ]; then ` +
		`  ${GITHUB_KNOWN_HOSTS_SETUP}export GIT_SSH_COMMAND="ssh -i $KEY ${GIT_SSH_HOSTKEY_OPTS} -o IdentitiesOnly=yes"; ` +
		`fi; ` +
		// Preflight: catch the conditions that doom a deploy BEFORE we touch the
		// running container (build/pull/recreate). Each check fails fast with a
		// message the summarizer recognizes ("no space left on device",
		// "Permission denied (publickey)"), so a red dot reads as the real cause
		// instead of a confusing mid-build error.
		`step "preflight" && ` +
		`if ! docker info >/dev/null 2>&1; then echo "preflight: docker daemon not responding on this server"; exit 1; fi && ` +
		`if [ -f "$KEY" ] && [ ! -L "$KEY" ]; then chmod 600 "$KEY" 2>/dev/null || true; fi && ` +
		`AVAIL_KB=$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}') && ` +
		// Disk getting tight (<10GB free)? Reclaim build cache + dangling images
		// BEFORE the build so a deploy can't fill the disk and crash the server
		// mid-build (the recurring "85% disk" class). Keeps rollback tags (image
		// prune without -a); build cache is regenerable. Only a hard 2GB floor
		// after reclaim aborts - the old 200MB threshold let a build start with a
		// couple GB free and then run the disk to 100%.
		`if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 10485760 ]; then echo "[preflight] only $((AVAIL_KB/1024))MB free - reclaiming build cache before build"; ${lockedPruneShell({ label: '[preflight]', lockWaitSec: 60, busyWaitSec: 60, restOnLockTimeout: true, imagePrune: 'docker image prune -f >/dev/null 2>&1', rest: ['docker builder prune -af >/dev/null 2>&1'] })}; AVAIL_KB=$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}'); fi && ` +
		`if [ -n "$AVAIL_KB" ]; then echo "[preflight] disk free: $((AVAIL_KB/1024))MB"; fi && ` +
		`if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 2097152 ]; then echo "preflight: only $((AVAIL_KB/1024))MB free after reclaim - no space left on device for this deploy"; exit 1; fi && ` +
		// The compose file must PARSE before anything else touches it. A broken
		// file otherwise surfaces far later as a silent registry-mode fallback:
		// the HAS_BUILD check reads `docker compose config`'s empty output as
		// "no build: key" and pulls instead of building (a
		// networks-block hand-edit then fails every deploy with a
		// misleading "compose pull" error). Fail here, naming the YAML error.
		`if ! CP_ERR=$(docker compose -f ${shq(configFile)} config 2>&1 >/dev/null); then echo "preflight: compose file is INVALID - $(printf '%s' "$CP_ERR" | head -c 500)"; exit 1; fi && ` +
		// Every container labelled into this compose project must be declared in
		// the file. An undeclared one is an orphan that the up-retry's
		// `down --remove-orphans` would DELETE, and that orphan can be the
		// app's own postgres container.
		`CP_PROJ=$(docker compose -f ${shq(configFile)} config 2>/dev/null | awk '/^name:/{print $2; exit}') && ` +
		`{ CP_DECLARED=$(docker compose -f ${shq(configFile)} config --services 2>/dev/null) || { echo "preflight: cannot list the compose services (docker compose config --services failed), so the orphan-container guard cannot run"; exit 1; }; } && ` +
		`if [ -n "$CP_PROJ" ]; then ` +
		// NOTE: docker ps --format exposes .Labels as a comma-joined STRING (unlike
		// docker inspect, where Labels is a map) - `{{index .Labels "…"}}` errors
		// with "cannot index slice/array with type string" on EVERY invocation, so
		// this guard would silently never run.
		// `{{.Label "…"}}` is the ps-format accessor for a single label.
		`  for CP_SVC in $(docker ps -a --filter "label=com.docker.compose.project=$CP_PROJ" --format '{{.Label "com.docker.compose.service"}}' | sort -u); do ` +
		`    if ! printf '%s\n' "$CP_DECLARED" | grep -qxF -- "$CP_SVC"; then echo "preflight: container service '$CP_SVC' is labelled into compose project '$CP_PROJ' but NOT declared in the compose file - an orphan that a deploy retry (down --remove-orphans) would DELETE. Re-declare the service or remove the container."; exit 1; fi; ` +
		`  done; ` +
		`fi && ` +
		// Git auth guard - ASK the remote instead of guessing from the key file.
		//
		// Two reasons this is a probe and not a `[ -f "$KEY" ]` test:
		//  1. The file test was `.git`-gated, so it never ran for a standard
		//     (src/) layout app: a deleted key gave deploys that printed
		//     "Permission denied (publickey)" and still reported success.
		//  2. A missing .deploy-key does NOT mean auth is broken. Some apps
		//     authenticate through ssh-config Host aliases
		//     (github.com-<alias> -> a key under /root/.ssh), and
		//     other apps use https remotes. Failing those on a
		//     missing file would have broken working apps.
		// ls-remote exercises exactly the credentials the fetch will use (KEY is
		// already exported above when present), so it also catches a revoked key
		// or token - which no file check ever could.
		`PF_GITDIR=""; if [ -d src/.git ]; then PF_GITDIR=src; elif [ -d .git ]; then PF_GITDIR=.; fi && ` +
		`if [ -n "$PF_GITDIR" ]; then ` +
		`  PF_REMOTE=$(${gitCmd(shq('*'), '"$PF_GITDIR"')} remote get-url origin 2>/dev/null || echo "") && ` +
		`  if [ -n "$PF_REMOTE" ]; then ` +
		`    step "preflight git auth" && ` +
		`    if ! PF_LS=$(${gitCmd(shq('*'), '"$PF_GITDIR"')} ls-remote --heads origin 2>&1); then ` +
		`      echo "preflight: cannot read the git remote - the deploy would build whatever is already on disk instead of your push. remote=$(printf '%s' "$PF_REMOTE" | sed -E 's#://[^@/]*@#://***@#') :: $(printf '%s' "$PF_LS" | tail -2 | tr '\n' ' ')"; ` +
		`      echo "preflight: check the deploy key at $KEY, the ssh-config Host alias, or the token in the remote URL."; ` +
		`      exit 1; ` +
		`    fi; ` +
		`  fi; ` +
		`fi && ` +
		// UNIFORMITY ENFORCEMENT: prefer the standard src/ checkout and FORCE it to
		// match GitHub (fetch + hard-reset + clean) rather than `git pull --ff-only`,
		// which ABORTS on any local drift (the "local changes would be
		// overwritten" failure). Preferring src/.git also sidesteps a stray root .git
		// from older layouts. The runtime docker-compose.yml lives in the working dir
		// (outside src/), so a hard reset of src/ never touches it; .deploy-key is
		// preserved by the clean. Workdir-layout repos take the plain pull path below.
		`if [ -d src/.git ]; then ` +
		`  SYNC_OK=no; ` +
		`  step "git sync (force src/ to GitHub)" && cd src && ` +
		`  BR=$(${gitCmd(shq('*'))} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'); ` +
		`  if [ -z "$BR" ]; then ${gitCmd(shq('*'))} remote set-head origin -a >/dev/null 2>&1 || true; BR=$(${gitCmd(shq('*'))} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'); fi; ` +
		`  if [ -z "$BR" ]; then if ${gitCmd(shq('*'))} show-ref --verify --quiet refs/remotes/origin/main; then BR=main; elif ${gitCmd(shq('*'))} show-ref --verify --quiet refs/remotes/origin/master; then BR=master; else BR=main; fi; fi && ` +
		`  retry ${gitCmd(shq('*'))} fetch origin 2>&1 && ` +
		// origin/$BR resolved to its sha once, for the link check and the checkout.
		`  SD_TGT=$(${gitCmd(shq('*'))} rev-parse -q --verify "origin/$BR^{commit}") && ` +
		// no absolute / escaping / .git link reaches the work tree.
		`  ${targetLinkGuardShell({ dir: `${workingDir}/src`, target: '"$SD_TGT"', binds: false, who: 'self-deploy' })} && ` +
		`  ${gitCmd(shq('*'))} checkout -f -B "$BR" "$SD_TGT" 2>&1 && ` +
		`  ${gitCmd(shq('*'))} reset --hard "$SD_TGT" 2>&1 && ` +
		`  (${gitCmd(shq('*'))} branch --set-upstream-to="origin/$BR" "$BR" >/dev/null 2>&1 || true) && ` +
		`  ${gitCmd(shq('*'))} clean -fdx -e .deploy-key 2>&1 && ` +
		`  echo "[sync] src/ now at origin/$BR" && ${gitCmd(shq('*'))} rev-parse HEAD && ${gitCmd(shq('*'))} rev-parse --abbrev-ref HEAD && ` +
		// A failed sync must FAIL THE DEPLOY. Without this the `&&` chain simply
		// stops, `cd` back never happens, and the block's exit status is taken
		// from whatever runs next - the compose-drift `if` below, which returns 0
		// when its condition is false: a "deploy success" row whose log
		// says "Permission denied (publickey)", building whatever happened to be
		// on disk, with git_sha NULL as the only tell. The skipped `cd` also left
		// the shell inside src/, which silently
		// disabled the wrongctx guard below (it tests the relative path src/.git).
		`  cd ${shq(workingDir)} && SYNC_OK=yes; ` +
		`  if [ "$SYNC_OK" != "yes" ]; then echo "deploy: git sync of src/ FAILED - refusing to build, because the source on disk is NOT what GitHub has (a build here ships whatever was left in the working directory). Fix the deploy key at "${shq(`${workingDir}/.deploy-key`)}" or the repo remote, then redeploy."; exit 1; fi; ` +
		`elif [ -d .git ]; then ` +
		// WORKDIR layout (no src/: the app dir is the checkout). Force the SOURCE to match GitHub
		// (fetch + hard-reset) instead of `git pull --ff-only`, which ABORTS on any
		// local drift - the common root cause of "deploy failed: git pull failed"
		// (server-side working trees drift). Two workdir-only
		// guards make the hard reset safe here:
		//   1. The runtime docker-compose.yml is TRACKED in this layout, so a hard
		//      reset would revert server-local compose edits (e.g. a `build:` block).
		//      Preserve it across the reset.
		//   2. We do NOT run `git clean`: untracked runtime data (uploads/, etc.)
		//      lives in the workdir for these apps and must never be deleted.
		// Branch resolution mirrors the src/ path (origin/HEAD → main → master).
		`  step "git sync (force workdir to GitHub, preserve runtime compose)" && ` +
		`  BR=$(${gitCmd(shq(workingDir))} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'); ` +
		`  if [ -z "$BR" ]; then ${gitCmd(shq(workingDir))} remote set-head origin -a >/dev/null 2>&1 || true; BR=$(${gitCmd(shq(workingDir))} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'); fi; ` +
		`  if [ -z "$BR" ]; then if ${gitCmd(shq(workingDir))} show-ref --verify --quiet refs/remotes/origin/main; then BR=main; elif ${gitCmd(shq(workingDir))} show-ref --verify --quiet refs/remotes/origin/master; then BR=master; else BR=main; fi; fi && ` +
		workdirSyncShell(
			workingDir,
			`  retry ${gitCmd(shq(workingDir))} fetch origin 2>&1 && ` +
				// origin/$BR resolved to its sha once, for the link check and the checkout.
				`  SD_TGT=$(${gitCmd(shq(workingDir))} rev-parse -q --verify "origin/$BR^{commit}") && ` +
				`  ${targetLinkGuardShell({ dir: workingDir, target: '"$SD_TGT"', binds: false, who: 'self-deploy' })} && ` +
				`  ${gitCmd(shq(workingDir))} checkout -f -B "$BR" "$SD_TGT" 2>&1 && ` +
				`  ${gitCmd(shq(workingDir))} reset --hard "$SD_TGT" 2>&1 && ` +
				`  (${gitCmd(shq(workingDir))} branch --set-upstream-to="origin/$BR" "$BR" >/dev/null 2>&1 || true) && `,
		) +
		`  step "git rev-parse" && ` +
		`  ${gitCmd(shq(workingDir))} rev-parse HEAD && ` +
		`  ${gitCmd(shq(workingDir))} rev-parse --abbrev-ref HEAD; ` +
		`else ` +
		`  step "no git repo, skipping pull"; ` +
		`fi && ` +
		`step "docker compose build" && ` +
		// host build-lock (see rebuildDeploy) - never two concurrent builds per server
		`SELF_TARGETS=${shq(service)}; if ${hasWorkerShell(configFile)} && [ ${shq(workerSvc)} != ${shq(service)} ]; then SELF_TARGETS="$SELF_TARGETS "${shq(workerSvc)}; fi; ` +
		`export POWDER_BUILD_CACHE_ID="$(${BUILD_CACHE_ID_SH})"; case "$POWDER_BUILD_CACHE_ID" in *[!0-9a-f]*) POWDER_BUILD_CACHE_ID= ;; esac; ` +
		`flock -w 2400 ${buildLockShell()} docker compose ${F} build $SELF_TARGETS 2>&1 && ` +
		`step "resolve image" && ` +
		`IMG=$(docker compose ${F} config --images ${shq(service)} 2>/dev/null | head -1) && ` +
		`echo "image: $IMG" && ` +
		(tagSuffix
			? `if [ -n "$IMG" ]; then ` +
				`  BASE=\${IMG%:*} && ` +
				`  docker tag "$IMG" "$BASE:${tagSuffix}" 2>&1 && ` +
				`  echo "tagged: $BASE:${tagSuffix}"; ` +
				`else ` +
				`  echo "(skipped tagging: no image)"; ` +
				`fi && `
			: ``) +
		selfConfigPreflightShell(F, workerSvc) +
		`step "ready, recreate will run detached"`
	// Same envelope as every deploy script: SFTP upload, `timeout -k` at the budget, SSH wall above it.
	const prep = await runDeployScript(server, prepCmd, opts.deployId, onChunk, opts.budgetSec)
	if (prep.code !== 0) {
		throw new DeployStepError(
			[prep.stdout, prep.stderr].filter(Boolean).join('\n') || 'self-deploy build failed',
		)
	}

	const selfLogTag = tagSuffix || `t${Date.now()}`
	const selfLogName = `powder-self-deploy-${selfLogTag}.log`
	// The log goes to a 0700 dir of the ssh user, never a shared /tmp path another
	// local user could read or plant a link at: SELF_LOG_DIR as root, else under HOME.
	// `( setsid ... < /dev/null > log 2>&1 & )` - subshell + background lets sh
	// return immediately; setsid creates a new session so SIGHUP from the dying
	// ssh parent doesn't reach the recreate.
	const recreateCmd =
		`if [ "$(id -u 2>/dev/null)" = 0 ]; then __sld=${SELF_LOG_DIR}; else __sld="$HOME/.powder-logs"; fi; ` +
		`if [ -L "$__sld" ] || ! install -d -m 0700 "$__sld" || [ -L "$__sld/"${shq(selfLogName)} ]; then echo "cannot use $__sld for the self-deploy log (a symlink, or not creatable)" >&2; exit 1; fi; ` +
		`__sl="$__sld/"${shq(selfLogName)}; ` +
		`( setsid sh -c ` +
		shq(
			`T=${shq(service)}; if ${hasWorkerShell(configFile)} && [ ${shq(workerSvc)} != ${shq(service)} ]; then T="$T "${shq(workerSvc)}; fi; ` +
				`docker compose ${F} up -d --force-recreate --no-deps $T; ` +
				`echo "exit: $?" >> "$1"`,
		) +
		` _ "$__sl" < /dev/null > "$__sl" 2>&1 & ) ; ` +
		`echo "detached recreate → $__sl"`
	const fire = await runCommand(server, recreateCmd, 10_000, onChunk)
	if (fire.code !== 0)
		throw new Error(fire.stderr || fire.stdout || 'failed to fire detached recreate')
	const selfLog = fire.stdout.match(/detached recreate → (\S+)/)?.[1] ?? `${SELF_LOG_DIR}/${selfLogName}`

	// Same two banner shapes as rebuildDeploy above (workdir + src/-layout).
	const match =
		prep.stdout.match(/── git rev-parse ──\s*\n([0-9a-f]{7,40})\s*\n(\S+)\s*\n/) ??
		prep.stdout.match(/\[sync\] src\/ now at origin\/\S+\s*\n([0-9a-f]{7,40})\s*\n(\S+)\s*\n/)
	const sha = match?.[1] ?? null
	const branch = match?.[2] ?? null
	const pulledGit = prep.stdout.includes('── git pull ──')
	const selfImage = parseDeployedImage(prep.stdout)
	const imageBase = selfImage ? (selfImage.split(':')[0] ?? '') : null
	const imageTag = tagSuffix && imageBase ? `${imageBase}:${tagSuffix}` : null
	const output = `${prep.stdout}\n── self-deploy: recreate detached, host log → ${selfLog} ──\n`

	return { output, sha, branch, pulledGit, imageBase, image: selfImage, imageTag }
}
