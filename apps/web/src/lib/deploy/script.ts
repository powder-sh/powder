import { gitCmd, gitHardenShellFunctions } from '../git-harden'
import { DEPLOY_BUDGET_SEC } from '../deploy-budget'
import { appLockDirShell, appLockPath, supersedeCheckShell, swapGateShell, swapPrevPath, swapStampPath } from '../deploy-supersede'
import { SERVICE_FIELD_AWK, bridgeShellFunctions, fontFetchRetryShellFunctions, onServerComposeGuardShell, childTimeoutPrefix, composeProjectStableShell, projectChangedMarkerFor, imageLabelGuardShell, infraCountShell, infraMountGuardShell, serviceImageLabelGuardShell, testGateShell, testGateStopShell, swapCheckShellFunctions, trackedDotenvGuardShell } from './fragments'
import type { SwapCheckPlan } from './fragments'
import { lockedPruneShell } from './prune-lock'
import { shq } from '../shell'
import { buildLockShell } from '../build-lock'
import { ALL_PROFILES, composeHashGuardShell } from './compose-hash'
import { cacheAppSlug, composeDockerfileRewriteShell, dockerfileAuthorityShell, dockerfileRewriteFunctions } from '../build-cache'
import type { DockerfileImageAuthority } from '../compose-safety'
import { protectExistingIgnoreShell, writeDockerignoreShell } from '../app-runtime-files'
import { OVERRIDE_FILE, deployOverrideDirFor, isPowderTempComposeFile } from '../compose-override'
import { targetLinkGuardShell, targetLinkSourcesShell } from '../target-links'
import { migratePathScanShell, stabilityMarkShell, testGatePresenceShell } from './stability'

/** Shell: print the nonce-tagged sha marker (no-op without a nonce). */
function shaMarkerShell(safeDir: string, nonce: string): string {
	return nonce
		? `  echo "__POWDER_SHA_${nonce}__ $(${gitCmd(safeDir)} rev-parse HEAD) $(${gitCmd(safeDir)} rev-parse --abbrev-ref HEAD)" && `
		: ''
}
import { GITHUB_KNOWN_HOSTS_SETUP, GIT_SSH_HOSTKEY_OPTS, gitResolveTarget, repoSymlinkGuardShell, workdirSyncShell } from '../ssh/git'

/** The remote deploy script for one app - pure (no I/O), so it can be
 *  snapshot-tested and `bash -n` syntax-checked. rebuildDeploy runs it. */
