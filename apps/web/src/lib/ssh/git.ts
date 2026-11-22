import type { ServerConfig } from '../servers'
import { shq } from '../shell'
import { atomicWriteShellRaw, repoSymlinkGuardShell } from '../repo-symlinks'
import { runCommand } from './connection'
import { branchProblem, repoUrlProblem } from '../git-input'
import { POWDER_GIT_NOREPO, gitCmd, gitHardenShellFunctions } from '../git-harden'
import { targetLinkGuardShell, targetLinkSourcesShell } from '../target-links'
import { APP_LOCK_DIR } from '../deploy-supersede'
import { createHash, randomBytes } from 'node:crypto'
import { redactSecrets } from '../secret-text'
import { CLONE_KEY_TMP_PREFIX, cloneKeyTmpPathOk } from '../temp-path'
import { APPS_ROOT, CLONE_TMP_MARKER, MAX_PURPOSE, cloneMarkerMatchShell, cloneMarkerMatchVarShell, cloneMarkerWriteShell, clonePurposeOk, clonePurposeSlug, cloneTargetOk, cloneTmpMarkerMatchVarShell, cloneTmpMarkerWriteShell } from '../clone-marker'
import { type AppCheckout, appCheckoutProbeShell, parseCheckoutFacts, resolveAppCheckout } from '../app-checkout'

export { repoSymlinkGuardShell } from '../repo-symlinks'

// ── clone scripts: outcome reporting ───────────────────────────────────────────
//
// A clone script reports its outcome through its exit code plus ONE status line it
// prints itself from its EXIT trap:
//   __PC_<nonce>__ rc=<n> placed=<0|1> kept=<path|-> reason=<word>
// Channel: the script moves its own stdout to fd 3 at once and sends everything else
// (its messages, git, the link guards) to stderr; fd 3 carries only the status line,
// and every step that runs repo-influenced code (git clone, the link guards, the
// symlink guard) runs in a subshell that closes fd 3 first (the main shell keeps it,
// so a TERM trap there still has it), so no child, even one left running in the
// background, can write to stdout at all. The nonce is random per call and reaches
// the script on stdin (runCommand's stdin option), never in the command line. The
// caller accepts stdout only when it is exactly that one line; anything else means
// "refused, nothing placed". Every decision (did this run place the clone, what was
// kept) comes from that line.

export function cloneNonce(): string {
	return randomBytes(16).toString('hex')
}

export interface CloneStatus {
	rc: number
	placed: boolean
	kept: string | null
	reason: string
}

/** The status of a clone script run with `nonce`: its stdout must be exactly the one
 *  status line (fd 3 carries nothing else), else null. Pure. */
export function parseCloneStatus(stdout: string, nonce: string): CloneStatus | null {
	if (!/^[0-9a-f]{32}$/.test(nonce)) return null
	const only = stdout.replace(/\n$/, '')
	if (only.includes('\n')) return null
	const m = only.match(new RegExp(`^__PC_${nonce}__ rc=(\\d{1,3}) placed=([01]) kept=(-|/[A-Za-z0-9_./-]+) reason=([a-z]+)$`))
	if (!m) return null
	return { rc: Number(m[1]), placed: m[2] === '1', kept: m[3] === '-' ? null : (m[3] ?? null), reason: m[4] ?? 'failed' }
}

/** Shell prelude (ends with `; `), first in every clone script: the status variables,
 *  `__pc_refuse <reason> <message>`, and the EXIT trap that removes this run's own
 *  temp dir (only when its temp marker names `purpose`: a recursive removal only when
 *  a clone is inside, else the marker file and the empty dir) and prints the status
 *  line last. Must come before GITHUB_KNOWN_HOSTS_SETUP, which chains its own EXIT
 *  cleanup in front of this one. */
function cloneStatusPrelude(purpose: string, keyToRemove: string | null = null): string {
	return (
		// fd 3 = the real stdout, for the status line only; everything else to stderr;
		// the nonce from stdin (refused before anything else when it is not one), then
		// stdin is closed for everything after
		`exec 3>&1 1>&2; ` +
		nonceReadShell('__PC_NONCE', 'clone') +
		`__PC_TMP=; __PC_PLACED=0; __PC_KEPT=-; __PC_WHY=failed; ` +
		`__pc_refuse() { __PC_WHY=$1; shift; echo "clone refused: $*"; exit 1; }; ` +
		// set +e first and the status fields before any cleanup command, so a failing
		// cleanup can never lose the status line
		`__pc_end() { __rc=$?; set +e; trap - EXIT HUP INT TERM; ` +
		`__pc_st="rc=$__rc placed=$__PC_PLACED kept=$__PC_KEPT reason=$__PC_WHY"; ` +
		`if [ -n "$__PC_TMP" ] && ${cloneTmpMarkerMatchVarShell('__PC_TMP', purpose)}; then ` +
		`if [ -e "$__PC_TMP/repo" ] || [ -L "$__PC_TMP/repo" ]; then rm -rf -- "$__PC_TMP"; ` +
		`else rm -f -- "$__PC_TMP/${CLONE_TMP_MARKER}"; rmdir -- "$__PC_TMP" 2>/dev/null; fi; fi; ` +
		// the temp deploy key this run was given, also when the caller is gone; only a
		// path of the temp key's exact shape, checked again here in the script
		(keyToRemove
			? `__pk=${shq(keyToRemove)}; case "$__pk" in ${shq(`${CLONE_KEY_TMP_PREFIX}.tmp.`)}????????????????) case "\${__pk##*.}" in *[!0123456789abcdef]*) ;; *) rm -f -- "$__pk" ;; esac ;; esac; `
			: '') +
		`printf '__PC_%s__ %s\\n' "$__PC_NONCE" "$__pc_st" >&3; exit "$__rc"; }; ` +
		`trap __pc_end EXIT; trap '__PC_WHY=killed; exit 143' HUP INT TERM; `
	)
}

