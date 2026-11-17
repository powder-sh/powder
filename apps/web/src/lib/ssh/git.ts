import type { ServerConfig } from '../servers'
import { shq } from '../shell'
import { atomicWriteShellRaw, repoSymlinkGuardShell } from '../repo-symlinks'
import { runCommand } from './connection'
import { branchProblem, repoUrlProblem } from '../git-input'
import { POWDER_GIT_NOREPO, gitCmd, gitHardenShellFunctions } from '../git-harden'
import { targetLinkGuardShell, targetLinkSourcesShell } from '../target-links'

export { repoSymlinkGuardShell } from '../repo-symlinks'

export async function gitCloneRepo(
	server: ServerConfig,
	workingDir: string,
	repoUrl: string,
	branch: string,
	deployKeyPath: string,
): Promise<{ output: string }> {
	const bad = repoUrlProblem(repoUrl) ?? branchProblem(branch)
	if (bad) throw new Error(bad)
	// Clone into a temp dir first to avoid trashing existing files until we know the clone worked.
	// Then move existing dir aside, move clone into place.
	const tmp = `${workingDir}.clone.${Date.now()}`
	const cmd =
		`set -e; ` +
		gitHardenShellFunctions() +
		GITHUB_KNOWN_HOSTS_SETUP +
		`export GIT_SSH_COMMAND="ssh -i ${shq(deployKeyPath)} ${GIT_SSH_HOSTKEY_OPTS}"; ` +
		`mkdir -p "$(dirname ${shq(workingDir)})" && ` +
		// `--` ends option parsing: nothing positional can be read as a flag.
		`${POWDER_GIT_NOREPO} clone --branch ${shq(branch)} --depth 1 -- ${shq(repoUrl)} ${shq(tmp)} 2>&1 && ` +
		// the clone replaces the whole dir; a container binding a path in it
		// re-resolves that path on its next start. Check the cloned tree (links that
		// escape, and links over any mount source under the dir) before the move.
		`( ${targetLinkSourcesShell(null)}${targetLinkGuardShell({ dir: tmp, root: workingDir, target: 'HEAD', binds: true, who: 'clone' })} ) || { rm -rf -- ${shq(tmp)}; exit 1; } && ` +
		`if [ -d ${shq(workingDir)} ]; then ` +
		`  mv ${shq(workingDir)} ${shq(workingDir)}.before-powder.$(date +%s); ` +
		`fi && ` +
		`mv ${shq(tmp)} ${shq(workingDir)} && ` +
		`{ ${repoSymlinkGuardShell(workingDir)} || { echo "clone refused: the repo tracks hostile symlink(s) (removed)"; exit 1; }; } && ` +
		`echo "cloned to "${shq(workingDir)}`
	const { stdout, code, stderr } = await runCommand(server, cmd, 120_000)
	if (code !== 0) throw new Error(stderr || stdout || 'clone failed')
	return { output: stdout }
}

export interface GitStatus {
	isRepo: boolean
	branch: string | null
	currentSha: string | null
	upstreamSha: string | null
	dirty: boolean
}

/** A working dir safe to put inside GIT_SSH_COMMAND (git runs it through `sh -c`):
 *  absolute, plain characters only, no `..` segment. Pure. */
export function gitStatusDirOk(dir: string): boolean {
	return /^\/[A-Za-z0-9_./-]+$/.test(dir) && !dir.split('/').includes('..')
}

export async function getGitStatus(server: ServerConfig, dir: string): Promise<GitStatus> {
	// `dir` comes from a container label and ends up in GIT_SSH_COMMAND.
	if (!gitStatusDirOk(dir))
		return { isRepo: false, branch: null, currentSha: null, upstreamSha: null, dirty: false }
	// hardened git (repo-local config scrubbed, exec keys pinned).
	const g = gitCmd(shq(dir), shq(dir))
	const cmd =
		gitHardenShellFunctions() +
		// fetch with the same credentials a deploy uses (the deploy key, the
		// pinned github.com host keys), so the dashboard's ahead/behind does not depend on
		// whatever ssh command root's own git config names.
		`KEY=${shq(dir)}/.deploy-key; ` +
		`if [ -f "$KEY" ] && [ ! -L "$KEY" ]; then ${GITHUB_KNOWN_HOSTS_SETUP}export GIT_SSH_COMMAND="ssh -i $KEY ${GIT_SSH_HOSTKEY_OPTS} -o IdentitiesOnly=yes"; fi; ` +
		`if [ -d ${shq(dir)}/.git ]; then ` +
		`echo "::repo::"; ` +
		`${g} rev-parse --abbrev-ref HEAD; ` +
		`${g} rev-parse HEAD; ` +
		`${g} fetch --quiet 2>/dev/null; ` +
		`${g} rev-parse '@{u}' 2>/dev/null || echo NONE; ` +
		`${g} status --porcelain | head -1; ` +
		`else echo "::norepo::"; fi`
	const { stdout } = await runCommand(server, cmd, 20_000)
	if (!stdout.includes('::repo::')) {
		return { isRepo: false, branch: null, currentSha: null, upstreamSha: null, dirty: false }
	}
	const lines = stdout.split('\n').map((l) => l.trim())
	const start = lines.indexOf('::repo::')
	const branch = lines[start + 1] ?? null
	const currentSha = lines[start + 2] ?? null
	const upstream = lines[start + 3] ?? null
	const dirtyLine = lines[start + 4] ?? ''
	return {
		isRepo: true,
		branch,
		currentSha,
		upstreamSha: upstream === 'NONE' ? null : upstream,
		dirty: dirtyLine.length > 0,
	}
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
