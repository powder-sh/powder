import { OVERRIDE_FILE, isPowderTempComposeFile } from './compose-override'
import { ALL_PROFILES } from './deploy/compose-hash'
import { COMPOSE_JSON_MOUNTS_AWK, composeRawGuardShell } from './deploy/fragments'
import { gitHardenShellFunctions } from './git-harden'
import { shq } from './shell'

// ONE pre-checkout authority for the symlinks a sync is about to put on disk.
//
// docker resolves a bind source (and a compose secret / config `file:`, and a named
// volume's bind `device`) again every time it STARTS a container, restarts included.
// So the moment a git checkout turns a bind source in the work tree (or a folder above
// it) into a symlink, a container that exits and is restarted by its restart policy
// mounts the link target: host `/`, or a writable `.git`. The post-checkout symlink
// guard (repo-symlinks.ts) and the compose guards run only after the checkout, and the
// window between is the attacker's (large blobs stretch it). This check runs BEFORE any
// checkout / reset / clone move changes the work tree, reads the TARGET commit's tree
// with the hardened git wrapper (`ls-tree -r -z`, `cat-file blob`), and refuses the
// sync, leaving the work tree untouched, when the target tracks a symlink (mode 120000)
//   (i)  whose path equals, or is a folder above, a bind / secret / config `file:` /
//        volume device source under the checkout: of every container on the server (any
//        state, `docker inspect`), every named volume's `device`, the app's current
//        compose config (all services, all profiles; uninterpolated and interpolated)
//        and the target commit's copy of every compose file the app runs that lives in
//        the checkout;
//   (ii) whose target is absolute, or resolves (lexically from the link's folder,
//        following the target tree's other links, at most 40 hops) to the checkout root
//        itself, outside it, or into its `.git`; or whose path or target holds a control
//        character.
// Self-deploy and the builder clone run (ii) only. The post-checkout guard stays.
// Guard test: __tests__/target-links.test.ts (real git, real bash).

/** awk (mawk-safe): input lines `L\t<path>\t<target>` (every link of the target tree)
 *  and `S\t<path>` (a mount source relative to the checkout root). Prints one
 *  `<reason>` line per refusal; exit 1 when there is one. */
const TARGET_LINK_AWK = String.raw`
BEGIN { FS = "\t"; rc = 0 }
$1 == "L" { link[$2] = $3; order[++nl] = $2; next }
$1 == "S" { s = norm($2); if (s != "!" && s != "") src[++ns] = s; next }
function norm(p,   rest, k, c, sp, st, i, out) {
  rest = p; sp = 0
  while (rest != "") {
    k = index(rest, "/")
    if (k == 0) { c = rest; rest = "" } else { c = substr(rest, 1, k - 1); rest = substr(rest, k + 1) }
    if (c == "" || c == ".") continue
    if (c == "..") { if (sp == 0) return "!"; sp--; continue }
    st[++sp] = c
  }
  out = ""; for (i = 1; i <= sp; i++) out = (i == 1) ? st[i] : out "/" st[i]
  return out
}
function resolve(p,   dir, rest, k, c, sp, st, i, cur, hops, lt) {
  dir = p; if (sub(/\/[^\/]*$/, "", dir) == 0) dir = ""
  rest = link[p]
  if (rest ~ /^\//) return "!an absolute path"
  if (dir != "") rest = dir "/" rest
  sp = 0; hops = 0
  while (rest != "") {
    k = index(rest, "/")
    if (k == 0) { c = rest; rest = "" } else { c = substr(rest, 1, k - 1); rest = substr(rest, k + 1) }
    if (c == "" || c == ".") continue
    if (c == "..") { if (sp == 0) return "!outside the repository"; sp--; continue }
    st[++sp] = c
    cur = st[1]; for (i = 2; i <= sp; i++) cur = cur "/" st[i]
    if (cur in link) {
      if (++hops > 40) return "!a link loop (more than 40 hops)"
      lt = link[cur]
      if (lt ~ /^\//) return "!an absolute path (through " cur ")"
      sp--
      rest = (rest == "") ? lt : lt "/" rest
    }
  }
  cur = ""; for (i = 1; i <= sp; i++) cur = (i == 1) ? st[i] : cur "/" st[i]
  return cur
}
END {
  for (i = 1; i <= nl; i++) {
    p = order[i]; r = resolve(p)
    if (r ~ /^!/) { print "the symlink " p " -> " link[p] " points to " substr(r, 2); rc = 1 }
    else if (r == "") { print "the symlink " p " -> " link[p] " points to the repository root"; rc = 1 }
    else if (r == ".git" || index(r, ".git/") == 1) { print "the symlink " p " -> " link[p] " points into .git"; rc = 1 }
  }
  for (j = 1; j <= ns; j++)
    for (i = 1; i <= nl; i++) {
      p = order[i]
      if (src[j] == p || index(src[j], p "/") == 1) {
        print "the symlink " p " -> " link[p] " replaces " (src[j] == p ? "" : "a folder above ") "the mount source " src[j] " (docker mounts the link target when a container restarts)"
        rc = 1
      }
    }
  exit rc
}
`