/** Shell (ends with `; `): read this call's nonce from stdin into `v` (waiting at most
 *  10 s: bash's `read -t`, or `timeout 10 head -n 1` under another shell), then refuse
 *  with exit 2 and a line on stderr, before anything else runs, unless it is exactly
 *  32 lowercase hex characters (stdin at EOF, an empty or short line, other
 *  characters, or nothing within 10 s). The caller then finds no status line, which
 *  reads as "refused, nothing placed", and that is true. Closes stdin afterwards. */
export function nonceReadShell(v: string, who: string): string {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(v) || !/^[a-z ]+$/.test(who)) throw new Error('bad nonce reader')
	return (
		`${v}=; if [ -n "\${BASH_VERSION:-}" ]; then IFS= read -r -t 10 ${v} || ${v}=; ` +
		`else ${v}=$(timeout 10 head -n 1 2>/dev/null) || ${v}=; fi; ` +
		`case "$${v}" in *[!0123456789abcdef]*) ${v}= ;; esac; ` +
		`if [ "\${#${v}}" -ne 32 ]; then echo "${who} refused: no valid call value on stdin, nothing was run" >&2; exit 2; fi; ` +
		`exec 0</dev/null; `
	)
}

/** runCommand options carrying a clone script's nonce on stdin. */
function nonceStdin(nonce: string): { stdin: string } {
	return { stdin: `${nonce}\n` }
}

/** Shell (ends with `; `): remove dead temp clones of `purpose` next to `prefix`
 *  (exactly `<prefix><digits>`, never this run's own, only with the temp marker naming
 *  this owner). Runs after every refusal check, under the clone's lock. */
function sweepDeadTempsShell(prefix: string, purpose: string): string {
	return (
		`for __d in ${shq(prefix)}*; do ` +
		`[ "$__d" = "$__PC_TMP" ] && continue; __r=\${__d##*.}; ` +
		`case "$__r" in ''|*[!0-9]*) continue ;; esac; [ "$__d" = ${shq(prefix)}"$__r" ] || continue; ` +
		`if ${cloneTmpMarkerMatchVarShell('__d', purpose)}; then rm -rf -- "$__d"; fi; done; `
	)
}

/** Why a clone did not complete, for people. Pure. */
function cloneReasonText(reason: string, target: string, purpose: string): string {
	switch (reason) {
		case 'lock':
			return `another clone of ${target}, or a deploy, holds the lock (or the lock could not be taken); nothing in the app's directory was changed`
		case 'exists':
			return `${target} already exists (a new app is only ever cloned into a path that does not exist); nothing in the app's directory was changed`
		case 'foreign':
			return `${target} already exists and powder cannot prove it cloned it for ${purpose} (no matching .git/powder-clone-target marker); nothing in the app's directory was changed`
		case 'nowd':
			return `cannot enter ${target}; nothing in the app's directory was changed`
		case 'checkout':
			return `${target} already holds a git checkout (src/ or .git); nothing in the app's directory was changed`
		case 'tmp':
			return `a temp clone path next to ${target} already exists; nothing in the app's directory was changed`
		case 'clone':
			return `the clone from the remote failed; ${target} was not touched and the temp clone was removed`
		case 'linkguard':
			return `the repo tracks a symlink that points outside the checkout or over a mount; ${target} was not touched and the temp clone was removed`
		case 'symlinks':
			return `the repo tracks hostile symlink(s) (removed from the new clone at ${target})`
		case 'killed':
			return `the clone was interrupted`
		case 'nostatus':
			return `the clone script reported no outcome (it refused to start, or its answer did not arrive); powder treats it as not placed, check ${target} on the server`
		default:
			return 'clone failed'
	}
}

/** A clone did not complete. `placed`: this run's new clone is at the target (so the
 *  caller's cleanup may remove what this run created). `refused`: nothing was placed.
 *  Both come from the status line only. */
export class CloneError extends Error {
	constructor(
		message: string,
		readonly refused: boolean,
		readonly placed: boolean,
		readonly keptAt: string | null,
		readonly reason: string = 'failed',
	) {
		super(message)
		this.name = 'CloneError'
	}
}

function cloneFailure(stderr: string, st: CloneStatus | null, target: string, purpose: string): CloneError {
	const reason = st?.reason ?? 'nostatus'
	let msg = `clone refused: ${cloneReasonText(reason, target, purpose)}`
	// git's own words, or the script's own refusal line (text only, never a decision)
	if (reason === 'clone' || reason === 'failed' || !st) {
		const tail = stderr
			.split('\n')
			.filter((l) => l.trim() && !l.startsWith('__PC_') && (!st || !l.startsWith('clone refused:')))
			.slice(-3)
			.join(' ')
		if (tail) msg += `: ${redactSecrets(tail.slice(0, 400))}`
	}
	return new CloneError(msg, !st?.placed, !!st?.placed, st?.kept ?? null, reason)
}

/** Lock file serialising every clone of one target path on a server. */
export function cloneLockPath(target: string, dir: string = APP_LOCK_DIR): string {
	return `${dir.replace(/\/+$/, '')}/clone-${createHash('sha256').update(target).digest('hex').slice(0, 16)}.lock`
}

/** Seconds a clone waits for its lock: well inside the 120 s the call gives the whole
 *  script, so the clone itself keeps most of the budget. */
export const CLONE_LOCK_WAIT_SEC = 20

/** The file name limit of the server's file systems (ext4, xfs). */
const MAX_NAME = 255