export function buildDeployScript(p: {
	workingDir: string
	configFile: string
	service: string
	cf: string
	declaredMode: string
	prebuilt: boolean
	migrateApp?: string
	infra: string[] | null
	wantBranch: string | null
	wantSha: string | null
	shaIsStrict: boolean
	/** Last successfully deployed commit (DB git_sha): ancestry base when the server has no HEAD. */
	baseSha?: string | null
	/** Monotonic ordering token for this deploy (the deploy row's claim time, ms).
	 *  When set, the script takes the per-app lock for its whole run, refuses to
	 *  build/swap if a NEWER deploy already swapped (stamp file), and builds to a
	 *  unique `:build-<id>` tag that is only retagged to the shared `image:` tag
	 *  at the swap gate. Unset = unordered (tests, tools). */
	swapOrdinal?: number
	/** Test seam: where swap stamps live (default /var/lib/powder/swap). */
	swapStampDir?: string
	/** Unique id for the staged image tag + override file (the deploy id). */
	stageId?: string
	/** Prebuilt (dedicated-builder) mode: the unique tag the builder streamed the
	 *  image to on this server. */
	stageImage?: string | null
	/** Pre-swap candidate probe (see swapCheckShellFunctions). Unset = no step
	 *  at all (tests, tools); `{ skip }` = one "swap-check: skipped" log line. */
	swapCheck?: SwapCheckPlan
	/** Seconds this script may run (its single DEADLINE): what is LEFT of the
	 *  deploy budget after the builder phase. Default: the full budget. */
	budgetSec?: number
	/** Previews only: skip the powder-migrate step and the release command. Default false. */
	skipMigrate?: boolean
	/** sha256 of the compose config the safety check approved (compose-check.ts).
	 *  Set = the script refuses when the config differs after the git sync and
	 *  before `compose up`. */
	composeHash?: string
	/** false = warn mode: a moved hash prints a WARN line instead of refusing. */
	composeGuardEnforce?: boolean
	/** warn mode only: a moved hash stops the script with the
	 *  re-check marker (powder re-checks the new config with the high-severity
	 *  rules enforced, then runs once more without this flag). */
	composeGuardRecheck?: boolean
	/** The hash tripwire refuses on a moved hash even in warn mode (the run after a
	 *  re-check: the config it pins is the one the re-check approved). */
	composeHashEnforce?: boolean
	/** `docker compose build --pull` (buildPullEnabled: on unless POWDER_BUILD_PULL=0). Off when unset here. */
	buildPull?: boolean
	/** Test-gate memory cap override (POWDER_TESTGATE_MEM, validated). */
	testGateMem?: string | null
	/** Random per-run token: the synced commit is reported as `__POWDER_SHA_<nonce>__ <sha> <branch>`,
	 *  so build/test output cannot forge the recorded git sha. */
	shaNonce?: string
	/** Every compose file (-f) of the app; the workdir-layout sync preserves those under the workdir. */
	composeFiles?: string[]
	/** BuildKit cache namespace of this app (build-cache.ts, from its powder_meta salt).
	 *  Unset = a random one made on the server (isolated, cold cache). */
	cacheNamespace?: string | null
	/** the compose guard's image authority for the Dockerfile image check. */
	dockerfileAuthority?: DockerfileImageAuthority | null
}): string {
	const budget = Math.max(1, Math.floor(p.budgetSec ?? DEPLOY_BUDGET_SEC))
	const { workingDir, configFile, service, cf, declaredMode, prebuilt, infra, wantBranch, wantSha, shaIsStrict } = p
	const swapOn = p.swapCheck && !('skip' in p.swapCheck) ? p.swapCheck : null
	const ord = p.swapOrdinal && p.swapOrdinal > 0 ? Math.floor(p.swapOrdinal) : null
	const stageId = (p.stageId ?? `t${Date.now()}`).replace(/^dep_/, '').replace(/[^A-Za-z0-9_.-]/g, '')
	const stampFile = swapStampPath(workingDir, service, p.migrateApp, p.swapStampDir)
	const prevFile = swapPrevPath(stampFile)
	const opts = { migrateApp: p.migrateApp }
	const shaNonce = (p.shaNonce ?? '').replace(/[^A-Za-z0-9]/g, '')
	const app = p.migrateApp ?? service
	const ns = (p.cacheNamespace ?? '').replace(/[^0-9a-f]/g, '')
	// Compose args for every command that may BUILD an image (build, up, run): powder's
	// rewritten-Dockerfile override and the pulled-sibling pin ride along.
	// The compose guard hash and `config` reads keep using cf alone.
	const cfb = `${cf} $DFR_F $LB_F`
	// refuse include / extends, and an env_file / label_file that a symlink
	// could point outside the app or that sits in a writable bind (hard, every guard
	// mode). Defined once as el_guard; runs before the first `compose config` of the
	// script, again before anything starts a container from the compose (swap gate
	// onwards: bridge, release, swap-check), and immediately before EVERY
	// `compose up` attempt, retries included: a container can change the files between
	// two attempts. el_guard exits the (sub)shell on a refusal.
	// the app's -f files (the user's, in order), for the target-commit link check.
	const tlFiles = (p.composeFiles && p.composeFiles.length > 0 ? p.composeFiles : [configFile]).filter(
		(f) => f.split('/').pop() !== OVERRIDE_FILE && !isPowderTempComposeFile(f),
	)
	const envLinkGuard = (where: string | null) =>
		`${where ? `step ${shq(`env file links (${where})`)} && ` : ''}el_guard && `
	// If a deploy key exists at /opt/apps/<workingDir-basename>/.deploy-key, use it for git pulls.
	return (
		`set -e; ` +
		// Self-reporting failure trap. step() records the current phase in
		// LAST_STEP and prints the section banner; the EXIT trap fires on any
		// non-zero exit and emits a machine-parseable trailer naming the phase +
		// code. Without it, a step that dies with no stderr of its own (e.g. a
		// compose recreate that short-circuits the && chain) left the log ending
		// at the bare "── docker compose up ──" banner with no clue why. Parsed
		// by lib/deploy-failure.ts. ($LAST_STEP / $rc are shell vars expanded at
		// trap time - kept brace-less so the JS template literal doesn't eat them.)
		`LAST_STEP=start; ` +
		`step() { LAST_STEP="$1"; echo "── $1 ──"; }; ` +
		// and the build path pins of the Dockerfile check still hold (a no-op
		// before that check has run).
		`el_guard() { ${onServerComposeGuardShell(cf, app, workingDir)}; dfr_pinchk || exit 1; }; ` +
		// Release-phase cleanup helper (see releasePhaseShell); also run from the EXIT trap.
		// Restore the shared image tag to the previously running image (REL_PREV) after a
		// failed/aborted release: the swap gate already retagged it to the NEW image, and a
		// later plain recreate would otherwise boot new code on the old schema. If this
		// deploy changed the compose image: ref, IMGREF/REL_IMG is the NEW ref name; the old
		// ref's tag is untouched, so only the new name is pointed back at the old image.
		`release_restore() { if [ -n "$REL_PREV" ] && [ -n "\${IMGREF:-$REL_IMG}" ]; then docker image tag "$REL_PREV" "\${IMGREF:-$REL_IMG}" >/dev/null 2>&1 && echo "[release] shared tag restored to the previously running image"; fi; return 0; }; ` +
		`tg_stop() { ${testGateStopShell(`${workingDir}|${service}`)}; return 0; }; ` +
		`release_stop() { docker ps -aq --filter ${shq('label=powder.release=' + workingDir + '|' + service)} 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true; return 0; }; ` +
		`STAGE_IMG=${shq(prebuilt ? (p.stageImage ?? '') : '')}; STAGE_F=""; CG_RECHECK=0; DFR_DIR=""; DFR_F=""; LB_F=""; ` +
		// SWAPPED=1 once compose up has succeeded. Any non-zero exit BEFORE that
		// (swap-check, migrate, release, deadline) restores the shared image tag the
		// swap gate already pointed at the rejected build.
		`SWAPPED=0; PREVF=${shq(ord ? prevFile : '')}; ` +
		// Always drop the staged build tag + override file on exit. After a swap the
		// shared tag already points at the same image, so this only untags.
		`trap 'rc=$?; bridge_stop; ${swapOn ? 'swap_stop; ' : ''}release_stop; if [ "$rc" -ne 0 ] && [ "$SWAPPED" != 1 ]; then release_restore; fi; if [ -n "$STAGE_IMG" ] && [ "$CG_RECHECK" != 1 ]; then docker rmi "$STAGE_IMG" >/dev/null 2>&1 || true; fi; if [ -n "$STAGE_F" ]; then rm -f "\${STAGE_F#-f }"; fi; if [ -n "$DFR_DIR" ] && [ "$DFR_DIR" != "\${DFR_FINAL:-}" ]; then rm -rf "$DFR_DIR"; fi; if [ -n "$PREVF" ]; then rm -f "$PREVF"; fi; rm -f "\${__ffo:-}"; tg_stop; if [ "$rc" -ne 0 ]; then echo "__POWDER_FAIL__ step=$LAST_STEP code=$rc"; fi' EXIT; ` +
		// ONE deadline for the whole script (the outer `timeout` in
		// runDeployScript enforces it; see DEPLOY_BUDGET_SEC). Every wait inside
		// - lock waits, the build, the test gate - draws from what is LEFT of it
		// instead of carrying its own fixed ceiling, so the phases cannot
		// add up to more than the SSH wall and the watchdog.
		//   left <reserve>      seconds remaining minus a reserve for later steps (>= 1)
		//   cap <max> <reserve> min(max, left reserve)
		`DEADLINE=$(( $(date +%s) + ${budget} )); ` +
		`left() { __l=$(( DEADLINE - $(date +%s) - $1 )); [ "$__l" -lt 1 ] && __l=1; echo "$__l"; }; ` +
		`cap() { __c=$(left "$2"); [ "$__c" -gt "$1" ] && __c=$1; echo "$__c"; }; ` +
		`trap 'echo "[deadline] deploy exceeded its ${budget}s budget during: $LAST_STEP - killed"; exit 124' TERM; ` +
		// Retry wrapper for network-bound steps (git fetch, registry pull/push).
		// These flap on transient blips - DNS hiccup, registry 5xx, momentary
		// packet loss - and a single miss must not hard-fail the whole deploy.
		// 3 attempts, linear backoff (5s, 10s). Deterministic failures (auth,
		// not-found) still fail after the retries; the summarizer names them.
		// __-prefixed locals so we don't clobber LAST_STEP etc.
		// every git call below goes through powder_git (lib/git-harden.ts).
		gitHardenShellFunctions() +
		`retry() { __n=0; __max=3; until "$@"; do __rc=$?; __n=$((__n+1)); if [ "$__n" -ge "$__max" ]; then return $__rc; fi; echo "[retry] '$LAST_STEP' failed (rc=$__rc) - attempt $__n/$__max, retrying in $((__n*5))s"; sleep $((__n*5)); done; }; ` +
		// One retry of the local build when it failed on a next/font Google Fonts fetch
		// (transient: the same commit builds on retry). Only with 300s+ of build time
		// left after the build's reserve, and the guards re-run first.
		fontFetchRetryShellFunctions(`[ "$(left 240)" -ge 300 ]`, 'el_guard') +
		// Zero-downtime bridge helpers (see bridgeShellFunctions). bridge_stop is
		// also called from the EXIT trap above, so every exit path removes the bridge.
		bridgeShellFunctions(cf, service, workingDir, shaNonce) +
		(swapOn ? swapCheckShellFunctions(cfb, service, workingDir, p.migrateApp ?? service, swapOn) : '') +
		dockerfileRewriteFunctions(app) +
		// PER-APP DEPLOY LOCK (build + swap), held until the script exits. Two
		// deploys of one app can overlap on this server even though the DB allows one
		// running row (a reaped row or a restarted worker leaves the old script
		// alive); without this, build finish order decided which commit won.
		// Then: a deploy older than the last swap exits here without building.
		(ord
			? `step "app lock" && { ${appLockDirShell(appLockPath(workingDir, service))}{ [ ! -L ${shq(appLockPath(workingDir, service))} ] || { echo "preflight: the per-app deploy lock path is a symlink, refusing"; exit 1; }; } && exec 9>${shq(appLockPath(workingDir, service))} || { echo "preflight: cannot open the per-app deploy lock"; exit 1; }; } && ` +
				`{ flock -w "$(left 120)" 9 || { echo "preflight: another deploy of this app holds the per-app lock for the whole budget"; exit 1; }; } && ` +
				supersedeCheckShell(stampFile, ord, shaNonce) +
				` && `
			: '') +
		// A `<name>-next` left by a crashed run is removed before anything else (we hold the app lock).
		(swapOn ? `{ SC_ON=1; swap_stop; } && ` : '') +
		`{ cd ${shq(workingDir)} || { echo "preflight: cannot cd to the app directory "${shq(workingDir)}; exit 1; }; } && ` +
		`KEY=${shq(workingDir)}/.deploy-key; ` +
		GITHUB_KNOWN_HOSTS_SETUP +
		`if [ -f "$KEY" ]; then ` +
		`  export GIT_SSH_COMMAND="ssh -i $KEY ${GIT_SSH_HOSTKEY_OPTS} -o IdentitiesOnly=yes"; ` +
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
		// only cache unused for 24h: one app's deploy cannot wipe every app's warm
		// cache (the hourly powder-image-prune cron still caps the cache size, LRU).
		`if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 10485760 ]; then echo "[preflight] only $((AVAIL_KB/1024))MB free - reclaiming build cache unused for 24h before build"; ${lockedPruneShell({ label: '[preflight]', lockWaitSec: 60, busyWaitSec: 60, restOnLockTimeout: true, imagePrune: 'docker image prune -f >/dev/null 2>&1', rest: ['docker builder prune -af --filter unused-for=24h >/dev/null 2>&1'] })}; AVAIL_KB=$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}'); fi && ` +
		`if [ -n "$AVAIL_KB" ]; then echo "[preflight] disk free: $((AVAIL_KB/1024))MB"; fi && ` +
		`if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 2097152 ]; then echo "preflight: only $((AVAIL_KB/1024))MB free after reclaim - no space left on device for this deploy"; exit 1; fi && ` +
		// The compose file must PARSE before anything else touches it. A broken
		// file otherwise surfaces far later as a silent registry-mode fallback:
		// the HAS_BUILD check reads `docker compose config`'s empty output as
		// "no build: key" and pulls instead of building (a
		// networks-block hand-edit then fails every deploy with a
		// misleading "compose pull" error). Fail here, naming the YAML error.
		// the env file guard (with the raw include / extends check) runs BEFORE this
		// first `config`: a resolved config already reads the files an include names, and
		// its error text (printed below) can carry interpolated values.
		envLinkGuard(null) +
		`if ! CP_ERR=$(docker compose ${cf} ${ALL_PROFILES} config 2>&1 >/dev/null); then echo "preflight: compose file is INVALID - $(printf '%s' "$CP_ERR" | head -c 500)"; exit 1; fi && ` +
		// Every container labelled into this compose project must be declared in
		// the file. An undeclared one is an orphan that the up-retry's
		// `down --remove-orphans` would DELETE, and that orphan can be the
		// app's own postgres container.
		`CP_PROJ=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null | awk '/^name:/{print $2; exit}') && ` +
		`{ CP_DECLARED=$(docker compose ${cf} ${ALL_PROFILES} config --services 2>/dev/null) || { echo "preflight: cannot list the compose services (docker compose config --services failed), so the orphan-container guard cannot run"; exit 1; }; } && ` +
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
		`if [ -L src ]; then echo "preflight: refusing, src is a symlink (repo-controlled link; the src/ checkout must be a real directory)"; exit 1; fi && PF_GITDIR=""; if [ -d src/.git ]; then PF_GITDIR=src; elif [ -d .git ]; then PF_GITDIR=.; fi && ` +
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
		// every mount source docker re-resolves when a container restarts (all
		// containers on the server, any state; volume devices; the current config). The
		// target-commit link check below refuses a sync that would turn one into a link.
		`{ if [ -n "$PF_GITDIR" ]; then ${targetLinkSourcesShell(cf)}true; fi; } && ` +
		`if [ -d src/.git ] && [ ! -L src ]; then ` +
		`  SYNC_OK=no; ` +
		`  step "git sync (force src/ to GitHub)" && cd src && ` +
		`  retry ${gitCmd(shq('*'))} fetch origin 2>&1 && ` +
		gitResolveTarget(shq('*'), wantBranch, wantSha, shaIsStrict, p.baseSha ?? null) +
		// BEFORE the checkout touches the work tree.
		`  ${targetLinkGuardShell({ dir: `${workingDir}/src`, target: '"$TARGET"', binds: true, compose: { files: tlFiles } })} && ` +
		`  ${gitCmd(shq('*'))} checkout -f -B "$BR" "$TARGET" 2>&1 && ` +
		`  ${gitCmd(shq('*'))} reset --hard "$TARGET" 2>&1 && ` +
		// A sha-pinned checkout has no upstream; keep origin/<branch> tracking so
		// the dashboard's ahead/behind (getGitStatus → @{u}) still works.
		`  (${gitCmd(shq('*'))} branch --set-upstream-to="origin/$BR" "$BR" >/dev/null 2>&1 || true) && ` +
		`  ${gitCmd(shq('*'))} clean -fdx -e .deploy-key 2>&1 && ` +
		`  echo "[sync] src/ now at origin/$BR" && ${gitCmd(shq('*'))} rev-parse HEAD && ${gitCmd(shq('*'))} rev-parse --abbrev-ref HEAD && ` +
		shaMarkerShell(shq('*'), shaNonce) +
		// A failed sync must FAIL THE DEPLOY. Without this the `&&` chain simply
		// stops, `cd` back never happens, and the block's exit status is taken
		// from whatever runs next - the compose-drift `if` below, which returns 0
		// when its condition is false: a "deploy success" row whose log
		// says "Permission denied (publickey)", building whatever happened to be
		// on disk, with git_sha NULL as the only tell. The skipped `cd` also left
		// the shell inside src/, which silently
		// disabled the wrongctx guard below (it tests the relative path src/.git).
		`  cd ${shq(workingDir)} && SYNC_OK=yes; ` +
		// One symlink authority; remove hostile tracked links, then refuse.
		`  if [ "$SYNC_OK" = "yes" ]; then ${repoSymlinkGuardShell(`${workingDir}/src`)} || { echo "deploy: refusing, the repo tracks hostile symlink(s) (removed above)"; exit 1; }; fi; ` +
		`  if [ "$SYNC_OK" != "yes" ]; then echo "deploy: git sync of src/ FAILED - refusing to build, because the source on disk is NOT what GitHub has (a build here ships whatever was left in the working directory). Fix the deploy key at "${shq(`${workingDir}/.deploy-key`)}" or the repo remote, then redeploy."; exit 1; fi; ` +
		// Compose-drift tripwire: the repo may ALSO carry a docker-compose.yml,
		// but the runtime compose (configFile, server-local) is the operative
		// one - a compose change committed to the repo NEVER deploys by itself.
		// Easy to miss: a compose edit can sit dead in git for hours. Warn loudly,
		// never fail the deploy. Skip when the runtime compose IS the repo file.
		`  if [ -f src/docker-compose.yml ] && [ "$(readlink -f src/docker-compose.yml)" != "$(readlink -f ${shq(configFile)})" ] && ! diff -q src/docker-compose.yml ${shq(configFile)} >/dev/null 2>&1; then ` +
		`    echo "[compose-drift] WARNING: the repo docker-compose.yml differs from the runtime compose ("${shq(configFile)}"). Committed compose changes DO NOT deploy - apply them to the runtime file on the server too, or they silently never go live."; ` +
		// the nonce-tagged marker for the compose-drift card (deploy/stability.ts).
		(shaNonce ? `    ${stabilityMarkShell(shaNonce, 'compose-drift', 'drift')}else ${stabilityMarkShell(shaNonce, 'compose-drift', 'ok')}` : '') +
		`  fi; ` +
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
		workdirSyncShell(
			workingDir,
			`  retry ${gitCmd(shq(workingDir))} fetch origin 2>&1 && ` +
				gitResolveTarget(shq(workingDir), wantBranch, wantSha, shaIsStrict, p.baseSha ?? null) +
				// BEFORE the checkout touches the work tree (the runtime
				// docker-compose.yml is preserved by the sync, so its current copy counts).
				`  ${targetLinkGuardShell({ dir: workingDir, target: '"$TARGET"', binds: true, compose: { files: tlFiles, preserved: ['docker-compose.yml'] } })} && ` +
				`  ${gitCmd(shq(workingDir))} checkout -f -B "$BR" "$TARGET" 2>&1 && ` +
				`  ${gitCmd(shq(workingDir))} reset --hard "$TARGET" 2>&1 && ` +
				// TARGET is a sha (gitResolveTarget), so checkout -B does not set
				// the upstream; keep origin/<branch> tracking for the dashboard's ahead/behind.
				`  (${gitCmd(shq(workingDir))} branch --set-upstream-to="origin/$BR" "$BR" >/dev/null 2>&1 || true) && `,
			p.composeFiles ?? [configFile],
			{ enforce: p.composeGuardEnforce === true, app: p.migrateApp ?? service },
		) +
		// Same compose-drift tripwire as the src/ path: in this layout the
		// compose is TRACKED, so a post-restore diff vs HEAD means the repo's
		// committed compose is not what actually runs. Warn, never fail.
		`  (if ! ${gitCmd(shq(workingDir))} diff --no-ext-diff --no-textconv --quiet HEAD -- docker-compose.yml 2>/dev/null; then ` +
		`    echo "[compose-drift] WARNING: the repo's committed docker-compose.yml differs from the runtime compose this deploy preserved. Committed compose changes DO NOT deploy - apply them to the server file too, or they silently never go live."; ` +
		(shaNonce ? `    ${stabilityMarkShell(shaNonce, 'compose-drift', 'drift')}else ${stabilityMarkShell(shaNonce, 'compose-drift', 'ok')}` : '') +
		`  fi) && ` +
		// the workdir IS the build context in this layout (and in a preview's),
		// next to .deploy-key and the env. The hard reset puts back a tracked
		// .dockerignore without powder's entries; re-apply them after every sync.
		// A tracked file rewritten here is reset by the next sync (checkout -f +
		// reset --hard, no ff-only pull), an untracked one survives it as before.
		`  step "dockerignore" && { ${writeDockerignoreShell(workingDir)}; } && ` +
		`  step "git rev-parse" && ` +
		`  ${gitCmd(shq(workingDir))} rev-parse HEAD && ` +
		`  ${gitCmd(shq(workingDir))} rev-parse --abbrev-ref HEAD && ` +
		shaMarkerShell(shq(workingDir), shaNonce) +
		`  step "tracked .env guard" && ${trackedDotenvGuardShell(shq(workingDir))}; ` +
		`else ` +
		`  step "no git repo, skipping pull"; ` +
		`fi && ` +
		`{ ${composeProjectStableShell(cf, shaNonce ? projectChangedMarkerFor(shaNonce) : '')}; } && ` +
		// the compose safety authority ran on the server BEFORE this script
		// (deploy/compose-check.ts) over exactly the config whose hash is pinned here.
		(p.composeHash ? `step "compose guard" && ${composeHashGuardShell(cf, p.composeHash, 'during the git sync', p.composeGuardEnforce !== false || p.composeHashEnforce === true, p.migrateApp ?? service, p.composeGuardRecheck === true, shaNonce)} && ` : '') +
		// Detect registry-mode (compose has image: but no build: for this service).
		// Registry mode: the app's own CI builds and pushes the image, powder just
		// pulls and recreates. No build on the production server.
		// If build: is present, the image is built on the server.
		// Detection: look for "build:" inside the resolved service block. The
		// resolved config from `docker compose config` always uses consistent
		// 2/4-space indentation regardless of source file formatting.
		`HAS_BUILD=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null | ` +
		`  awk -v svc=${shq(service)} '` +
		`    /^services:/ { in_s=1; next } ` +
		`    /^[^ ]/ { in_s=0; current=""; next } ` +
		`    in_s && /^  [A-Za-z0-9_.-]+:/ { current=$1; sub(":","",current); next } ` +
		`    current==svc && /^    build:/ { print "y"; found=1; exit } ` +
		`    END { if (!found) print "n" }' ` +
		`) && ` +
		// Image staging: resolve the service's shared `image:` ref, then build to a
		// unique `:build-<id>` tag via a one-line override file. The shared tag is
		// only retagged at the swap gate (under the app lock, after the supersede
		// check), so a build can never replace what the running compose uses.
		(ord || (prebuilt && p.stageImage)
			? `IMGREF=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null | awk -v svc=${shq(service)} -v f=image: ${shq(SERVICE_FIELD_AWK)}) && ` +
				(prebuilt
					? `true && `
					: `if [ "$HAS_BUILD" = "y" ] && [ -n "$IMGREF" ]; then ` +
						`case "\${IMGREF##*/}" in *:*) STAGE_BASE="\${IMGREF%:*}";; *) STAGE_BASE="$IMGREF";; esac; ` +
						`STAGE_IMG="$STAGE_BASE:build-${stageId}"; ` +
						// mktemp (random name, O_EXCL), not a /tmp path named after the deploy id.
						`STAGE_OVR=$(mktemp /tmp/powder-stage.XXXXXX) || { echo "preflight: cannot create the stage override file"; exit 1; }; STAGE_F="-f $STAGE_OVR"; ` +
						`printf 'services:\\n  %s:\\n    image: %s\\n' ${shq(service)} "$STAGE_IMG" > "$STAGE_OVR"; ` +
						`echo "[stage] building to $STAGE_IMG (shared tag $IMGREF untouched until the swap gate)"; ` +
						`fi && `)
			: '') +
		// Declared-mode contract: when app_repos.build_mode is 'build' or
		// 'registry', the compose file must agree - refuse the deploy instead of
		// silently taking the other path. 'auto' infers the mode from the compose file.
		(declaredMode === 'build'
			? `if [ "$HAS_BUILD" != "y" ]; then echo "preflight: app is declared build_mode=build but the compose service has no build: key - refusing the silent registry fallback. Restore build: { context: ./src } in the compose file (or change build_mode)."; exit 1; fi && `
			: '') +
		(declaredMode === 'registry'
			? `if [ "$HAS_BUILD" = "y" ]; then echo "preflight: app is declared build_mode=registry but the compose service HAS a build: key - set build_mode=build (preferred) or remove build: from the compose file."; exit 1; fi && `
			: '') +
		// Wrongctx + Dockerfile guard. When building, compose build.context MUST
		// point at real source with a real Dockerfile. The recurring drift
		// (the common case) is `context: .` - the app dir - while the
		// clone lives in ./src, so the build fails late on COPY or silently ships
		// a stale image. Fail early with the fix. The wrongctx check only applies
		// to the standard src/ layout (workdir-layout apps build from `.`
		// legitimately); the Dockerfile-exists check applies to BOTH layouts
		// (a src/-gated check would leave every workdir-layout app unpreflighted). An
		// unparseable config degrades to a skip (empty PF_CTX
		// → checks no-op). `docker compose config` resolves build.context to an
		// absolute path relative to the compose file's dir, which for the
		// standard layout IS workingDir - so context:. ⇒ PF_CTX == workingDir.
		`if [ "$HAS_BUILD" = "y" ]; then ` +
		`  step "preflight build-context" && ` +
		`  PF_B=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null | awk -v svc=${shq(service)} '/^services:/{in_s=1;next} /^[^ ]/{in_s=0;current="";next} in_s&&/^  [A-Za-z0-9_.-]+:/{current=$1;sub(":","",current);in_b=0;next} current==svc&&/^    build:/{in_b=1;next} current==svc&&in_b&&/^    [A-Za-z]/{in_b=0} current==svc&&in_b&&/^      context:/{ctx=$2} current==svc&&in_b&&/^      dockerfile:/{df=$2} END{if(df=="")df="Dockerfile";print ctx;print df}'); ` +
		`  PF_CTX=$(printf '%s\\n' "$PF_B" | sed -n 1p); PF_DF=$(printf '%s\\n' "$PF_B" | sed -n 2p); ` +
		// PF_CTX/PF_DF come from the app's compose (resolved build.context and
		// dockerfile), so they are data. Refuse any char outside a path-safe set in every
		// mode, so no later use (paths, messages, the cache rewrite) can see shell or
		// sed/awk syntax. compose-safety reports the same rule before the deploy.
		`  case "$PF_CTX$PF_DF" in *[!A-Za-z0-9._/-]*) echo "preflight: build.context ('$PF_CTX') or build.dockerfile ('$PF_DF') contains a character outside [A-Za-z0-9._/-] - rename the directory/file to use only letters, digits, '.', '_', '-' and '/'."; exit 1 ;; esac; ` +
		`  if [ -d src/.git ] && [ "$PF_CTX" = ${shq(workingDir)} ]; then echo "preflight: wrong build context - build.context is the app dir (context: '.') but the freshly-cloned source is in ./src. Building from the parent ships stale/wrong code or fails on COPY. Set build: { context: ./src, dockerfile: Dockerfile }."; exit 1; fi; ` +
		`  if [ -n "$PF_CTX" ]; then case "$PF_DF" in /*) PF_DFP="$PF_DF" ;; *) PF_DFP="$PF_CTX/$PF_DF" ;; esac; if [ ! -f "$PF_DFP" ]; then echo "preflight: no Dockerfile at '$PF_DFP' (build.context='$PF_CTX', dockerfile='$PF_DF') - the build would fail. Point build.context/dockerfile at the cloned Dockerfile (standard: context ./src, dockerfile Dockerfile)."; exit 1; fi; dfr_src "$PF_DFP" "$PF_CTX" || { echo "preflight: build.dockerfile must be a file inside build.context"; exit 1; }; fi; ` +
		`fi && ` +
		// ── pages/app test-file guard ────────────────────────────────────────
		// Next compiles EVERY file under pages/ or app/ into the route tree, so a
		// `foo.test.ts` sitting in src/pages/api/ ships as a public endpoint. Worse
		// under Turbopack's eager chunk evaluation: such a file can
		// reassign process.env.DATABASE_URL at import time -
		// for the whole server process, not just the test. Refuse BEFORE the build
		// so the old container keeps serving. Same context dir the build uses
		// (PF_CTX; `src` standard, `src/<app>` for monorepo fan-out), and a plain
		// no-op for apps with no pages/app tree (registry mode, non-Next apps).
		`step "preflight pages-test-files" && ` +
		`PG_DIR="\${PF_CTX:-$(pwd)/src}" && ` +
		`if [ -d "$PG_DIR" ]; then ` +
		`  PG_HITS=$(find "$PG_DIR/pages" "$PG_DIR/src/pages" "$PG_DIR/app" "$PG_DIR/src/app" \\( -name node_modules -o -name .next -o -name .turbo \\) -prune -o -type f \\( -name '*.test.*' -o -name '*.spec.*' \\) -print 2>/dev/null | head -20); ` +
		`  if [ -n "$PG_HITS" ]; then ` +
		`    PG_FIRST=$(printf '%s\\n' "$PG_HITS" | head -1); PG_FIRST="\${PG_FIRST#"$PG_DIR"/}"; ` +
		`    echo "preflight: test file inside pages/app tree: $PG_FIRST - Next builds it as a route (move it out of pages/)"; ` +
		`    echo "[pages-test-files] all offenders under $PG_DIR:"; ` +
		`    printf '%s\\n' "$PG_HITS"; ` +
		`    exit 1; ` +
		`  fi; ` +
		// the guard chain (app lock, preflight, git sync, compose guard, preflights)
		// ends here. The dockerfile check below starts with plain `;` statements, and set -e
		// does not stop on a failed && list that is not last: without this `|| exit 1` a
		// guard that returned non-zero (instead of calling exit) let the deploy go on.
		`fi || exit 1; ` +
		// every Dockerfile this compose builds goes through the cache-id rewrite
		// (and the syntax / foreign-image checks) into a temp dir outside the context.
		`step "dockerfile check" && ` +
		// The set goes to a persistent per-app dir (built as <dir>.new, swapped in
		// whole), because `compose up` records its files in the container's config_files
		// label and every later reader (rollback, domain apply, powder-migrate, a plain
		// `compose up`) must find them. /tmp only when that dir cannot be written.
		`DFR_FINAL=${shq(deployOverrideDirFor(configFile, p.composeFiles))} && DFR_P="\${DFR_FINAL%/*}" && ` +
		`if [ ! -L "$DFR_P" ] && mkdir -p "$DFR_P" 2>/dev/null && [ ! -L "$DFR_FINAL" ] && rm -rf "$DFR_FINAL.new" && mkdir -m 700 "$DFR_FINAL.new" 2>/dev/null; then DFR_DIR="$DFR_FINAL.new"; ` +
		`else DFR_FINAL=""; DFR_DIR=$(mktemp -d /tmp/powder-dfr.XXXXXX) || { echo "preflight: cannot create the Dockerfile temp dir"; exit 1; }; echo "[build-cache] WARN cannot write the per-app override dir; using $DFR_DIR for this deploy"; fi || exit 1; ` +
		(ns.length >= 16
			? `DFR_NS=${shq(ns)}; `
			: `DFR_NS=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n'); echo "[build-cache] no cache namespace for this app: building with a fresh, isolated cache"; `) +
		`DFR_APP=${shq(cacheAppSlug(app))}; DFR_MODE=${p.composeGuardEnforce === true ? 'enforce' : 'warn'}; DFR_PULL=${p.buildPull ? 1 : 0}; DFR_OWN="\${IMGREF:-} \${STAGE_BASE:-}"; ${dockerfileAuthorityShell(p.dockerfileAuthority)}` +
		composeDockerfileRewriteShell(cf, protectExistingIgnoreShell) +
		`true && ` +
		(prebuilt
			? `step "prebuilt image (builder)" && echo "[builder] image was built on the builder host and streamed here - skipping the local build" && `
			: `if [ "$HAS_BUILD" = "y" ]; then ` +
		`  step "docker compose build (local build)" && ` +
		// --pull (default on, POWDER_BUILD_PULL=0 opts out): every FROM /
		// COPY --from / docker-image:// context is resolved from its registry, never from
		// this server's local images, so a Dockerfile cannot read another app's local-only
		// build. Opt out where Docker Hub's anonymous pull limits block a burst of builds.
		// 30-min ceiling: a build that wedges (frozen apt mirror, hung registry
		// auth) should fail loudly, not hang the worker slot until the watchdog
		// reaps it 15 min later with a useless "stuck" error. SIGTERM at 1800s.
		// HOST BUILD-LOCK: serialize every build on this server. `flock` on a shared
		// lockfile means the worker, a webhook deploy, AND any manual build that
		// uses the same lock can never run two `next build`s at once - that's what
		// OOM'd a host (load 179). -w 2400 waits up to 40m for an in-flight build,
		// then bails; the 1800s timeout still bounds the build itself. Auto-released
		// when the build process exits or is killed.
		// MEMORY GATE: a build launched into a memory-starved server doesn't OOM
		// cleanly - it swap-thrashes and wedges (a lint step can hang until the
		// deploy is reaped as stuck during a concurrent build burst). The flock
		// serializes builds per server but can't see memory pressure from running
		// apps. Wait up to 10 min for MemAvailable >= the floor (default 1.5GB,
		// override in /opt/apps/.build-min-mem-mb), then proceed with a loud
		// warning - never hard-fail on memory alone.
		// the floor comes from a file: digits only (1 to 7, no leading zero, which
		// $(( )) reads as octal) before it reaches arithmetic, else the default.
		`  MG_MIN_MB=$(cat /opt/apps/.build-min-mem-mb 2>/dev/null || echo 1536); case "$MG_MIN_MB" in ''|*[!0-9]*|0?*|????????*) MG_MIN_MB=1536;; esac; ` +
		`  MG_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null); case "$MG_KB" in *[!0-9]*) MG_KB="";; esac; MG_WAIT=0; ` +
		`  while [ -n "$MG_KB" ] && [ "$MG_KB" -lt $((MG_MIN_MB*1024)) ] && [ "$MG_WAIT" -lt 600 ]; do ` +
		`    if [ "$MG_WAIT" -eq 0 ]; then echo "[mem-gate] only $((MG_KB/1024))MB available (floor \${MG_MIN_MB}MB) - waiting for memory before build (max 10m)"; fi; ` +
		`    sleep 30; MG_WAIT=$((MG_WAIT+30)); MG_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null); case "$MG_KB" in *[!0-9]*) MG_KB="";; esac; ` +
		`  done; ` +
		`  if [ -n "$MG_KB" ] && [ "$MG_KB" -lt $((MG_MIN_MB*1024)) ]; then echo "[mem-gate] STILL only $((MG_KB/1024))MB after 10m - proceeding, but this build may swap-thrash/hang"; elif [ "$MG_WAIT" -gt 0 ]; then echo "[mem-gate] memory recovered ($((MG_KB/1024))MB) after \${MG_WAIT}s wait"; fi && ` +
		// the guards and the build path pins again, right before the build reads them.
		// pb_build re-reads the lock wait and the child timeout from the deadline on
		// each call, so a font_retry attempt gets what is left of the budget.
		`  pb_build() { flock -w "$(left 300)" ${buildLockShell()} ${childTimeoutPrefix(1800, 240)} docker compose ${cfb} $STAGE_F build ${p.buildPull ? '--pull ' : ''}${shq(service)} 2>&1; } && ` +
		`  el_guard && ` +
		`  font_retry pb_build; ` +
		`else ` +
		`  step "docker compose pull (registry mode)" && ` +
		// 10-min ceiling per attempt; `retry` still gives 3 tries. A pull stuck on
		// a slow/dead registry layer can't pin the in-flight lock open indefinitely.
		`  retry timeout "$(cap 600 240)" docker compose ${cf} pull --ignore-buildable ${shq(service)} 2>&1; ` +
		`fi && `) +
		// ── TEST GATE (opt-in) ─────────────────────────────────────────────────
		// If the app ships `.powder/test.sh` in its BUILD CONTEXT dir, run it as a
		// pre-swap gate: a non-zero exit BLOCKS the swap (old container keeps
		// serving) and is reported like any other failed deploy (failed_step =
		// "test gate"). Opt-in = presence of the file, versioned with the app; the
		// script does its own dep install + typecheck/test. Runs in a throwaway
		// node container against a READ-ONLY copy of the context (so a `npm ci`
		// can't dirty the checkout), and holds the shared build-lock so it can't
		// run concurrently with a build and OOM the server. Base image node:22-alpine;
		// override with a first-line `# powder-test-image: <img>` comment in the
		// script. Runs AFTER build, BEFORE migrate+swap, so tests gate both.
		// TG_DIR = the resolved build context (PF_CTX from the build-context
		// preflight): `src` for a standard app, `src/<app>` for a monorepo fan-out
		// app - so the gate runs in the SAME dir the image was built from, with the
		// app's own package.json/tsconfig. Falls back to src/ when PF_CTX is unset
		// (registry mode → skipped if there's no local context). Docs: /docs/deploys#steps-in-order.
		(prebuilt
			? `step "test gate" && echo "[test-gate] ran on the builder host - skipped here" && ` + testGatePresenceShell(shaNonce)
			: `step "test gate" && ` +
		// the test copy reads the context path the guard checked (its pin).
		`TG_DIR="\${PF_CTX:-$(pwd)/src}" && { dfr_pinchk || exit 1; } && TG_DIR=$(dfr_pinned "$TG_DIR") && ` +
		`if [ -f "$TG_DIR/.powder/test.sh" ]; then ${stabilityMarkShell(shaNonce, 'test-gate', 'present')}` +
		testGateShell({
			dir: '"$TG_DIR"',
			label: `${workingDir}|${service}`,
			run: `flock -w "$(left 180)" ${buildLockShell()} ${childTimeoutPrefix(900, 150)}`,
			tag: '[test-gate]',
			mem: p.testGateMem ?? null,
			enforce: p.composeGuardEnforce === true,
			app: p.migrateApp ?? service,
			loginSelf: p.dockerfileAuthority?.self || (p.migrateApp ?? service),
			loginHosts: p.dockerfileAuthority?.loginHosts ?? [],
		}) +
		`else echo "[test-gate] no .powder/test.sh in $TG_DIR - skipped (opt-in test/typecheck gate; see /docs/deploys#steps-in-order)"; ${stabilityMarkShell(shaNonce, 'test-gate', 'absent')}fi && `) +
		// Run pending DB migrations BEFORE swapping the new container in (Vercel
		// order: migrate, then promote). powder-migrate is tracked + auto-baselines
		// an existing DB on first run, so it never re-applies an already-applied
		// migration. A real migration failure aborts here -> the old container keeps
		// serving the old code+schema (consistent), instead of new code on old schema.
		// SWAP GATE: last check under the app lock, before migrations or the swap.
		// Release phase: remember the running container's image id BEFORE the swap gate
		// retags the shared tag, so a failed release can restore it (see step "release").
		`step "image labels" && ${imageLabelGuardShell(cf, service)} && ` +
		// every other service's image too (built/pulled now when `up` would).
		// every sibling build re-runs the guards and the build path pins first.
		`${serviceImageLabelGuardShell(cf, cfb, service, `el_guard && flock -w "$(left 300)" ${buildLockShell()} ${childTimeoutPrefix(1800, 240)}`, p.buildPull === true)} && ` +
		envLinkGuard('before the release') +
		`REL_PREV=$(docker inspect -f '{{.Image}}' "$(docker compose ${cf} ps -q ${shq(service)} 2>/dev/null | head -1)" 2>/dev/null || true) && ` +
		// Abort record for the JS side (a SIGKILL / dropped session skips the EXIT trap, so
		// the retagged shared tag would otherwise stay on the rejected build). Best effort.
		(ord
			? `{ if [ -n "$REL_PREV" ]; then { mkdir -p ${shq(prevFile.replace(/\/[^/]*$/, ''))} && [ ! -L ${shq(prevFile)} ] && printf '%s\\n%s\\n' "$REL_PREV" "\${IMGREF:-}" > ${shq(prevFile)}; } 2>/dev/null || true; fi; } && `
			: '') +
		(ord || (prebuilt && p.stageImage) ? `step "swap gate" && ${swapGateShell(stampFile, ord, service, shaNonce)} && ` : '') +
		// Opt-in zero-downtime overlap (see bridgeShellFunctions). Started BEFORE
		// migrate on purpose: the bridge re-runs the OLD image's startup (e.g.
		// `drizzle-kit push --force`), which must happen against the old schema,
		// never after the new migration. `{ ...; }` + `|| true`: it can never fail the deploy.
		`{ bridge_start || true; } && ` +
		`step "db migrate" && ` +
		(p.skipMigrate
			? `echo "[migrate] skipped: preview deploys never run powder-migrate" && `
			: // read-only migrate-path scan for its warning card (deploy/stability.ts):
				// a subshell behind `|| true`, it cannot fail or change the deploy.
				migratePathScanShell(shaNonce, workingDir) +
				`if [ -x /usr/local/bin/powder-migrate ]; then /usr/local/bin/powder-migrate ${shq(opts?.migrateApp ?? service)} apply 2>&1 || exit 1; else echo "[migrate] powder-migrate not installed on this host - skipping"; fi && `) +
		// Opt-in RELEASE PHASE (Heroku-style): when the image about to be swapped in
		// carries LABEL powder.release.cmd, run that command once in a one-off
		// container from the NEW image (service env_file/networks) BEFORE the swap,
		// so container startup needs no side effects (e.g. drizzle-kit push). After
		// the swap gate the shared image: tag already points at the new image on
		// every path (staged/prebuilt retag, or the in-place build), so the
		// plain `compose config` image ref IS the image compose up will use.
		// Not routed by Traefik (traefik.enable=false) and no compose container_name
		// (run --name). Failure aborts here: old container keeps serving.
		`step "release" && ` +
		// Previews never run the release command: a preview has its own env file
		// (no production DATABASE_URL), and the branch's unmerged migrations must
		// never reach the parent's database. skipMigrate is set only by previews.
		(p.skipMigrate
			? `echo "[release] skipped: preview deploys never run the release command" && `
			: `REL_CFG=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null || true) && ` +
		`REL_IMG=$(printf '%s\n' "$REL_CFG" | awk -v svc=${shq(service)} -v f=image: ${shq(SERVICE_FIELD_AWK)}) && ` +
		`REL_EXPL=y && if [ -z "$REL_IMG" ]; then REL_EXPL=n; if [ -n "$CP_PROJ" ]; then REL_IMG="$CP_PROJ-"${shq(service)}; fi; fi && ` +
		`REL_CN=$(printf '%s\n' "$REL_CFG" | awk -v svc=${shq(service)} -v f=container_name: ${shq(SERVICE_FIELD_AWK)}) && ` +
		`REL_CMD="" && if [ -n "$REL_IMG" ]; then if REL_OUT=$(docker image inspect -f '{{index .Config.Labels "powder.release.cmd"}}' "$REL_IMG" 2>/dev/null); then REL_CMD="$REL_OUT"; elif [ "$REL_EXPL" = y ]; then echo "[release] cannot inspect service image $REL_IMG"; exit 1; fi; fi && ` +
		`if [ -z "$REL_CMD" ]; then echo "[release] no powder.release.cmd label - skipped"; else ` +
		`  if [ "$(left 120)" -lt 180 ]; then release_restore; echo "[release] not enough deploy budget left - not starting"; exit 1; fi; ` +
		`  [ -n "$REL_CN" ] || REL_CN="\${CP_PROJ:-powder}-"${shq(service)}; ` +
		`  release_stop; ` +
		`  echo "[release] running powder.release.cmd in a one-off container from $REL_IMG"; ` +
		`  ( set -o pipefail; timeout "$(cap 600 120)" docker compose ${cfb} run --rm --no-deps -T --label traefik.enable=false --label ${shq('powder.release=' + workingDir + '|' + service)} --name "$REL_CN-powder-release" --entrypoint sh ${shq(service)} -c "$REL_CMD" </dev/null 2>&1 | { head -c 2000000; cat >/dev/null; } ) || { REL_RC=$?; release_stop; release_restore; echo "[release] FAILED (rc=$REL_RC) - not swapping; old container keeps serving"; exit 1; }; ` +
		`  release_stop; echo "[release] ok"; ` +
		`fi && `) +
		// Pre-swap candidate: prove the NEW image answers HTTP before touching the
		// live container. Unhealthy exits 1 here (failed step "swap-check"); the old
		// container is untouched and no rollback is needed.
		(p.swapCheck
			? swapOn
				? `step "swap-check" && swap_check && `
				: `echo "swap-check: skipped (${(p.swapCheck as { skip: string }).skip.replace(/[^A-Za-z0-9 =_.,-]/g, '')})" && `
			: '') +
		// Budget guard: a nearly spent budget must not START the swap (the outer
		// timeout would kill it mid-recreate). Exit before touching the container;
		// the EXIT trap restores the shared tag.
		`step "budget check" && if [ "$(left 0)" -lt 120 ]; then echo "deploy: only $(left 0)s of the deploy budget left before the swap (need 120s) - not swapping; the old container keeps serving"; exit 1; fi && ` +
		(p.composeHash ? `step "compose guard (pre-up)" && ${composeHashGuardShell(cf, p.composeHash, 'before the swap', p.composeGuardEnforce !== false || p.composeHashEnforce === true, p.migrateApp ?? service, p.composeGuardRecheck === true, shaNonce)} && ` : '') +
		envLinkGuard('before the swap') +
		`step "docker compose up" && ` +
		// Compose service list - used to decide what to pass to compose up.
		//
		// The naive "pass the powder app's container_name as the service name"
		// is wrong in two distinct cases:
		//   (a) sibling-services pattern (api + api-worker) - only one gets
		//       recreated, the other goes stale
		//   (b) compose file uses a service name DIFFERENT from container_name,
		//       e.g. `services: app:` with `container_name: example-app` - compose
		//       errors out with "no such service: example-app"
		//
		// Right answer: pass a service name ONLY when we need to AVOID
		// recreating sibling services. That's exactly when the compose file
		// has per-app infra (db / kv / postgres / redis / traefik) alongside
		// the app - those shouldn't bounce on every deploy. Every other case
		// (single service; or multiple app-shaped siblings) → no service name,
		// compose figures out the right scope itself.
		// All three counters wrapped in `|| true` because grep -c exits 1 when
		// nothing matches - that would break the `&&` chain and the script
		// would silently abort right after the banner: the deploy log would end at
		// "── docker compose up ──" with nothing after, hiding the real failure.
		`SVC_LIST=$(docker compose ${cf} ${ALL_PROFILES} config --services 2>/dev/null || true) && ` +
		`SVC_COUNT=$(printf '%s\n' "$SVC_LIST" | grep -c . || true) && ` +
		infraCountShell(infra) +
		`echo "[svc-list] $(printf '%s' "$SVC_LIST" | tr '\\n' ',' )(count=$SVC_COUNT, has_infra=$HAS_INFRA)" && ` +
		`if [ "$HAS_INFRA" -gt 0 ] && [ "$SVC_COUNT" -gt 1 ]; then ` +
		`  echo "[has-infra] compose has $SVC_COUNT services incl. infra; recreating only the app service"; ` +
		`  TARGETS=${shq(service)}; ` +
		// Start any infra that is NOT running (first deploy, db container gone)
		// WITHOUT recreating what already runs: --no-recreate leaves a running db
		// untouched, so a db whose image/config changed stays on its old container
		// until someone recreates it deliberately. Any `up` of a dependent app
		// recreates a dependency whose image or config changed (e.g. a moved image
		// tag), which bounced the bundled db on deploys ("terminating connection
		// due to administrator command"); the app ups below use --no-deps. --wait
		// restores the service_healthy wait that --no-deps skips.
		`  INFRA_SVCS=$(printf '%s\n' "$SVC_LIST" | grep -vxF -- ${shq(service)} | tr '\\n' ' '); ` +
		`  if [ -n "$INFRA_SVCS" ]; then ` +
		`    echo "[has-infra] ensuring infra is up (no recreate): $INFRA_SVCS"; ` +
		`    el_guard || exit 1; ` +
		// --no-recreate starts an existing (also an exited, stale) infra container
		// with the mounts it was created with: refuse one that mounts what the checked
		// config does not give its service.
		`    ${infraMountGuardShell(cfb, '$INFRA_SVCS')} || exit 1; ` +
		`    docker compose ${cfb} up -d --wait --wait-timeout 60 --no-recreate $INFRA_SVCS 2>&1 || echo "[has-infra] infra up failed, continuing with the app recreate"; ` +
		`  fi; ` +
		`else ` +
		`  echo "[single-or-siblings] compose has $SVC_COUNT services, recreating all"; ` +
		`  TARGETS=""; ` +
		`fi && ` +
		// Try the normal recreate. If compose has stale state - either a missing
		// container ID it expected, or hash-prefixed orphans from a previously
		// interrupted recreate (e.g. `<hash>_api-worker`) - the up fails.
		//
		// Retry strategy depends on the path:
		//   - No-infra ($TARGETS empty): `compose down --remove-orphans` cleans
		//     EVERY service's live + transitional containers, then a fresh `up`.
		//     Safe here because there's no persistent db/kv to disrupt. This is
		//     what fixes the sibling-services case (api + api-worker) where the
		//     old retry only force-removed the primary service.
		//   - Has-infra ($TARGETS = the app service): surgical rm of just the
		//     app container + its orphans, leaving db/kv running.
		`el_guard && (docker compose ${cfb} up -d --force-recreate \${TARGETS:+--no-deps} $TARGETS 2>&1 || ` +
		// Every retry re-runs the guard before it removes anything and again right before
		// its up (el_guard exits this subshell on a refusal, so no later attempt runs).
		`  (echo "[retry] cleaning stale state and retrying up" && el_guard && bridge_stop && ` +
		`   if [ -z "$TARGETS" ]; then ` +
		`     docker compose ${cf} down --remove-orphans 2>&1 || true; ` +
		`     el_guard && docker compose ${cfb} up -d 2>&1; ` +
		`   else ` +
		// Resolve the conflicting containers by their compose LABELS, not by
		// name. The service name ($service = com.docker.compose.service, e.g.
		// "app") is NOT the container_name (e.g. "myapp"), so a name/regex
		// match on $service finds nothing for the common service≠container_name
		// app AND could force-remove an unrelated container on the same server named
		// "app". Filtering on (project=$CP_PROJ, service=$service) selects
		// exactly this app's target-service containers - the live one plus any
		// <hash>_name rename orphan (compose's mid-recreate rename keeps the
		// labels) - regardless of their names, and never touches another
		// project. Then LOOP until dockerd lists none, because rm -f returns
		// before the daemon finishes teardown and an immediate `up` would die
		// on "name already in use".
		// CP_PROJ was resolved in preflight above.
		`     for RM_TRY in 1 2 3 4 5; do ` +
		`       RM_IDS=$(docker ps -aq --filter "label=com.docker.compose.project=$CP_PROJ" --filter "label=com.docker.compose.service="${shq(service)}); ` +
		`       [ -z "$RM_IDS" ] && break; ` +
		`       printf '%s\n' "$RM_IDS" | xargs -r docker rm -f 2>/dev/null || true; ` +
		`       sleep 2; ` +
		`     done; ` +
		`     el_guard && docker compose ${cfb} up -d --force-recreate \${TARGETS:+--no-deps} $TARGETS 2>&1 || ` +
		// Last resort: never leave the app ABSENT (the outage mode - old
		// container removed, new one stuck in Created). One settled plain up.
		`       (echo "[retry] force-recreate failed again - settling and trying a plain up" && sleep 5 && ` +
		`        el_guard && docker compose ${cfb} up -d \${TARGETS:+--no-deps} $TARGETS 2>&1); ` +
		`   fi)) && SWAPPED=1 && ` +
		// Wait for the new container to answer, then drop the bridge (no-op when
		// no bridge was started). Always returns 0.
		`{ bridge_handoff || true; } && ` +
		// The proven candidate has done its job: drop it now that the recreate is done.
		(swapOn ? `{ swap_stop || true; } && ` : '') +
		// Server runtime standard, opt-in: only on a server with a non-empty
		// /opt/apps/.mem-cap (e.g. 2g or 4g; docs/SELF-HOSTING.md). There, every
		// deploy sets the app container's memory to that value, OVERRIDING a
		// compose mem_limit (the operator's server-wide choice; apps whose compose
		// says 1g run at the server cap), and sets restart unless-stopped where the
		// policy is none ("no"/empty); an explicit restart policy wins.
		// No file: nothing is changed. Best-effort - never fails a deploy.
		`step "normalize (enforce restart + mem cap)" && ` +
		`NCAP=$(cat /opt/apps/.mem-cap 2>/dev/null || true) && ` +
		// Resolve the service's container(s) through compose instead of treating
		// the SERVICE name as a container name - for `services: app:` +
		// `container_name: example-app` that silently capped nothing.
		`SVC_IDS=$(docker compose ${cf} ps -q ${shq(service)} 2>/dev/null || true) && ` +
		`for SVC_ID in $SVC_IDS; do if [ -n "$NCAP" ]; then ` +
		`case "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$SVC_ID" 2>/dev/null || echo x)" in ""|no) docker update --restart=unless-stopped "$SVC_ID" >/dev/null 2>&1 || true;; esac; ` +
		`docker update --memory="$NCAP" --memory-swap="$NCAP" "$SVC_ID" >/dev/null 2>&1 || true; ` +
		`fi; done && ` +
		`step "resolve image" && ` +
		`IMG=$(printf '%s\n' "$SVC_IDS" | head -1 | xargs -r docker inspect --format '{{.Config.Image}}' 2>/dev/null || true) && ` +
		// No rollback tag here. The `:deploy-*` tag is applied by tagDeployImage
		// only AFTER the health gate + image readback pass, so a failed deploy
		// never takes one of the prune's newest-N rollback slots (three failed
		// deploys in a row cannot evict the last GOOD image).
		`echo "image: $IMG"`
	)
}