/** awk (mawk-safe, LC_ALL=C): read `git cat-file --batch` output (no NUL in it:
 *  the caller refuses one first) for the oids in file `of`, in that order, with the link
 *  paths in file `pf` (same order). Appends `L\t<path>\t<target>` to file `lf` per link;
 *  prints a refusal line and exits 1 for an empty target or one with a control character;
 *  prints `cannot read ...` and exits 2 when the output does not match the oids asked. */
const TARGET_LINK_BATCH_AWK = String.raw`
BEGIN { rc = 0; for (c = 1; c < 32; c++) ctl = ctl sprintf("%c", c); ctl = ctl sprintf("%c", 127) }
function die(m) { print m; rc = 2; exit 2 }
function hasctl(s,   i) { for (i = 1; i <= length(s); i++) if (index(ctl, substr(s, i, 1)) > 0) return 1; return 0 }
{
  if ((getline want < of) <= 0 || (getline p < pf) <= 0) die("cannot read the symlink targets (more objects than asked)")
  n = split($0, h, " ")
  if (n != 3 || h[1] != want || h[2] != "blob" || h[3] !~ /^[0-9]+$/) die("cannot read the symlink " p)
  size = h[3] + 0; t = ""; got = -1
  while (got < size) {
    if ((getline line) <= 0) die("cannot read the symlink " p)
    if (got < 0) { t = line; got = length(line) } else { t = t "\n" line; got += 1 + length(line) }
  }
  if (got != size) die("cannot read the symlink " p)
  if (size == 0 || hasctl(t)) { print "the symlink " p " has an empty target or one with a control character"; rc = 1; next }
  printf "L\t%s\t%s\n", p, t >> lf
}
END {
  if (rc == 2) exit 2
  if ((getline want < of) > 0) { print "cannot read the symlink targets (fewer objects than asked)"; exit 2 }
  exit rc
}
`