/** Shell (ends with `; `): take `lock` on fd `fd` with a short wait, or refuse. */
function cloneLockShell(lock: string, fd: number, busy: string): string {
	const d = shq(lock.replace(/\/[^/]*$/, '') || '/')
	return (
		`{ [ ! -L ${d} ] && mkdir -p ${d} && chmod 700 ${d}; } || __pc_refuse lock 'the lock dir cannot be used'; ` +
		`[ ! -L ${shq(lock)} ] || __pc_refuse lock 'the lock path is a symlink'; ` +
		`__PC_WHY=lock; exec ${fd}>${shq(lock)}; __PC_WHY=failed; ` +
		`flock -w ${CLONE_LOCK_WAIT_SEC} ${fd} || __pc_refuse lock ${shq(busy)}; `
	)
}

/** Clone `repoUrl` into `workingDir` (the workdir layout: /new and previews).
 *  `purpose` names the owner (`app:<name>`, `preview:<preview row id>`).
 *  Order, so a refusal never follows a change: the path shape (before any command),
 *  the target's lock, then every refusal check; only then the temp clone (temp dir
 *  marked before git runs), the link check of the temp clone, the sweep of this
 *  owner's dead temps, the move-aside (previews only, marker checked right before),
 *  the move in place. A link-check refusal or a failed clone removes only this run's
 *  own marked temp dir.
 *  - `app:` owners never replace anything: the target must not exist.
 *  - `preview:` owners move an existing target aside to `<dir>.before-powder.<digits>`
 *    only when its marker names the same preview row, and keep at most one such copy
 *    (earlier copies of the same owner, by marker, are removed).
 *  Throws CloneError (placed / kept / reason from the status line only). */
export async function gitCloneRepo(
	server: ServerConfig,
	workingDir: string,
	repoUrl: string,
	branch: string,
	deployKeyPath: string,
	purpose: string,
	opts: { lockDir?: string; appsRoot?: string } = {},
): Promise<{ output: string; keptAt: string | null }> {
	const bad = repoUrlProblem(repoUrl) ?? branchProblem(branch)
	if (bad) throw new CloneError(bad, true, false, null, 'input')
	if (!clonePurposeOk(purpose) || purpose.startsWith('src:'))
		throw new CloneError(`clone refused: the owner ${JSON.stringify(purpose.slice(0, 80))} is not a valid owner (app:<name> or preview:<id>, at most ${MAX_PURPOSE} characters); nothing was run`, true, false, null, 'input')
	if (!cloneTargetOk(workingDir, opts.appsRoot))
		throw new CloneError(`clone refused: ${JSON.stringify(workingDir)} is not a directory directly under ${opts.appsRoot ?? APPS_ROOT}; nothing was run`, true, false, null, 'path')
	const nonce = cloneNonce()
	const isApp = purpose.startsWith('app:')
	const slug = clonePurposeSlug(purpose)
	const tmp = `${workingDir}.clone.${slug}.${Date.now()}`
	// the longest name this run creates (the temp dir, the kept copy) must fit a file name
	if ((tmp.split('/').pop() ?? '').length + 4 > MAX_NAME)
		throw new CloneError(`clone refused: the directory name and owner ${purpose} are too long for the temp clone's file name (at most ${MAX_NAME} bytes); nothing was run`, true, false, null, 'path')
	const wd = shq(workingDir)
	const kept = `${workingDir}.before-powder.`
	const cmd =
		`set -e; ` +
		cloneStatusPrelude(purpose) +
		cloneLockShell(cloneLockPath(workingDir, opts.lockDir), 8, `another clone of ${workingDir} is still running`) +
		gitHardenShellFunctions() +
		GITHUB_KNOWN_HOSTS_SETUP +
		`export GIT_TERMINAL_PROMPT=0; ` +
		`export GIT_SSH_COMMAND="ssh -i ${shq(deployKeyPath)} ${GIT_SSH_HOSTKEY_OPTS} -o BatchMode=yes -o ConnectTimeout=10"; ` +
		// ── every refusal check, before any change ──
		(isApp
			? `if [ -e ${wd} ] || [ -L ${wd} ]; then __pc_refuse exists ${shq(workingDir)}; fi; `
			: `if { [ -e ${wd} ] || [ -L ${wd} ]; } && ! ${cloneMarkerMatchShell(workingDir, purpose)}; then __pc_refuse foreign ${shq(workingDir)}; fi; `) +
		`if [ -e ${shq(tmp)} ] || [ -L ${shq(tmp)} ]; then __pc_refuse tmp ${shq(tmp)}; fi; ` +
		// ── changes ──
		`mkdir -p "$(dirname ${wd})"; mkdir -- ${shq(tmp)}; __PC_TMP=${shq(tmp)}; ${cloneTmpMarkerWriteShell(tmp, purpose)}; ` +
		// `--` ends option parsing: nothing positional can be read as a flag.
		// repo-influenced steps run with fd 3 (the status channel) closed
		`( exec 3>&-; ${POWDER_GIT_NOREPO} clone --branch ${shq(branch)} --depth 1 -- ${shq(repoUrl)} ${shq(`${tmp}/repo`)} 2>&1 ) || { __PC_WHY=clone; exit 1; }; ` +
		`${cloneMarkerWriteShell(`${tmp}/repo`, purpose)}; ` +
		// the clone lands at the target; a container binding a path in it re-resolves
		// that path on its next start. Check the cloned tree (links that escape, and
		// links over any mount source under the dir) while it is still the temp clone.
		`( exec 3>&-; ${targetLinkSourcesShell(null)}${targetLinkGuardShell({ dir: `${tmp}/repo`, root: workingDir, target: 'HEAD', binds: true, who: 'clone' })} ) || { __PC_WHY=linkguard; exit 1; }; ` +
		sweepDeadTempsShell(`${workingDir}.clone.${slug}.`, purpose) +
		(isApp
			? ''
			: `if [ -e ${wd} ] || [ -L ${wd} ]; then ` +
				`if ${cloneMarkerMatchShell(workingDir, purpose)}; then __K=${shq(kept)}"$(date +%s)$$"; mv -T -- ${wd} "$__K"; __PC_KEPT=$__K; ` +
				`else __pc_refuse foreign ${shq(workingDir)}; fi; ` +
				// at most one kept copy: earlier copies of this same owner (exact name, marker)
				`for __d in ${shq(kept)}*; do [ "$__d" = "$__PC_KEPT" ] && continue; __r=\${__d##*.}; ` +
				`case "$__r" in ''|*[!0-9]*) continue ;; esac; [ "$__d" = ${shq(kept)}"$__r" ] || continue; ` +
				`if ${cloneMarkerMatchVarShell('__d', purpose)}; then rm -rf -- "$__d"; fi; done; ` +
				`fi; `) +
		`mv -T -- ${shq(`${tmp}/repo`)} ${wd}; __PC_PLACED=1; ` +
		`rm -f -- ${shq(`${tmp}/${CLONE_TMP_MARKER}`)}; rmdir -- ${shq(tmp)}; __PC_TMP=; ` +
		`( exec 3>&-; ${repoSymlinkGuardShell(workingDir)} ) || { __PC_WHY=symlinks; exit 1; }; ` +
		`__PC_WHY=ok; echo "cloned to "${wd}`
	const { stdout, code, stderr } = await runCommand(server, cmd, 120_000, undefined, nonceStdin(nonce))
	const st = parseCloneStatus(stdout, nonce)
	if (code !== 0 || !st || st.rc !== 0 || !st.placed || st.reason !== 'ok') throw cloneFailure(stderr, st, workingDir, purpose)
	return { output: stderr, keptAt: st.kept }
}

