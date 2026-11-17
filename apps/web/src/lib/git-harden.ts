import { shq } from './shell'

// ONE authority for every git command powder runs on a server. powder runs git as
// root inside checkouts that an app container may be able to write (a compose bind of
// ./src, ./.git or the app dir). Git reads the repository's own .git/config, and many
// keys in it run programs: core.fsmonitor, core.hooksPath, core.sshCommand,
// core.askPass, core.alternateRefsCommand, credential helpers, url/protocol tricks
// (ext::, file transport with remote.<n>.uploadpack), filter drivers (smudge runs on
// checkout), diff drivers, include.path pulling in more of the same. A container that
// can write .git/config would get root on the host at the next deploy.
//
// Chosen design (safe for existing apps, no change to the checkout layout or to build contexts):
//   1. Every repo command goes through the shell function `powder_git` (defined by
//      gitHardenShellFunctions). It finds the checkout top itself (a plain `.git`
//      DIRECTORY; a .git symlink or gitfile is refused) and runs git with an EXPLICIT
//      --git-dir/--work-tree and GIT_COMMON_DIR, so neither a planted `commondir` file,
//      a gitfile nor core.worktree in the repo config can redirect git elsewhere.
//   2. Command-line `-c` (highest precedence, wins over repo config) pins every fixed-
//      name key that executes something: hooks, fsmonitor, askpass, sshCommand,
//      alternateRefsCommand, pager, protocol policy (only https/http/ssh; ext, file and
//      git:// never), submodule recursion, auto gc/maintenance (gc.recentObjectsHook).
//   3. Keys whose NAME is chosen by the repo (filter.<x>.*, diff.<x>.*, merge.<x>.*,
//      credential.<url>.helper, lfs.customtransfer.<x>.path, include*) cannot be pinned
//      with `-c`, so the repo-local config is untrusted: right before EVERY git call it
//      is scrubbed to an allow-list of data keys (core format/checkout settings, remote,
//      branch, extensions, lfs data, http headers, url rewrites). A value-checked key
//      (core.sshCommand, credential helpers, the stock git-lfs filter) is kept only in a
//      fixed safe form. Anything else is removed (logged on stderr), and git is not run
//      when a removal fails.
//   Global and system config (/root/.gitconfig, /etc/gitconfig) stay as they are: they
//   are root-owned host files no app can bind (compose guard), and some servers rely on
//   them (credential helpers, ssh aliases), so GIT_CONFIG_GLOBAL/NOSYSTEM are not set.
//   uploadpack.packObjectsHook is honoured by git only from protected (system, global,
//   command line) config and only runs for local upload-pack, which file:// = never
//   rules out. diff.external is removed by the scrub and the one diff powder runs
//   passes --no-ext-diff --no-textconv.
// Residual: a container that can write .git races the scrub (it would have to rewrite
// the config between the scrub and git reading it, a window of one process start). Only
// apps whose compose binds the checkout can do that, and that bind is a high compose
// finding (compose-check.ts protectedPaths), refused on any structural compose change.
// Why not a gitdir outside the app dir: existing build contexts contain src/.git (some
// Dockerfiles run git), so moving it would change unchanged apps' builds.
//
// Guard test: __tests__/git-harden.test.ts (runs real git against a hostile config,
// and fails when generated shell runs a bare `git` outside this module).

/** Repo-local config keys the scrub keeps (git lists section and key in lower case). */
const ALLOW_KEYS = [
	'core\\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|sparsecheckout|sparsecheckoutcone|compression|loosecompression|quotepath|trustctime|checkstat|splitindex|commitgraph|multipackindex|bigfilethreshold|abbrev|preloadindex|packedgitlimit|packedgitwindowsize|deltabasecachelimit|warnambiguousrefs|sshcommand)',
	'extensions\\.(objectformat|compatobjectformat|partialclone|refstorage|preciousobjects|noop)',
	'remote\\..+\\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|promisor|partialclonefilter|skipdefaultupdate|skipfetchall)',
	'branch\\..+\\.(remote|pushremote|merge|rebase|description)',
	'url\\..+\\.(insteadof|pushinsteadof)',
	'credential\\.(.+\\.)?(helper|username|usehttppath)',
	'http\\.(.+\\.)?(extraheader|sslverify|version|postbuffer|lowspeedlimit|lowspeedtime|emptyauth)',
	'lfs\\.(url|pushurl|repositoryformatversion|locksverify|fetchinclude|fetchexclude|allowincompletepush|concurrenttransfers|.+\\.access|.+\\.locksverify)',
	'filter\\.lfs\\.(clean|smudge|process|required)',
	'submodule\\..+\\.(url|active|branch)',
	'user\\.(name|email)',
	'init\\.defaultbranch',
	'pull\\.(rebase|ff)',
	'fetch\\.(prune|prunetags|parallel|negotiationalgorithm|writecommitgraph)',
	'gc\\.(auto|autodetach|autopacklimit)',
	'index\\.(version|skiphash|threads|sparse)',
	'feature\\.(manyfiles|experimental)',
	'protocol\\.version',
	'transfer\\.(fsckobjects|unpacklimit)',
	'advice\\.[a-z0-9-]+',
	'color\\..+',
	'status\\.(showuntrackedfiles|branch|short)',
]
const GIT_CONFIG_ALLOW_RE = `^(${ALLOW_KEYS.join('|')})$`