// bash, run as `bash -c <fns + this> _ <gitdir> <root> <target> <binds 0|1>`; stdin =
// absolute mount sources, one per line (read only when binds = 1).
const TARGET_LINK_SCRIPT = String.raw`
dir="$1"; root="$2"; target="$3"; binds="$4"
LC_ALL=C; export LC_ALL
tmp=$(mktemp -d) || { echo "cannot create a temp dir"; exit 1; }
trap 'rm -rf "$tmp"' EXIT
if [ "$binds" = 1 ]; then cat > "$tmp/srcs"; else : > "$tmp/srcs"; fi
if ! powder_git -C "$dir" -c safe.directory="$dir" ls-tree -r -z --full-tree "$target" > "$tmp/tree"; then echo "cannot list the tree of the target commit"; exit 1; fi
ctl() { [ "$(LC_ALL=C tr -d ' -~\200-\377' | wc -c | tr -d ' ')" != 0 ]; }
: > "$tmp/in"; : > "$tmp/oids"; : > "$tmp/paths"; bad=0
while IFS= read -r -d '' ent; do
  meta=%{ent%%$'\t'*}; p=%{ent#*$'\t'}
  case "$meta" in 120000\ *) ;; *) continue ;; esac
  oid=%{meta##* }
  case "$p" in *[[:cntrl:]]*) echo "a tracked symlink path holds a control character"; bad=1; continue ;; esac
  case "$oid" in *[!0-9a-f]*|'') echo "cannot read the symlink $p"; exit 1 ;; esac
  printf '%s\n' "$oid" >> "$tmp/oids"; printf '%s\n' "$p" >> "$tmp/paths"
done < "$tmp/tree"
if [ -s "$tmp/oids" ]; then
  powder_git -C "$dir" -c safe.directory="$dir" cat-file --batch < "$tmp/oids" > "$tmp/blobs" || { echo "cannot read the symlink targets of the target commit"; exit 1; }
  if [ "$(LC_ALL=C tr -cd '\000' < "$tmp/blobs" | wc -c | tr -d ' ')" != 0 ]; then echo "a tracked symlink target holds a control character (NUL)"; exit 1; fi
  LC_ALL=C awk -v pf="$tmp/paths" -v of="$tmp/oids" -v lf="$tmp/in" "$TL_BATCH_AWK" < "$tmp/blobs"; brc=$?
  [ "$brc" = 0 ] || [ "$brc" = 1 ] || exit 1
  [ "$brc" = 0 ] || bad=1
fi
root=$(printf '%s' "$root" | tr -s /); root=%{root%/}
rr=$(readlink -f -- "$root" 2>/dev/null || true); [ -n "$rr" ] || rr=$root
while IFS= read -r s; do
  case "$s" in /*) ;; *) continue ;; esac
  if printf '%s' "$s" | ctl; then continue; fi
  s=$(printf '%s' "$s" | tr -s /); s=%{s%/}
  sr=$(readlink -f -- "$s" 2>/dev/null || true)
  for x in "$s" "$sr"; do [ -n "$x" ] || continue; for r in "$root" "$rr"; do case "$x" in "$r"/*) printf 'S\t%s\n' "%{x#"$r"/}" >> "$tmp/in"; break ;; esac; done; done
done < "$tmp/srcs"
LC_ALL=C awk "$TL_AWK" < "$tmp/in" || bad=1
exit $bad
`.replace(/%\{/g, '${')

/** Shell (one line, `&&`-chainable, exits the script on failure): set TL_SRCS to every
 *  mount source docker re-resolves on a container start: the bind sources of EVERY
 *  container on the server (any state), every named volume's `device`, and (when `cf`,
 *  the compose -f args, is given) the bind / secret / config file / volume device
 *  paths of the app's current compose config, all profiles, uninterpolated and
 *  interpolated. Run it before the sync, after the env file guard. */
export function targetLinkSourcesShell(cf: string | null): string {
	const awk = shq(COMPOSE_JSON_MOUNTS_AWK)
	const noCfg = `echo "deploy: refusing, cannot read the compose config to find the mount sources the git sync must not turn into symlinks"; exit 1;`
	const fromCfg = (v: string) => `printf '%s\\n' "$${v}" | LC_ALL=C awk ${awk} | sed -n 's/^[BCSO] //p'; `
	return (
		`{ TL_IDS=$(docker ps -aq 2>/dev/null) || { echo "deploy: refusing, cannot list the containers on this server (the git sync check needs their mount sources)"; exit 1; }; ${cf
			? `TL_J1=$(docker compose ${cf} ${ALL_PROFILES} config --no-interpolate --format json 2>/dev/null) || { ${noCfg} }; ` +
				`TL_J2=$(docker compose ${cf} ${ALL_PROFILES} config --format json 2>/dev/null) || { ${noCfg} }; `
			: ''}TL_SRCS=$( { printf '%s\\n' "$TL_IDS" | grep . | xargs -r docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' 2>/dev/null || true; docker volume ls -q 2>/dev/null | xargs -r docker volume inspect --format '{{if .Options}}{{with index .Options "device"}}{{println .}}{{end}}{{end}}' 2>/dev/null || true; ${cf ? fromCfg('TL_J1') + fromCfg('TL_J2') : ''}} ); } && `
	)
}

const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/

/** The compose files (absolute, in -f order) the target-commit check reads from the
 *  target tree: those under `root`, minus `preserved` (paths relative to root that the
 *  sync keeps as they are, the workdir layout's runtime docker-compose.yml), minus
 *  powder's own override and temp files. Pure. */
export function inTreeComposeFiles(root: string, files: string[], preserved: string[] = []): string[] {
	const r = `${root.replace(/\/+$/, '')}/`
	return files.filter((f) => {
		if (!f.startsWith(r) || !PLAIN_PATH.test(f) || f.split('/').includes('..')) return false
		const name = f.split('/').pop() ?? ''
		if (name === OVERRIDE_FILE || isPowderTempComposeFile(f)) return false
		return !preserved.includes(f.slice(r.length))
	})
}

/** Shell (a `{ ...; }` group; exits the script with a refusal line on a finding):
 *  the pre-checkout symlink check of the commit `target` (a shell word such as
 *  "$TARGET") in the checkout at `dir`. `root` is where the tree will live (default
 *  `dir`; differs for a clone into a temp dir that is then moved in place). With
 *  `binds`, rule (i) uses $TL_SRCS (targetLinkSourcesShell) plus, when `compose` is
 *  given, the mount sources of the target commit's copy of every compose file of the
 *  app under the checkout. Needs gitHardenShellFunctions in the calling shell only for
 *  the compose part; the check itself defines them. */
export function targetLinkGuardShell(p: {
	dir: string
	root?: string
	target: string
	binds: boolean
	/** All -f files of the app (absolute, in order) and the paths relative to the
	 *  checkout root the sync preserves. */
	compose?: { files: string[]; preserved?: string[] }
	/** Prefix of the refusal line. */
	who?: string
}): string {
	const root = (p.root ?? p.dir).replace(/\/+$/, '') || '/'
	const who = p.who ?? 'deploy'
	const script = gitHardenShellFunctions() + TARGET_LINK_SCRIPT
	const run = `TL_AWK=${shq(TARGET_LINK_AWK)} TL_BATCH_AWK=${shq(TARGET_LINK_BATCH_AWK)} bash -c ${shq(script)} _ ${shq(p.dir)} ${shq(root)} ${p.target} ${p.binds ? 1 : 0}`
	const refuse = `{ echo "${who}: refusing the git sync, the target commit tracks a symlink the sync must not put on disk (the work tree was left as it is):"; printf '%s\\n' "$TL_OUT" | head -n 20 | sed 's/^/  /'; exit 1; }`
	let tree = ''
	const files = p.compose?.files ?? []
	const inTree = p.binds ? inTreeComposeFiles(root, files, p.compose?.preserved ?? []) : []
	if (inTree.length && files.every((f) => PLAIN_PATH.test(f))) {
		const g = `powder_git -C ${shq(p.dir)} -c safe.directory=${shq(p.dir)}`
		const projectDir = (files[0] ?? '').replace(/\/[^/]*$/, '') || '/'
		const parts = files
			.filter((f) => f.split('/').pop() !== OVERRIDE_FILE && !isPowderTempComposeFile(f))
			.map((f) => {
				if (!inTree.includes(f)) return `TL_CF="$TL_CF -f ${f}"; `
				const rel = f.slice(root.length + 1)
				const relDir = rel.includes('/') ? rel.replace(/\/[^/]*$/, '') : '.'
				return (
					`if ${g} cat-file -e ${p.target}:${shq(rel)} 2>/dev/null; then ` +
					`mkdir -p "$TL_T"/${shq(relDir)} && ${g} cat-file blob ${p.target}:${shq(rel)} > "$TL_T"/${shq(rel)} || { TL_OUT="cannot read ${rel} at the target commit"; ${refuse}; }; ` +
					`TL_CF="$TL_CF -f $TL_T/${rel}"; TL_SUB=1; fi; `
				)
			})
			.join('')
		tree =
			`TL_T=$(mktemp -d) || { TL_OUT="cannot create a temp dir"; ${refuse}; }; TL_CF=""; TL_SUB=0; ${parts}if [ "$TL_SUB" = 1 ]; then if ! TL_OUT=$(${composeRawGuardShell('$TL_CF')} 2>&1); then rm -rf "$TL_T"; ${refuse}; fi; if ! TL_J=$(docker compose $TL_CF --project-directory ${shq(projectDir)} ${ALL_PROFILES} config --no-interpolate --format json 2>/dev/null); then rm -rf "$TL_T"; TL_OUT="the compose files at the target commit cannot be read (docker compose config failed)"; ${refuse}; fi; TL_SRCS2=$(printf '%s\\n' "$TL_J" | LC_ALL=C awk ${shq(COMPOSE_JSON_MOUNTS_AWK)} | sed -n 's/^[BCSO] //p'); fi; rm -rf "$TL_T"; `
	}
	const input = p.binds ? `printf '%s\\n%s\\n' "\${TL_SRCS:-}" "\${TL_SRCS2:-}" | ` : ''
	return `{ TL_SRCS2=""; ${tree}if ! TL_OUT=$(${input}${run} 2>&1); then ${refuse}; fi; [ -z "$TL_OUT" ] || printf '%s\\n' "$TL_OUT"; }`
}