export interface GitStatus {
	isRepo: boolean
	branch: string | null
	currentSha: string | null
	upstreamSha: string | null
	dirty: boolean
	/** where the checkout is (lib/app-checkout.ts): src, workdir, none, src-link or unknown */
	checkout: AppCheckout['kind']
	/** the checkout read for this status, or null */
	checkoutDir: string | null
	/** the standard layout, with an older layout's `.git` also left in the working dir (ignored) */
	staleWorkdirGit: boolean
	/** set when the remote could not be checked (upstreamSha is then null): the short reason */
	upstreamError: string | null
}

/** A working dir safe to put inside GIT_SSH_COMMAND (git runs it through `sh -c`):
 *  absolute, plain characters only, no `..` segment. Pure. */
export function gitStatusDirOk(dir: string): boolean {
	return /^\/[A-Za-z0-9_./-]+$/.test(dir) && !dir.split('/').includes('..')
}

/** Where the app's checkout is on the server (the one authority, lib/app-checkout.ts).
 *  Reads only. An unsafe working dir is `unknown` without running anything; an
 *  unreachable server throws. */
export async function probeAppCheckout(server: ServerConfig, workingDir: string): Promise<AppCheckout> {
	if (!gitStatusDirOk(workingDir)) return { kind: 'unknown' }
	const { stdout } = await runCommand(server, appCheckoutProbeShell(workingDir), 10_000)
	return resolveAppCheckout(workingDir, parseCheckoutFacts(stdout))
}

const SHA_LINE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const LSREMOTE_ERR = '::lsremote-error::'
const LSREMOTE_NOBRANCH = '::lsremote-nobranch::'

/** Why the remote could not be checked, from the upstream line of the status
 *  script; null when it holds the remote's commit. Pure. */
export function upstreamErrorOf(line: string): string | null {
	if (SHA_LINE.test(line)) return null
	if (line === 'NONE' || line === '') return 'the checkout has no upstream branch'
	if (line === LSREMOTE_NOBRANCH) return 'the branch is not on the remote'
	if (line.startsWith(LSREMOTE_ERR)) {
		const why = redactSecrets(line.slice(LSREMOTE_ERR.length).trim())
		return why ? `the remote could not be read: ${why}` : 'the remote could not be read'
	}
	return 'unreadable answer from the server'
}

/** Shell exports that keep a dashboard read of the checkout from writing or waiting:
 *  no optional index lock (a deploy's checkout/reset needs index.lock), no prompt. */
const READ_ONLY_GIT_ENV =
	'export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1 GIT_HTTP_LOW_SPEED_TIME=10; '

/** Branch, commit, the remote's tip of the upstream branch and dirtiness of the
 *  app's checkout (`src/` first, see lib/app-checkout.ts). `workingDir` is the
 *  compose working dir. The remote tip comes from `git ls-remote`, which writes
 *  nothing to the repository (no fetch: a page load never moves refs, FETCH_HEAD or
 *  the shallow file of a checkout a deploy may be syncing at the same moment). */