/** Kept keys whose VALUE can run a program: the forms that cannot. */
const VALUE_CHECKED_RE = '^(core\\.sshcommand|credential\\..*helper|filter\\.lfs\\..*)$'
/** ssh with a key file, a few -o host-key/identity options and a port. No -F, no
 *  ProxyCommand/LocalCommand, no quoting. */
const GIT_SSH_OK_RE =
	'^ssh( +-i +[A-Za-z0-9_./~-]+| +-o *(IdentitiesOnly|StrictHostKeyChecking|UserKnownHostsFile|BatchMode|IdentityFile|ConnectTimeout)=[A-Za-z0-9_./~-]+| +-p +[0-9]+)*$'
// bare `store` / `cache` only; a --file / --socket argument points git at a path
// the repo chose. Global helpers (root's own config) are not touched by the scrub.
const HELPER_OK_RE = '^(store|cache)?$'
/** The stock git-lfs filter lines (`git lfs install --local`). */
const LFS_OK_RE =
	'^(git-lfs (clean|smudge)( --skip)? -- %f|git-lfs filter-process( --skip)?|true|false)$'

/** Command-line overrides for every fixed-name key that runs a program. Command-line
 *  config wins over the repo's (git config precedence: system < global < local < -c). */
export const GIT_HARDEN_FLAGS = [
	'-c core.hooksPath=/dev/null',
	// Empty, not "false": git < 2.36 reads core.fsmonitor as a hook PATH ("false" would
	// run /bin/false); empty disables it in every version.
	'-c core.fsmonitor=',
	'-c core.untrackedCache=false',
	'-c core.askPass=',
	'-c core.pager=cat',
	'-c core.alternateRefsCommand=true',
	'-c protocol.allow=never',
	'-c protocol.https.allow=always',
	'-c protocol.http.allow=always',
	'-c protocol.ssh.allow=always',
	'-c protocol.ext.allow=never',
	'-c protocol.file.allow=never',
	// git:// is also the only transport that reads core.gitProxy, where the FIRST match
	// wins (so -c could not override a repo value): never use it.
	'-c protocol.git.allow=never',
	'-c submodule.recurse=false',
	// status / diff otherwise look INTO a populated submodule, and that child
	// git reads .git/modules/<name>/config, which the scrub does not touch (its filter
	// drivers would run). powder never needs submodule state (it never runs
	// `submodule update`), so every submodule is ignored.
	'-c diff.ignoreSubmodules=all',
	'-c status.submoduleSummary=false',
	'-c fetch.recurseSubmodules=false',
	'-c gc.auto=0',
	'-c maintenance.auto=false',
].join(' ')

/** The repo-command entry point the generated shell calls (`powder_git [-C dir] args`). */
const POWDER_GIT = 'powder_git'
/** For repo-less commands only (clone, ls-remote <url>) from a powder-chosen cwd. */
export const POWDER_GIT_NOREPO = 'powder_git_norepo'

/** `powder_git [-C <dir>] -c safe.directory=<safeDir>`, the prefix every repo command
 *  uses. `safeDir` is an already-quoted shell word. */
export function gitCmd(safeDir: string, dir?: string): string {
	return `${POWDER_GIT}${dir ? ` -C ${dir}` : ''} -c safe.directory=${safeDir}`
}

/** Shell (POSIX sh and bash, one line, ends with `; `): defines __powder_git_scrub,
 *  powder_git and powder_git_norepo. Every script that calls them includes this. */