export async function getGitStatus(server: ServerConfig, workingDir: string): Promise<GitStatus> {
	const empty = { isRepo: false, branch: null, currentSha: null, upstreamSha: null, dirty: false, checkoutDir: null, staleWorkdirGit: false, upstreamError: null }
	// `workingDir` comes from a container label and ends up in GIT_SSH_COMMAND.
	if (!gitStatusDirOk(workingDir)) return { ...empty, checkout: 'unknown' }
	const co = await probeAppCheckout(server, workingDir)
	if (co.kind !== 'src' && co.kind !== 'workdir') return { ...empty, checkout: co.kind }
	const staleWorkdirGit = co.kind === 'src' && co.staleWorkdirGit
	const dir = co.dir
	// hardened git (repo-local config scrubbed, exec keys pinned).
	const g = gitCmd(shq(dir), shq(dir))
	const cmd =
		gitHardenShellFunctions() +
		READ_ONLY_GIT_ENV +
		// the same credentials a deploy uses (the deploy key in the working dir, the
		// pinned github.com host keys), never a prompt, a bounded connect.
		`KEY=${shq(workingDir.replace(/\/+$/, ''))}/.deploy-key; ` +
		`if [ -f "$KEY" ] && [ ! -L "$KEY" ]; then ${GITHUB_KNOWN_HOSTS_SETUP}export GIT_SSH_COMMAND="ssh -i $KEY ${GIT_SSH_HOSTKEY_OPTS} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10"; fi; ` +
		`if [ -d ${shq(dir)}/.git ]; then ` +
		`echo "::repo::"; ` +
		`${g} rev-parse --abbrev-ref HEAD; ` +
		`${g} rev-parse HEAD; ` +
		// the upstream (origin/<branch>, set by every deploy) and the remote's tip of it
		`UP=$(${g} rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || UP=; ` +
		`R=\${UP%%/*}; B=\${UP#*/}; L=NONE; ` +
		// a failed ls-remote (no network, auth refused, repository gone) is its own
		// answer, never "no upstream" (which would read as up to date)
		`if [ -n "$UP" ] && [ "$R" != "$UP" ] && [ -n "$B" ]; then ` +
		`if LO=$(${g} ls-remote -- "$R" "refs/heads/$B" 2>&1); then L=$(printf '%s\\n' "$LO" | awk 'NR==1{print $1}'); [ -n "$L" ] || L=${shq(LSREMOTE_NOBRANCH)}; ` +
		// the line that says why (ssh's "Permission denied", git's "fatal:"), else the last one
		`else L="${LSREMOTE_ERR} $({ printf '%s\\n' "$LO" | grep -m1 -iE 'denied|fatal|error|timed out|could not|not found' || printf '%s\\n' "$LO" | grep -v '^[[:space:]]*$' | tail -n 1; } | tr -d '\\r' | cut -c1-200)"; fi; fi; ` +
		`echo "$L"; ` +
		`${g} status --porcelain 2>/dev/null | head -1; ` +
		`else echo "::norepo::"; fi`
	const { stdout } = await runCommand(server, cmd, 20_000)
	if (!stdout.includes('::repo::')) return { ...empty, checkout: co.kind, checkoutDir: dir, staleWorkdirGit }
	const lines = stdout.split('\n').map((l) => l.trim())
	const start = lines.indexOf('::repo::')
	const branch = lines[start + 1] || null
	const currentSha = lines[start + 2] || null
	const upstream = lines[start + 3] ?? ''
	const dirtyLine = lines[start + 4] ?? ''
	return {
		isRepo: true,
		branch,
		currentSha,
		upstreamSha: SHA_LINE.test(upstream) ? upstream : null,
		upstreamError: upstreamErrorOf(upstream),
		dirty: dirtyLine.length > 0,
		checkout: co.kind,
		checkoutDir: dir,
		staleWorkdirGit,
	}
}

/** True when `<wd>/.deploy-key` does not exist and `<wd>/src` is a checkout whose
 *  origin is `repoUrl` (read with hardened git): the state a clone leaves when its
 *  deploy key could not be written afterwards. Reads only. */
export async function deployKeyMissingForRepo(server: ServerConfig, wd: string, repoUrl: string): Promise<boolean> {
	if (!gitStatusDirOk(wd)) return false
	const src = `${wd}/src`
	const key = shq(`${wd}/.deploy-key`)
	const r = await runCommand(
		server,
		`${gitHardenShellFunctions()}if [ -e ${key} ] || [ -L ${key} ]; then echo has; ` +
			`else printf 'missing %s\\n' "$(${gitCmd(shq(src), shq(src))} remote get-url origin 2>/dev/null)"; fi`,
		10_000,
	)
	return r.stdout.trim() === `missing ${repoUrl}`
}

/** The clone action of a connected app with no checkout: clone the repo into
 *  `<workingDir>/src` (the standard layout) and touch nothing else. Refuses before
 *  any change when the working dir cannot be entered, `src` exists in any form, the
 *  working dir holds a `.git` of any type, or the app's deploy lock is held (a deploy
 *  runs). Then, under that lock: a temp dir `<wd>/.powder-clone-src.<digits>` marked
 *  `src:<app dir name>` before git runs, the clone into `<tmp>/repo`, its link check,
 *  the sweep of dead temps of this owner (exact name, marker), and `mv -T` of the
 *  clone to `src`. The working dir itself is never moved or replaced. The route
 *  checks the layout first (probeAppCheckout + cloneRefusal). Throws CloneError. */
export async function cloneIntoAppSrc(
	server: ServerConfig,
	workingDir: string,
	repoUrl: string,
	branch: string,
	deployKeyPath: string,
	/** the app's deploy lock (appLockPath(workingDir, service)): held for the whole run */
	lockPath: string,
	/** removeKey: the key file is a temp copy made for this call; the script removes it
	 *  when it exits, also if the caller is gone by then */
	opts: { removeKey?: boolean } = {},
): Promise<{ output: string }> {
	const bad = repoUrlProblem(repoUrl) ?? branchProblem(branch)
	if (bad) throw new CloneError(bad, true, false, null, 'input')
	// the script removes the key file when it exits: only the clone action's own temp key
	if (opts.removeKey && !cloneKeyTmpPathOk(deployKeyPath))
		throw new CloneError(`clone refused: ${JSON.stringify(deployKeyPath.slice(0, 120))} is not a temp key of the clone action (${CLONE_KEY_TMP_PREFIX}.tmp.<16 hex>), so it may not be removed; nothing was run`, true, false, null, 'input')
	if (!gitStatusDirOk(workingDir)) throw new CloneError('unsafe working dir', true, false, null, 'path')
	const wd = workingDir.replace(/\/+$/, '')
	const purpose = `src:${wd.split('/').pop() ?? ''}`
	if (!clonePurposeOk(purpose)) throw new CloneError('unsafe working dir', true, false, null, 'path')
	const src = `${wd}/src`
	const tmp = `${wd}/.powder-clone-src.${Date.now()}`
	const nonce = cloneNonce()
	const cmd =
		`set -e; ` +
		cloneStatusPrelude(purpose, opts.removeKey ? deployKeyPath : null) +
		// the deploy's own lock file, short wait: no deploy syncs and no other clone of
		// this app runs meanwhile
		cloneLockShell(lockPath, 9, 'a deploy of this app is running; clone again when it has finished') +
		gitHardenShellFunctions() +
		GITHUB_KNOWN_HOSTS_SETUP +
		`export GIT_TERMINAL_PROMPT=0; ` +
		`export GIT_SSH_COMMAND="ssh -i ${shq(deployKeyPath)} ${GIT_SSH_HOSTKEY_OPTS} -o BatchMode=yes -o ConnectTimeout=10"; ` +
		// ── every refusal check, before any change ──
		`cd ${shq(wd)} 2>/dev/null || __pc_refuse nowd ${shq(wd)}; ` +
		`if [ -e src ] || [ -L src ]; then __pc_refuse checkout ${shq(src)}; fi; ` +
		`if [ -e .git ] || [ -L .git ]; then __pc_refuse checkout ${shq(`${wd}/.git`)}; fi; ` +
		`if [ -e ${shq(tmp)} ] || [ -L ${shq(tmp)} ]; then __pc_refuse tmp ${shq(tmp)}; fi; ` +
		// ── changes ──
		`mkdir -- ${shq(tmp)}; __PC_TMP=${shq(tmp)}; ${cloneTmpMarkerWriteShell(tmp, purpose)}; ` +
		// `--` ends option parsing: nothing positional can be read as a flag.
		`( exec 3>&-; ${POWDER_GIT_NOREPO} clone --branch ${shq(branch)} --depth 1 -- ${shq(repoUrl)} ${shq(`${tmp}/repo`)} 2>&1 ) || { __PC_WHY=clone; exit 1; }; ` +
		// links that escape, and links over any mount source under src/, before src/ exists
		`( exec 3>&-; ${targetLinkSourcesShell(null)}${targetLinkGuardShell({ dir: `${tmp}/repo`, root: src, target: 'HEAD', binds: true, who: 'clone' })} ) || { __PC_WHY=linkguard; exit 1; }; ` +
		sweepDeadTempsShell(`${wd}/.powder-clone-src.`, purpose) +
		// -T: never into an existing dir (src was checked absent under the lock)
		`mv -T -- ${shq(`${tmp}/repo`)} ${shq(src)}; __PC_PLACED=1; ` +
		`rm -f -- ${shq(`${tmp}/${CLONE_TMP_MARKER}`)}; rmdir -- ${shq(tmp)}; __PC_TMP=; ` +
		`( exec 3>&-; ${repoSymlinkGuardShell(src)} ) || { __PC_WHY=symlinks; exit 1; }; ` +
		`__PC_WHY=ok; echo "cloned to "${shq(src)}`
	const { stdout, code, stderr } = await runCommand(server, cmd, 120_000, undefined, nonceStdin(nonce))
	const st = parseCloneStatus(stdout, nonce)
	if (code !== 0 || !st || st.rc !== 0 || !st.placed || st.reason !== 'ok') throw cloneFailure(stderr, st, src, purpose)
	return { output: stderr }
}

// ── deploy-script building blocks ─────────────────────────────────────────────

/** Branch / ref names we are willing to interpolate into the deploy script. */
export { GIT_REF_RE } from '../git-input'

// GitHub's published SSH host keys (verified against
// https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints —
// ED25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU,
// ECDSA SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM,
// RSA SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s).
// Deploy git traffic used `StrictHostKeyChecking=no` + `/dev/null`, i.e. it
// would hand the deploy key's signature to anyone answering as github.com. We
// write a powder-owned known_hosts with exactly these keys and check strictly
// against it — independent of whatever (possibly pre-2023-rotation) github.com
// line a server's own ~/.ssh/known_hosts carries.
const GITHUB_KNOWN_HOSTS = [
	'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
	'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
	'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
]

/** Shell: write the powder-owned known_hosts and set $PKH to its path. Falls
 *  back to a fresh mktemp file (0600, unpredictable name, so no other local
 *  user can pre-create it) when /opt/apps isn't writable; that file is removed
 *  when the shell exits (bash: chained in FRONT of any EXIT trap already set, with
 *  $? kept for it). If that write fails too, $PKH points at a path that does not
 *  exist, so the strict host check fails the git step instead of trusting some
 *  other file. No secrets. */