export function gitHardenShellFunctions(): string {
	const cfg = '(cd / && command git config --file "$__pgc"'
	return [
		// $1 = the .git directory. Sets __pgssh (the ssh command git may use).
		'__powder_git_scrub() { ',
		`__pgc="$1/config"; `,
		'__pgssh=$(cd / && command git config --get core.sshCommand 2>/dev/null | tail -n 1 || true); ',
		`printf '%s' "$__pgssh" | grep -qE ${shq(GIT_SSH_OK_RE)} || __pgssh=ssh; `,
		`if [ -L "$__pgc" ]; then echo "powder: refusing to run git: $__pgc is a symlink" >&2; return 1; fi; `,
		// A main checkout never has a commondir file (only linked worktrees' private
		// gitdirs do); one planted here would move config and hooks elsewhere.
		`if [ -e "$1/commondir" ] || [ -L "$1/commondir" ]; then rm -f "$1/commondir" && echo "[git-harden] removed $1/commondir (a checkout powder syncs is never a linked worktree)" >&2 || return 1; fi; `,
		`[ -f "$__pgc" ] || return 0; `,
		`__pgnames=$( ${cfg} --name-only --list 2>/dev/null) || true); `,
		`__pgdrop=$(printf '%s\\n' "$__pgnames" | grep -v '^$' | grep -viE ${shq(GIT_CONFIG_ALLOW_RE)} || true); `,
		`__pgbadv=$(printf '%s\\n' "$__pgnames" | grep -iE ${shq(VALUE_CHECKED_RE)} | sort -u | while IFS= read -r __pgk; do `,
		`case "$__pgk" in (core.sshcommand) __pgre=${shq(GIT_SSH_OK_RE)};; (credential.*) __pgre=${shq(HELPER_OK_RE)};; (*) __pgre=${shq(LFS_OK_RE)};; esac; `,
		`if ${cfg} --get-all "$__pgk" 2>/dev/null) | grep -vqE "$__pgre"; then printf '%s\\n' "$__pgk"; fi; done || true); `,
		`__pgdrop=$(printf '%s\\n%s\\n' "$__pgdrop" "$__pgbadv" | grep -v '^$' | sort -u || true); `,
		`if [ -n "$__pgdrop" ]; then `,
		`printf '%s\\n' "$__pgdrop" | while IFS= read -r __pgk; do ${cfg} --unset-all "$__pgk" >/dev/null 2>&1) || true; done; `,
		`if printf '%s\\n' "$__pgdrop" | while IFS= read -r __pgk; do if ${cfg} --get-all "$__pgk" >/dev/null 2>&1); then echo "$__pgk"; fi; done | grep -q .; then `,
		`echo "powder: refusing to run git: could not remove untrusted keys from $__pgc" >&2; return 1; fi; `,
		`echo "[git-harden] removed repo-local git config powder does not trust from $__pgc: $(printf '%s ' $__pgdrop)" >&2; `,
		'fi; ',
		`__pgl=$( ${cfg} --get-all core.sshCommand 2>/dev/null) | tail -n 1 || true); `,
		`if [ -n "$__pgl" ] && printf '%s' "$__pgl" | grep -qE ${shq(GIT_SSH_OK_RE)}; then __pgssh=$__pgl; fi; `,
		'return 0; }; ',
		// powder_git [-C dir] <git args>: the checkout top is the nearest dir at or above
		// <dir> (default: cwd) that holds a real .git directory.
		`${POWDER_GIT}() { `,
		`__pgw=.; if [ "$1" = -C ]; then __pgw=$2; shift 2; fi; `,
		`__pgd=$(CDPATH= cd "$__pgw" 2>/dev/null && pwd) || { echo "powder: git: cannot enter $__pgw" >&2; return 128; }; `,
		'__pgt=$__pgd; ',
		'while :; do ',
		`if [ -L "$__pgt/.git" ]; then echo "powder: refusing to run git in $__pgt: .git is a symlink" >&2; return 128; fi; `,
		`if [ -d "$__pgt/.git" ]; then break; fi; `,
		`if [ -e "$__pgt/.git" ]; then echo "powder: refusing to run git in $__pgt: .git is not a directory" >&2; return 128; fi; `,
		`if [ "$__pgt" = / ]; then echo "fatal: not a git repository: $__pgd" >&2; return 128; fi; `,
		`__pgt=$(dirname "$__pgt"); `,
		'done; ',
		`__powder_git_scrub "$__pgt/.git" || return 128; `,
		`GIT_COMMON_DIR="$__pgt/.git" command git -C "$__pgd" --git-dir="$__pgt/.git" --work-tree="$__pgt" -c "core.sshCommand=$__pgssh" ${GIT_HARDEN_FLAGS} "$@"; }; `,
		`${POWDER_GIT_NOREPO}() { command git ${GIT_HARDEN_FLAGS} "$@"; }; `,
	].join('')
}