export const GITHUB_KNOWN_HOSTS_SETUP =
	`PKH=/opt/apps/.powder_known_hosts; PKH_TMP=; ` +
	// a mktemp file in the same dir (random name, O_EXCL), never a fixed
	// `$PKH.tmp` another writer of /opt/apps could pre-create or race; removed on failure.
	`if ! { PKH_T=$(mktemp "$PKH.XXXXXX") && { { printf '%s\\n' ${GITHUB_KNOWN_HOSTS.map((l) => shq(l)).join(' ')} > "$PKH_T" && mv -f "$PKH_T" "$PKH"; } || { rm -f "$PKH_T"; false; }; }; } 2>/dev/null; then ` +
	`if ! { PKH=$(mktemp) && PKH_TMP=$PKH && printf '%s\\n' ${GITHUB_KNOWN_HOSTS.map((l) => shq(l)).join(' ')} > "$PKH"; }; then ` +
	`echo "powder: could not write a known_hosts file for github.com, git over ssh will fail" >&2; PKH=/nonexistent/.powder_known_hosts_unwritable; fi; ` +
	// remove the fallback file on exit. The shell's own EXIT trap (set earlier:
	// cleanup, __POWDER_FAIL__ marker) is kept: `trap -p` gives it shell-quoted,
	// and it runs after the rm with the original exit status in $? (the
	// `if (exit rc)` sets $? for either branch without tripping set -e). Without
	// bash (no `trap -p`) the file is left rather than clobbering a trap.
	`if [ -n "$PKH_TMP" ] && [ -n "\${BASH_VERSION:-}" ]; then ` +
	`__pkh_prev=$(trap -p EXIT); __pkh_prev=\${__pkh_prev#"trap -- "}; __pkh_prev=\${__pkh_prev%" EXIT"}; eval "__pkh_prev=\${__pkh_prev:-''}"; __pkh_prev=\${__pkh_prev:-:}; ` +
	// the path is fixed into the trap (printf %q), so a second setup in the same
	// script chains its own file instead of replacing the first one's
	`trap "__pkh_rc=\\$?; rm -f -- $(printf %q "$PKH_TMP"); if (exit \\$__pkh_rc); then\n$__pkh_prev\nelse\n$__pkh_prev\nfi" EXIT; fi; fi; `

/** ssh options for deploy-key git traffic: strict check against $PKH. */
export const GIT_SSH_HOSTKEY_OPTS = `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=$PKH`

/**
 * Workdir-layout sync tail (app dir IS the git checkout, no src/). `middle`
 * is the fetch/resolve/checkout/reset chain, each piece ending in `&& `. The chain
 * is bracketed by SYNC_OK so a failed fetch (or checkout/reset) FAILS the deploy:
 * joining the compose restore with `;` would restart the `&&` chain and let the
 * build run on stale code with rc=0. docker-compose.yml is
 * restored from CP_KEEP on success AND failure.
 */
/** Compose files of a workdir-layout app, relative to the workdir: always
 *  docker-compose.yml, plus every other `-f` file (container config_files) that
 *  lives under the workdir. powder's override (outside the workdir) and unsafe
 *  names are skipped. Pure. */
export function workdirComposeFiles(workingDir: string, composeFiles: string[] = []): string[] {
	const base = `${workingDir.replace(/\/+$/, '')}/`
	const out = ['docker-compose.yml']
	for (const f of composeFiles) {
		if (!f.startsWith(base)) continue
		const rel = f.slice(base.length)
		if (
			!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rel) ||
			rel.split('/').includes('..') ||
			rel.split('/').pop() === 'docker-compose.powder.yml'
		)
			continue
		if (!out.includes(rel)) out.push(rel)
	}
	return out
}

export function workdirSyncShell(
	workingDir: string,
	middle: string,
	composeFiles: string[] = [],
	/** enforce: refuse a tracked extra compose file; default (warn): one WARN line, the repo copy wins. */
	guard: { enforce?: boolean; app?: string } = {},
): string {
	const g = gitCmd(shq(workingDir))
	const files = workdirComposeFiles(workingDir, composeFiles)
	const app = (guard.app ?? 'app').replace(/[^A-Za-z0-9._-]/g, '_')
	const extra = files.filter((f) => f !== 'docker-compose.yml')
	const onTracked = guard.enforce
		? `echo "deploy: refusing, the runtime compose file $CP_F is tracked by the repo: a git sync replaces it with the repo's copy. Untrack it (git rm --cached) or move it out of the checkout."; exit 1; `
		: `echo "[compose-guard] WARN ${app} tracked_compose $CP_F"; CP_SKIP="$CP_SKIP$CP_F "; `
	return (
		`  SYNC_OK=no; ` +
		// every UNTRACKED runtime compose file is preserved across the reset
		// (not only docker-compose.yml). An EXTRA compose file the repo tracks keeps the old
		// behavior (the repo copy wins; apps like a tracked docker-compose.prod.yml rely on
		// it) with a WARN line; enforce mode (POWDER_COMPOSE_GUARD=enforce) refuses it.
		// docker-compose.yml itself is tracked by design in this layout (preserved + the
		// compose-drift warning below).
		`  CP_SKIP=" "; ` +
		(extra.length
			? `  for CP_F in ${extra.map(shq).join(' ')}; do if [ -n "$(${g} ls-files -- "$CP_F" 2>/dev/null)" ]; then ${onTracked}fi; done; `
			: '') +
		`  CP_KEEP=$(mktemp -d) && (for CP_F in ${files.map(shq).join(' ')}; do case "$CP_SKIP" in *" $CP_F "*) continue;; esac; if [ -f "$CP_F" ] && [ ! -L "$CP_F" ]; then mkdir -p "$CP_KEEP/$(dirname "$CP_F")" && cp -f "$CP_F" "$CP_KEEP/$CP_F" 2>/dev/null || true; fi; done) && ` +
		middle +
		`  (${g} branch --set-upstream-to="origin/$BR" "$BR" >/dev/null 2>&1 || true) && SYNC_OK=yes; ` +
		// A repo-controlled symlink must never be written through. ONE
		// authority (repoSymlinkGuardShell) removes every tracked link that is absolute,
		// escapes the checkout, or carries a powder-owned name, and the deploy is refused
		// after. Only links the REPO tracks (index mode 120000) count; an operator-made
		// untracked link (e.g. .env -> /opt/apps/x.env) is left alone. The compose files are
		// ALWAYS restored (rm -f + mv replaces a link instead of following it), then we refuse.
		`  ${repoSymlinkGuardShell(workingDir)}; SYM_RC=$?; ` +
		`  (for CP_F in ${files.map(shq).join(' ')}; do if [ -s "$CP_KEEP/$CP_F" ]; then mkdir -p "$(dirname "$CP_F")" && T=$(mktemp -p "$(dirname "$CP_F")" .dc.XXXXXX) && cp -f "$CP_KEEP/$CP_F" "$T" && { ${atomicWriteShellRaw('"$CP_F"', '"$T"')}; }; fi; done); rm -rf "$CP_KEEP"; ` +
		`  if [ "$SYM_RC" != "0" ]; then echo "deploy: refusing, the repo tracks hostile symlink(s) (removed above; repo-controlled links to the host or to powder-owned names are not allowed)"; exit 1; fi; ` +
		`  if [ "$SYNC_OK" != "yes" ]; then echo "deploy: git sync of the workdir FAILED (fetch/checkout/reset): refusing to build, because the source on disk is NOT what GitHub has. Fix the deploy key at "${shq(`${workingDir}/.deploy-key`)}" or the repo remote, then redeploy."; exit 1; fi; ` +
		`  echo "[sync] workdir now at origin/$BR (runtime compose preserved)" && `
	)
}

/** Shell fragment (a brace group, safe inside an && chain) that sets BR (the
 *  branch to deploy) and TARGET (what to check out: the pinned sha, else
 *  origin/$BR). Assumes `git fetch origin` already ran. */
export function gitResolveTarget(
	safeDir: string,
	branch: string | null,
	sha: string | null,
	strictSha: boolean,
	/** The last successfully deployed commit from the DB. Used as the ancestry
	 *  base when the server has no usable HEAD (empty CUR), so a replayed ancestor sha
	 *  is not accepted just because the checkout is empty. */
	baseSha: string | null = null,
): string {
	const g = gitCmd(safeDir)
	const base = baseSha && /^[0-9a-f]{40}$/.test(baseSha) ? baseSha : null
	const shaPart = sha
		? `SHA=${shq(sha)}; ` +
			`if ${g} cat-file -e "$SHA^{commit}" 2>/dev/null || retry ${g} fetch origin "$SHA" >/dev/null 2>&1; then ` +
			(strictSha
				? `TARGET="$SHA"; echo "[sync] pinned to commit $SHA"; `
				: // a webhook sha is only honoured when it is on the origin/$BR
					// history AND moves forward from what is deployed now; otherwise a
					// replayed old (signed) push would roll the app back to an old commit.
					`CUR=$(${g} rev-parse -q --verify "HEAD^{commit}" 2>/dev/null || true); ` +
					(base
						? `if [ -z "$CUR" ]; then if ${g} cat-file -e "${base}^{commit}" 2>/dev/null || retry ${g} fetch origin "${base}" >/dev/null 2>&1; then CUR="${base}"; echo "[sync] no local HEAD: using the last deployed commit ${base} as the ancestry base"; fi; fi; `
						: '') +
					`if ${g} merge-base --is-ancestor "$SHA" "origin/$BR" 2>/dev/null && { [ -z "$CUR" ] || ${g} merge-base --is-ancestor "$CUR" "$SHA" 2>/dev/null; }; then ` +
					`TARGET="$SHA"; echo "[sync] pinned to commit $SHA"; ` +
					`else echo "[sync] requested sha not on branch head path, deploying HEAD"; fi; `) +
			`else ` +
			(strictSha
				? `echo "deploy: commit $SHA (built on the builder) is not fetchable here: refusing to sync a different commit than the image was built from"; SHA_FAIL=1; `
				: `echo "[sync] WARNING: pushed commit $SHA is not fetchable (force-pushed away?) - building origin/$BR instead"; `) +
			`fi; `
		: ''
	return (
		`{ SHA_FAIL=''; BR=${shq(branch ?? '')}; ` +
		`if [ -n "$BR" ] && ! ${g} show-ref --verify --quiet "refs/remotes/origin/$BR"; then echo "[sync] WARNING: configured branch '$BR' does not exist on origin - falling back to the remote default branch"; BR=""; fi; ` +
		`if [ -z "$BR" ]; then ` +
		`BR=$(${g} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'); ` +
		`if [ -z "$BR" ]; then ${g} remote set-head origin -a >/dev/null 2>&1 || true; BR=$(${g} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'); fi; ` +
		`if [ -z "$BR" ]; then if ${g} show-ref --verify --quiet refs/remotes/origin/main; then BR=main; elif ${g} show-ref --verify --quiet refs/remotes/origin/master; then BR=master; else BR=main; fi; fi; ` +
		`fi; ` +
		`TARGET="origin/$BR"; ` +
		shaPart +
		// one commit for the pre-checkout link check and the checkout: a ref such as
		// origin/$BR is resolved to its sha ONCE here (nothing can move it in between).
		`if [ -z "$SHA_FAIL" ]; then TARGET=$(${g} rev-parse -q --verify "$TARGET^{commit}" 2>/dev/null) && [ -n "$TARGET" ] || { echo "deploy: cannot resolve the sync target to a commit"; SHA_FAIL=1; }; fi; ` +
		`[ -z "$SHA_FAIL" ]; } && `
	)
}
