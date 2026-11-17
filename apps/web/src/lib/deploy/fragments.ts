import { DFR_FOREIGN_AWK, REGISTRY_LOGIN_HOSTS_SHELL } from '../build-cache'
import { gitCmd } from '../git-harden'
import { OVERRIDE_FILE, composeStateBase, isPowderTempComposeFile, isSafeOverridePath, overridePathFor } from '../compose-override'
import { appLockDirShell, appLockPath } from '../deploy-supersede'
import type { ServerConfig } from '../servers'
import { composeProjectNameFor } from '../compose-safety'
import { shq } from '../shell'
import { SIDE_RUN_CAPS } from '../side-run'
import { runCommand } from '../ssh/connection'
import { ALL_PROFILES, composeConfigHashShell } from './compose-hash'

/** Shell fragment: take the per-app deploy flock on fd 9 (wait up to 90s). */
export function appLockShell(lock: string): string {
	return (
		appLockDirShell(lock) +
		`[ ! -L ${shq(lock)} ] || { echo "per-app lock path is a symlink, refusing"; exit 1; }; ` +
		`exec 9>${shq(lock)} || exit 1; ` +
		`flock -w 90 9 || { echo "another deploy of this app holds the lock"; exit 1; }; `
	)
}

/** `timeout` for a command that runs INSIDE `flock`: the limit is computed in the
 *  flock child, after the lock wait, from the deploy's absolute DEADLINE (a shell
 *  variable of the deploy script, passed as DL). `$(cap ...)` in the parent
 *  expanded BEFORE flock waited, so a long wait left the command a timeout that
 *  outlived the budget. Usage: `flock -w N lock <prefix> cmd args...`. */
export function childTimeoutPrefix(max: number, reserve: number): string {
	return `env DL="$DEADLINE" bash -c 'c=$((DL-$(date +%s)-${reserve})); [ "$c" -lt 1 ] && c=1; [ "$c" -gt ${max} ] && c=${max}; exec timeout "$c" "$@"' _`
}

/** Seconds between a build that failed on a next/font Google Fonts fetch and its one retry. */
export const FONT_FETCH_RETRY_DELAY_SEC = 25

/** grep -E: next/font's own fetch-failure messages (NextFontError, printed as
 *  "`next/font` error:" + message) and a request to the Google Fonts hosts
 *  failing (Turbopack wording). Validation errors (unknown font, bad weight) do
 *  not match: they never mention a fetch or the font hosts. */
const FONT_FETCH_FAIL_RE =
	'Failed to fetch font|Failed to fetch .+ from Google Fonts|(request|fetch|connect)[a-z]* .*https?://fonts\\.(googleapis|gstatic)\\.com'

/** Shell functions: `font_retry <cmd...>` runs a build command, streaming its
 *  output (2>&1) to the log and to a temp file. When the build fails AND the
 *  output carries a next/font Google Fonts fetch failure (a transient network
 *  answer at build time: the same commit builds on retry), it logs a `[retry]`
 *  line, waits FONT_FETCH_RETRY_DELAY_SEC and runs the command exactly once more.
 *  Any other failure returns the build's own exit code at once. Returns the exit
 *  code of the build (never tee's).
 *  - canRetry: shell condition checked before the retry (deploy budget left).
 *  - beforeRetry: shell command run before the retry (guards); must succeed.
 *  Two fetch-failure shapes: the messages in FONT_FETCH_FAIL_RE, and an
 *  unexpected error inside the Google loader ("An error occurred in `next/font`."
 *  plus a stack in @next/font/dist/google/, e.g. a TypeError parsing a bad
 *  fonts.googleapis.com answer). Needs bash (PIPESTATUS) and no global pipefail.
 *  The temp file name stays in $__ffo while a build runs: the EXIT traps of the
 *  deploy and builder scripts remove it when a kill (deadline TERM) ends the run. */
export function fontFetchRetryShellFunctions(canRetry = 'true', beforeRetry = ':'): string {
	return (
		`ff_sig() { grep -qE ${shq(FONT_FETCH_FAIL_RE)} "$1" 2>/dev/null || { grep -qF ${shq('An error occurred in `next/font`')} "$1" 2>/dev/null && grep -qF '@next/font/dist/google/' "$1" 2>/dev/null; }; }; ` +
		`font_retry() { ` +
		`__ffrc=0; __ffo=$(mktemp "\${TMPDIR:-/tmp}/powder-build-out.XXXXXX" 2>/dev/null) || { "$@" 2>&1 || __ffrc=$?; return $__ffrc; }; ` +
		`"$@" 2>&1 | { tee "$__ffo" || cat >/dev/null; }; __ffrc=\${PIPESTATUS[0]}; ` +
		`if [ "$__ffrc" -ne 0 ] && ff_sig "$__ffo"; then rm -f "$__ffo"; __ffo=""; ` +
		`if ${canRetry}; then ` +
		`echo "[retry] build failed (rc=$__ffrc) on a next/font Google Fonts fetch error (transient network) - retrying the build once in ${FONT_FETCH_RETRY_DELAY_SEC}s"; ` +
		`sleep ${FONT_FETCH_RETRY_DELAY_SEC}; ${beforeRetry} || return $?; __ffrc=0; "$@" 2>&1 || __ffrc=$?; ` +
		`else echo "[retry] build failed on a next/font Google Fonts fetch error, but not enough deploy budget is left to retry it"; fi; ` +
		`else rm -f "$__ffo"; __ffo=""; fi; return $__ffrc; }; `
	)
}

// awk body: print the value of a top-level key of service `svc` (-v f=image:)
// from compose text. The service indentation is taken from the first key under
// `services:` and the field indentation from the first line inside the service,
// so 2-space, 4-space and tab-free custom indents all work.
export const SERVICE_FIELD_AWK = String.raw`
function ind(s) { match(s, /^[ ]*/); return RLENGTH }
/^services:/ { in_s = 1; sind = -1; next }
/^[^ #]/ { in_s = 0; current = ""; next }
in_s && sind < 0 && /^[ ]+[A-Za-z0-9_.-]+:/ { sind = ind($0) }
in_s && sind >= 0 && ind($0) == sind && /^[ ]*[A-Za-z0-9_.-]+:/ { current = $1; sub(":", "", current); cind = -1; next }
current == svc && $0 !~ /^[ ]*(#.*)?$/ && ind($0) > sind {
  if (cind < 0) cind = ind($0)
  if (ind($0) == cind && $1 == f) { print $2; exit }
}
`

// awk body: read `docker compose config --no-interpolate --format json` (never
// YAML text: a YAML escape such as "x\ty" was read back wrong). compose prints that JSON
// with json.MarshalIndent (2 spaces, one key per line, no raw newline inside a string),
// so the layout is fixed: top-level keys at 2 spaces, services at 4, service fields at
// 6, list items at 8, env_file objects' keys at 10. Prints one line per
// service-level env_file / label_file path:
//   F <path>   a JSON string made only of [A-Za-z0-9._/-] (so it holds no escape and is
//              exactly the path compose reads)
//   BF <raw>   any other value, as compose printed it (refused by the guard)
//   E <why>    the JSON is not in the expected layout (refused by the guard)
// and, for the bind check:
//   N <name>   the compose project name
//   V <src>    the source of a service's WRITABLE bind mount (type bind, no read_only),
//              when compose printed it without a JSON escape; BV <raw> otherwise
export const COMPOSE_JSON_PATHS_AWK = String.raw`
function ind(s) { match(s, /^ */); return RLENGTH }
function val(s,   v) { v = s; sub(/^ *"[^"]*": */, "", v); sub(/,$/, "", v); return v }
function item(s,   v) { v = s; sub(/^ */, "", v); sub(/,$/, "", v); return v }
function emit(v) { if (v ~ /^"[A-Za-z0-9._\/-]+"$/) print "F " substr(v, 2, length(v) - 2); else print "BF " v }
NR == 1 && $0 == "{}" { exit }
NR == 1 { if ($0 != "{") { print "E the compose config is not in the expected JSON layout"; exit } next }
NR == 2 && $0 !~ /^  "/ { print "E the compose config is not in the expected JSON layout"; exit }
/^  "name": "[^"\\]*",?$/ { v = val($0); print "N " substr(v, 2, length(v) - 2); next }
/^  "services": \{/ { ins = 1; next }
/^  [^ ]/ { ins = 0; f = ""; next }
!ins { next }
{ i = ind($0) }
i == 4 { f = ""; next }
i == 6 && /^      [\]]/ { f = ""; next }
i == 6 && /^      "/ {
  f = ""; k = $0; sub(/^ *"/, "", k); sub(/".*$/, "", k)
  if (k != "env_file" && k != "label_file" && k != "volumes") next
  v = val($0)
  if (v == "[") { f = k; next }
  if (v == "[]" || v == "null") next
  if (k == "volumes") { print "E the volumes of a service are not in the expected JSON layout"; next }
  emit(v); next
}
f == "" { next }
f == "volumes" && i == 8 && /^        \{/ { vt = ""; vs = ""; vro = 0; next }
f == "volumes" && i == 10 && /^          "type": / { vt = val($0); next }
f == "volumes" && i == 10 && /^          "source": / { vs = val($0); next }
f == "volumes" && i == 10 && /^          "read_only": true/ { vro = 1; next }
f == "volumes" && i == 8 && /^        \}/ { if (vt == "\"bind\"" && !vro && vs != "") { if (vs ~ /^"[^"\\]*"$/) print "V " substr(vs, 2, length(vs) - 2); else print "BV " vs } next }
f == "volumes" { next }
i == 8 && /^        "/ { emit(item($0)); next }
i == 10 && /^          "path": / { emit(val($0)); next }
`

// awk body: read the same `docker compose config --format json` layout as
// COMPOSE_JSON_PATHS_AWK (2-space MarshalIndent) and print every host path compose
// (root) opens or mounts:
//   N <name>   the compose project name
//   B <path>   a service bind mount source (any mode); W <path> again when it is writable
//   C <path>   a build context, dockerfile (joined to its context when relative) or
//              additional_contexts entry that is an absolute path (URLs, service: and
//              docker-image:// entries are not host paths and are skipped)
//   S <path>   a top-level secrets / configs `file`
//   O <path>   a top-level volume driver_opts.device that is an absolute path (also
//              printed as W: a named volume bound to a host folder is writable unless
//              every mount says read_only, so it counts as a writable bind)
//   D <ext>\t<driver>\t<opts>\t<name> one line per top-level named volume:
//              1 when external, the driver ('' = unset), its driver_opts as `k=v;` in
//              key order (compose prints JSON maps sorted), and the docker volume name
//              (`name:`, else `<project>_<key>`, the key for an external one)
//   KL <raw> a build cache_from / cache_to entry that is a local cache
//              (`type=local` in any case, or a `src=` / `dest=` key in any case): refused
//   X <raw>    one of those values printed with a JSON escape or quote (refused)
//   E <why>    the JSON is not in the expected layout (refused)
export const COMPOSE_JSON_MOUNTS_AWK = String.raw`
function ind(s) { match(s, /^ */); return RLENGTH }
function key(s,   k) { k = s; sub(/^ *"/, "", k); sub(/".*$/, "", k); return k }
function val(s,   v) { v = s; sub(/^ *"[^"]*": */, "", v); sub(/,$/, "", v); return v }
function plain(v) { return v ~ /^"[^"\\]*"$/ }
function unq(v) { return substr(v, 2, length(v) - 2) }
function out(t, v) { if (plain(v)) print t " " unq(v); else print "X " v }
function absout(t, v) { if (!plain(v)) print "X " v; else if (substr(v, 2, 1) == "/") print t " " unq(v) }
function item(s,   v) { v = s; sub(/^ */, "", v); sub(/,$/, "", v); return v }
function vend(   n) {
  if (vbad != "") { print "X " vbad; return }
  if (vn != "" && !plain(vn)) { print "X " vn; return }
  if (vd != "" && !plain(vd)) { print "X " vd; return }
  n = (vn != "") ? unq(vn) : (vx ? vk : proj "_" vk)
  printf "D %d\t%s\t%s\t%s\n", vx, (vd != "" ? unq(vd) : ""), vo, n
}
NR == 1 && $0 == "{}" { exit }
NR == 1 { if ($0 != "{") { print "E the compose config is not in the expected JSON layout"; exit } next }
NR == 2 && $0 !~ /^  "/ { print "E the compose config is not in the expected JSON layout"; exit }
{ i = ind($0) }
i == 2 && /^  "/ { top = key($0); f = ""; if (top == "name") { v = val($0); if (plain(v)) { proj = unq(v); print "N " proj } else print "X " v } next }
i < 2 { next }
i == 2 { top = ""; f = ""; next }
top == "services" && i == 4 { f = ""; next }
top == "services" && f == "build" && i == 6 && /^      [}]/ {
  if (bc != "" && !plain(bc)) print "X " bc
  else if (bc != "") { c = unq(bc); if (c ~ /^\//) print "C " c }
  if (bd != "" && !plain(bd)) print "X " bd
  else if (bd != "") { d = unq(bd); if (d ~ /^\//) print "C " d; else if (c ~ /^\//) print "C " c "/" d }
  f = ""; next
}
top == "services" && i == 6 {
  f = ""
  if (/^      "/) {
    k = key($0); v = val($0)
    if (k == "volumes" && v == "[") f = "volumes"
    else if (k == "build" && v == "{") { f = "build"; bc = ""; bd = ""; c = ""; bs = "" }
    else if (k == "volumes" && v != "[]" && v != "null") print "E the volumes of a service are not in the expected JSON layout"
  }
  next
}
f == "volumes" && i == 8 && /^        [{]/ { vt = ""; vs = ""; vro = 0; next }
f == "volumes" && i == 10 && /^          "type": / { vt = val($0); next }
f == "volumes" && i == 10 && /^          "source": / { vs = val($0); next }
f == "volumes" && i == 10 && /^          "read_only": true/ { vro = 1; next }
f == "volumes" && i == 8 && /^        [}]/ { if (vt == "\"bind\"" && vs != "") { out("B", vs); if (!vro) out("W", vs) } next }
f == "build" && i == 8 && /^        "/ {
  k = key($0); v = val($0); bs = ""
  if (k == "context") bc = v
  else if (k == "dockerfile") bd = v
  else if (k == "additional_contexts" && v == "{") bs = "ac"
  else if ((k == "cache_from" || k == "cache_to") && v == "[") bs = "cache"
  next
}
f == "build" && i == 10 && bs == "ac" && /^          "/ { absout("C", val($0)); next }
f == "build" && i == 10 && bs == "cache" && /^          "/ {
  v = item($0)
  if (!plain(v)) { print "X " v; next }
  lv = tolower(unq(v)); gsub(/[ \t']/, "", lv)
  if (lv ~ /(^|,)type=local(,|$)/ || lv ~ /(^|,)(src|dest)=/) print "KL " unq(v)
  next
}
top == "volumes" && i == 4 && /^    "/ { f = "vol"; vk = key($0); vn = ""; vx = 0; vd = ""; vo = ""; vbad = ""; if ($0 ~ /[{][}],?$/) vend(); else if ($0 !~ /[{]$/) vbad = $0; next }
top == "volumes" && i == 4 && /^    [}]/ { if (f != "") vend(); f = ""; next }
top == "volumes" && i == 4 { f = ""; next }
top == "volumes" && f != "" && i == 6 && /^      "/ {
  f = "vol"; k = key($0); v = val($0)
  if (k == "name") vn = v
  else if (k == "external" && v == "true") vx = 1
  else if (k == "driver") vd = v
  else if (k == "driver_opts" && v == "{") f = "dopts"
  next
}
top == "volumes" && f == "dopts" && i == 8 && /^        "/ {
  v = val($0)
  if (!plain(v) || $0 !~ /^        "[A-Za-z0-9._-]+": /) { vbad = $0; next }
  vo = vo key($0) "=" unq(v) ";"
  if (key($0) == "device") { absout("O", v); if (substr(v, 2, 1) == "/") print "W " unq(v) }
  next
}
(top == "secrets" || top == "configs") && i == 6 && /^      "file": / { out("S", val($0)); next }
`

// awk body (run under LC_ALL=C on the RAW text of one compose file): print
// `line N: <reason>` and exit 1 when the file uses compose `include` or `extends`, or
// a YAML form that could produce those keys without spelling them out. An `include`
// entry can carry its own env_file / project_directory, which inlines another app's
// env into `environment` and leaves no trace in the resolved config; `extends` with a
// `file:` pulls a service from another app's compose. Ordinary apps need neither, so
// this is a hard refusal in every guard mode.
//
// Single-line YAML only: every bypass of a per-line check came from a node
// that spans lines, so every line must be self-contained. Refused: a block scalar
// header (`key: |`, `- >`, any indicators), a quoted string or a flow collection that
// does not close on its own line, and any line that is not `key:`, `key: value`,
// `- ...`, `---`, a comment or blank (a plain value continued from the line above, a
// merge key `<<`, an explicit `?` key, an anchor or alias). Anchors, aliases and tags
// are refused too; only a file powder generates (`-v gen=1`, decided by its path under
// powder's compose state dir, never by content) may use the tags `!override` and
// `!reset`. With every line self-contained, a complete value on a line (a whole quoted
// string, or a plain one without flow characters) cannot hide a key, so the
// anywhere-rules read the line with that value replaced by a placeholder (label and env
// values such as JSON headers or `wss://*.host:443` would trip them). Root keys: every
// column-0 line must be a plain (or simply quoted) key or `---`, and `include` is
// refused. Anywhere: the word `extends` used as a key, a double-quoted key with an
// escape, an alias used as a key, an explicit `?` key, a binary tag, and a line break
// that awk would not split on (lone CR, NEL, LS, PS). Ordinary app compose files (app,
// src/ or powder override) use none of a multi-line node, an anchor, an alias, a merge
// key or a tag of their own.
export const COMPOSE_RAW_AWK = String.raw`
function bad(m) { printf "line %d: %s\n", NR, m; rc = 1 }
function values(l,   p, r) {
  if (match(l, /^[ \t]*(-[ \t]+)*([A-Za-z0-9_.\/-]+|"[A-Za-z0-9_.\/-]+"|'[A-Za-z0-9_.\/-]+')[ \t]*:[ \t]+/)) p = RLENGTH
  else if (match(l, /^[ \t]*(-[ \t]+)+/)) p = RLENGTH
  else return l
  r = substr(l, p + 1)
  if (r ~ /^"([^"\\]|\\.)*"[ \t]*(#.*)?$/ || r ~ /^'([^']|'')*'[ \t]*(#.*)?$/) return substr(l, 1, p) "\"\""
  if (r ~ /^[^-?:,{}#&*!|>'"%@ \t\[\]][^,{}\[\]]*$/ && r !~ /:([ \t]|$)/) return substr(l, 1, p) "x"
  return l
}
function flowok(s,   i, n, c, d, q, prev, sp) {
  n = length(s); d = 0; q = ""; prev = ""; sp = 0
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (q != "") {
      if (q == "\"" && c == "\\") { i++; continue }
      if (c == q) { if (q == "'" && substr(s, i + 1, 1) == "'") { i++; continue } q = ""; prev = "\""; sp = 0 }
      continue
    }
    if (c == " " || c == "\t") { sp = 1; continue }
    if (c == "#" && substr(s, i - 1, 1) ~ /[ \t]/) break
    # A quote opens a node only right after { [ , (spaces allowed) or after ": ";
    # anywhere else YAML reads it as part of a plain scalar (x-a:'q).
    if (c == "\"" || c == "'") {
      if (prev ~ /[{\[,]/ || (prev == ":" && sp)) { q = c; continue }
      why = "a quote inside a plain scalar"; return 0
    }
    sp = 0
    if ((c == "&" || c == "*" || c == "!") && prev ~ /[{\[,:]/) { why = "an anchor, alias or tag"; return 0 }
    if (c == "{" || c == "[") d++
    else if (c == "}" || c == "]") {
      d--
      if (d == 0) { if (substr(s, i + 1) ~ /^[ \t]*(#.*)?$/) return 1; why = "text after a flow collection"; return 0 }
    }
    prev = c
  }
  why = (q != "") ? "a quoted string spanning lines is not supported" : "a flow collection spanning lines is not supported"
  return 0
}
function valok(r) {
  sub(/^[ \t]+/, "", r)
  if (r == "" || r ~ /^#/) return 1
  if (r ~ /^[|>]/) { why = "a block scalar is not supported"; return 0 }
  if (r ~ /^[&*]/) { why = "an anchor or alias is not supported"; return 0 }
  if (r ~ /^!/) {
    if (gen == 1 && r ~ /^!(override|reset)([ \t]|$)/) { sub(/^![a-z]+/, "", r); return valok(r) }
    why = "a YAML tag is not supported"; return 0
  }
  if (r ~ /^"/) {
    if (r ~ /^"([^"\\]|\\.)*"[ \t]*(#.*)?$/) return 1
    why = (r ~ /^"([^"\\]|\\.)*"/) ? "text after a quoted string" : "a quoted string spanning lines is not supported"; return 0
  }
  if (r ~ /^'/) {
    if (r ~ /^'([^']|'')*'[ \t]*(#.*)?$/) return 1
    why = (r ~ /^'([^']|'')*'/) ? "text after a quoted string" : "a quoted string spanning lines is not supported"; return 0
  }
  if (r ~ /^[{\[]/) return flowok(r)
  if (r ~ /^[%@]/) { why = "a reserved indicator"; return 0 }
  return 1
}
function hasval(r) {
  sub(/^[ \t]+/, "", r)
  if (gen == 1) sub(/^!(override|reset)([ \t]+|$)/, "", r)
  return !(r == "" || r ~ /^#/)
}
BEGIN {
  rc = 0; first = 1; pend = -1
  ctl = "[" sprintf("%c", 1) "-" sprintf("%c", 8) sprintf("%c", 11) sprintf("%c", 12) sprintf("%c", 14) "-" sprintf("%c", 31) sprintf("%c", 127) "]"
}
{
  # Backstops on the RAW line, before any parsing: an app compose file has no use
  # for these words or escapes, so no quote or flow reading can hide them.
  if (tolower($0) ~ /extends|include/) bad("the word extends/include is not allowed anywhere in a compose file")
  if ($0 ~ /\\[xuUN_LP]/) bad("a \\x \\u \\U \\N \\_ \\L or \\P escape is not allowed in a compose file")
  r0 = $0; sub(/\r$/, "", r0)
  if (index(r0, "\r")) { bad("a carriage return inside a line (YAML reads it as a line break)"); next }
  if (r0 ~ ctl) { bad("a control character (only tab is allowed)"); next }
  l = $0
  if (NR == 1 && substr(l, 1, 3) == "\357\273\277") l = substr(l, 4)
  sub(/\r$/, "", l)
  if (index(l, "\302\205") || index(l, "\342\200\250") || index(l, "\342\200\251")) { bad("a Unicode line break character"); next }
  if (l ~ /^[ \t]*(#.*)?$/) next
  if (l ~ /^---[ \t]*(#.*)?$/) { first = 1; next }
  # Line grammar: indent, any "- ", then a key with its value, or a sequence value.
  if (l ~ /^ *\t/) bad("a tab in the indentation")
  # A line after one that carried a value may not be indented deeper than that value's
  # key (or, for "- value", than its dash): YAML would read it as the value continued.
  li = match(l, /[^ \t]/) - 1
  if (pend >= 0 && li > pend) bad("a value continued from the line above")
  pend = -1
  t = l; sub(/^[ \t]+/, "", t); dash = 0
  while (t ~ /^-([ \t]|$)/) { t = substr(t, 2); sub(/^[ \t]+/, "", t); dash = 1 }
  kc = length(l) - length(t)
  if (t == "" || t ~ /^#/) { if (!dash) bad("a line powder cannot read") }
  else if (match(t, /^[A-Za-z0-9_.\/@+-]+[ \t]*:([ \t]|$)/) || match(t, /^"[^"\\]*"[ \t]*:([ \t]|$)/) || match(t, /^'[^']*'[ \t]*:([ \t]|$)/)) {
    rv = substr(t, RLENGTH + 1)
    if (!valok(rv)) bad(why)
    else if (hasval(rv)) pend = kc
  }
  else if (dash) { if (!valok(t)) bad(why); else if (hasval(t)) pend = kc - 1 }
  else bad("a line that is not key:, key: value or - item (a value continued from the line above, a merge key, an explicit key, an anchor or alias)")
  # The anywhere-rules read the line with a complete value replaced by a placeholder.
  v = values(l)
  if (v ~ /![^ \t]*binary/) bad("a binary YAML tag")
  if (v ~ /(^|[^A-Za-z0-9_-])extends["']?[ \t]*:/) bad("an extends key")
  if (v ~ /"[^"]*\\[^"]*"[ \t]*:/) bad("a double-quoted key with an escape sequence")
  if (v ~ /\*[^ \t,{}\[\]]+[ \t]*:/) bad("an alias used as a key")
  if (v ~ /^[ \t]*(-[ \t]+)*\?([ \t]|$)/ || v ~ /[{,\[][ \t]*\?([ \t]|$)/) bad("an explicit (?) key")
  if (substr(l, 1, 1) == " ") { if (first) bad("the document root is indented"); first = 0; next }
  first = 0
  k = ""
  if (l ~ /^[A-Za-z0-9_.-]+[ \t]*:([ \t]|$)/) { k = l; sub(/[ \t]*:.*$/, "", k) }
  else if (l ~ /^"[A-Za-z0-9_.-]+"[ \t]*:([ \t]|$)/ || l ~ /^'[A-Za-z0-9_.-]+'[ \t]*:([ \t]|$)/) { k = substr(l, 2); sub(/["'][ \t]*:.*$/, "", k) }
  else { bad("a top-level line that is not a plain key"); next }
  if (k == "include") bad("an include key")
}
END { exit rc }
`

/** Shell: run COMPOSE_RAW_AWK on every `-f` file in `cf` (compose file args,
 *  word-split as compose gets them). Prints `compose file guard: refusing, ...` lines
 *  and returns 1 on a finding or an unreadable file; prints nothing and returns 0
 *  otherwise. A file that does not exist is skipped: compose itself fails on it. Runs BEFORE any `docker compose config`: config already reads the
 *  included files and the env files an include names. Refusing include makes recursing
 *  into included files moot. */
export function composeRawGuardShell(cf: string): string {
	return (
		`cr_files() { CR_RC=0; while [ $# -gt 0 ]; do if [ "$1" = -f ] && [ $# -gt 1 ]; then ` +
		`if [ ! -e "$2" ] && [ ! -L "$2" ]; then :; ` +
		`elif [ ! -f "$2" ] || [ ! -r "$2" ]; then echo "compose file guard: refusing, cannot read the compose file $2"; CR_RC=1; ` +
		// Generated (powder's own files may use !override / !reset): only a plain path under
		// the compose state dir; a path with //, /./ or /../ never counts as generated.
		`else case "$2" in *//*|*/./*|*/../*|*/.|*/..) CR_GEN=0;; ${shq(composeStateBase())}/*) CR_GEN=1;; *) CR_GEN=0;; esac; ` +
		`if ! CR_OUT=$(LC_ALL=C awk -v gen="$CR_GEN" ${shq(COMPOSE_RAW_AWK)} < "$2" 2>&1); then ` +
		`echo "compose file guard: refusing, $2 uses a compose or YAML form powder does not allow (include, extends, or a YAML form that could hide them; a hard refusal in every guard mode, see docs/SECURITY-COMPOSE.md):"; ` +
		`printf '%s\\n' "$CR_OUT" | head -n 5 | sed 's/^/  /'; CR_RC=1; fi; fi; shift 2; else shift; fi; done; return $CR_RC; }; ` +
		`cr_files ${cf}`
	)
}

/** the docker templates of the writable set (kept unchanged, so every
 *  reader of `docker inspect` agrees on what a writable mount is). */
const PW_BIND_FMT = '{{range .Mounts}}{{if and (eq .Type "bind") .RW}}{{println .Source}}{{end}}{{end}}'
const PW_VOL_FMT = '{{range .Mounts}}{{if and (eq .Type "volume") .RW}}{{println .Name}}{{end}}{{end}}'
const PW_DEV_FMT = '{{if .Options}}{{with index .Options "device"}}{{println .}}{{end}}{{end}}'

/** THE one authority for "the folders a container can write" on the server, as
 *  shell functions. Every on-server guard that compares a path with writable folders (the
 *  env file guard for env_file / label_file, the bind guard for mount sources, secrets
 *  and build paths) reads its set from `pw_wset`; the TypeScript twin is
 *  writableFoldersOf (compose-safety.ts). Two guards computing it differently was the
 *  hole: the env file guard missed named volumes bound to a host folder.
 *
 *  `pw_wset <lex> <res> ...` reads COMPOSE_JSON_MOUNTS_AWK lines of the config on stdin
 *  and prints the union, each path normalised (a lexical root prefix replaced by its
 *  resolved form, the pairs given as arguments, longest first) and then `readlink -f`
 *  (sorted, unique):
 *   (a) the config's writable service binds (`W` lines);
 *   (b) the config's named volume devices (`O` lines are printed as `W` too);
 *   (c) for every container of every compose project on the server, any state: its
 *       writable bind sources AND the `device` option of every named volume it mounts
 *       writable (docker inspect reports such a mount as type volume, never as a bind);
 *   (d) the `device` of every named volume of the config (`D` lines) that exists on the
 *       server (compose keeps an existing volume as it is).
 *  Any absolute `device` counts, whatever `type` / `o` say (a superset of the bind
 *  devices). A path built from a variable (`$`) is skipped: the uninterpolated config
 *  cannot resolve it (a container reports it resolved). Fail closed: when docker
 *  cannot list the containers or volumes, or read their mounts or options (tried twice:
 *  a container removed in between gets one retry), it prints `PW_ERR <why>` and
 *  returns 1. */
export function writableSetFnShell(): string {
	return (
		`pw_wnorm() { PW_NP=$1; shift; while [ $# -ge 2 ]; do if [ "$1" != / ]; then case "$PW_NP" in "$1"|"$1"/*) printf '%s' "$2\${PW_NP#"$1"}"; return 0;; esac; fi; shift 2; done; printf '%s' "$PW_NP"; }; ` +
		`pw_wcollect() { PW_WHY=""; PW_B=""; PW_D=""; PW_VN=""; ` +
		`PW_IDS=$(docker ps -aq --filter "label=com.docker.compose.project" 2>/dev/null) || { PW_WHY="cannot list the containers on this server (docker ps failed)"; return 1; }; ` +
		`if [ -n "$PW_IDS" ]; then ` +
		`PW_B=$(printf '%s\\n' "$PW_IDS" | xargs docker inspect --format ${shq(PW_BIND_FMT)} 2>/dev/null) || { PW_WHY="cannot read the bind mounts of the containers on this server (docker inspect failed)"; return 1; }; ` +
		`PW_VN=$(printf '%s\\n' "$PW_IDS" | xargs docker inspect --format ${shq(PW_VOL_FMT)} 2>/dev/null) || { PW_WHY="cannot read the volume mounts of the containers on this server (docker inspect failed)"; return 1; }; fi; ` +
		`PW_VL=$(docker volume ls -q 2>/dev/null) || { PW_WHY="cannot list the volumes on this server (docker volume ls failed)"; return 1; }; ` +
		`PW_VN=$( { printf '%s\\n' "$PW_VN"; printf '%s\\n' "$PW_IN" | LC_ALL=C awk -F '\\t' '/^D / { print $NF }' | while IFS= read -r PW_V; do if printf '%s\\n' "$PW_VL" | grep -qxF -- "$PW_V"; then printf '%s\\n' "$PW_V"; fi; done; } | grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*$' | LC_ALL=C sort -u); ` +
		`if [ -n "$PW_VN" ]; then PW_D=$(printf '%s\\n' "$PW_VN" | xargs docker volume inspect --format ${shq(PW_DEV_FMT)} 2>/dev/null) || { PW_WHY="cannot read the options of the volumes $(printf '%s' "$PW_VN" | tr '\\n' ' ')(docker volume inspect failed)"; return 1; }; fi; return 0; }; ` +
		`pw_wset() { PW_IN=$(cat); pw_wcollect || pw_wcollect || { printf 'PW_ERR %s\\n' "$PW_WHY"; return 1; }; ` +
		`{ printf '%s\\n' "$PW_IN" | sed -n 's/^W //p'; printf '%s\\n' "$PW_B"; printf '%s\\n' "$PW_D"; } | ` +
		`while IFS= read -r PW_S; do case "$PW_S" in (/*) ;; (*) continue;; esac; case "$PW_S" in (*'$'*) continue;; esac; PW_S=$(printf '%s' "$PW_S" | tr -s /); PW_S=$(pw_wnorm "$PW_S" "$@"); PW_X=$(readlink -f -- "$PW_S" 2>/dev/null || true); printf '%s\\n' "\${PW_X:-$PW_S}"; done | LC_ALL=C sort -u; return 0; }; `
	)
}

/** shell text for the `PW_ERR` reason pw_wset printed into shell variable `v`. */
const pwErr = (v: string) => `$(printf '%s\\n' "$${v}" | sed -n 's/^PW_ERR //p' | head -n 1)`

/** Shell: refuse an env_file / label_file that a symlink could
 *  turn into another app's env file. A container that can write into a bind-mounted
 *  folder of the app dir could replace an env file there (or a folder on its way) with a
 *  link to /opt/apps/<other>.env, and the next `compose up` (root on the host) would
 *  read those secrets into this app.
 *  - Paths come from `docker compose config --no-interpolate --format json`, read by
 *    COMPOSE_JSON_PATHS_AWK (never from YAML text). A path with any character outside
 *    [A-Za-z0-9._/-] (an escape, a variable, a space), a relative path and a `.` / `..`
 *    component are refused.
 *  - Below an app root (the working dir and /opt/apps/<app>; each resolved with
 *    `readlink -f` first, so a link ABOVE the root, such as /opt/apps itself being a
 *    link to a volume, never counts), every path component is checked and any symlink
 *    is refused. One exception: the FINAL component may be a link whose `readlink -f`
 *    equals the `readlink -f` of the app's own /opt/apps/<app>.env (an operator-made
 *    `.env -> /opt/apps/<app>.env`).
 *  - Outside the roots: the file may not be a link that resolves anywhere but the own
 *    env file or inside a root, and its folder may not reach into a root through a link.
 *  A hard refusal in every compose guard mode (runtime state on the server, not a
 *  compose-structure finding). Exits 1 (the caller's shell) on refusal or when the
 *  paths cannot be read. Needs `cf` (compose -f args). */
export function envFileLinkGuardShell(
	cf: string,
	app: string,
	workingDir: string,
	/** Test seam: the app's own env file (default /opt/apps/<app>.env). */
	ownEnv?: string,
	/** Test seams: `appsBase` (default /opt/apps, as bindLinkGuardShell's), and
	 *  `wsetTrace`, a file the writable set (pw_wset) is written to. */
	seams: { appsBase?: string; wsetTrace?: string } = {},
): string {
	// The app name and paths only ever reach the shell single-quoted (shq), and the
	// messages print them through variables.
	const wd = workingDir.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
	const base = (seams.appsBase ?? '/opt/apps').replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
	// (lexical root, resolved root): a path is matched against both spellings, and the
	// walk always starts from the resolved one.
	const pairs: Array<[string, string]> = [
		['$EL_L0', '$EL_RP0'],
		['$EL_L1', '$EL_RP1'],
		['$EL_RP0', '$EL_RP0'],
		['$EL_RP1', '$EL_RP1'],
	]
	return (
		`{ EL_APP=${shq(app)}; EL_L0=${shq(wd)}; EL_LB=${shq(base)}; EL_L1="$EL_LB/$EL_APP"; EL_OWNP=${ownEnv ? shq(ownEnv) : '"/opt/apps/$EL_APP.env"'}; ` +
		// include / extends are refused on the raw files before compose reads them.
		`{ ${composeRawGuardShell(cf)}; } || exit 1; ` +
		// The uninterpolated error text carries no env values (it runs before the
		// preflight's INVALID check, so it names the YAML error itself).
		`EL_CFG=$(docker compose ${cf} ${ALL_PROFILES} config --no-interpolate --format json 2>/dev/null) || { echo "env file guard: refusing, cannot read the compose config (docker compose config --no-interpolate failed), so the env_file / label_file paths cannot be checked. The compose error: $(docker compose ${cf} ${ALL_PROFILES} config --no-interpolate 2>&1 >/dev/null | head -c 500)"; exit 1; }; ` +
		`EL_OWN=$(readlink -f -- "$EL_OWNP" 2>/dev/null || true); ` +
		`EL_RP0=$(readlink -f -- "$EL_L0" 2>/dev/null || true); [ -n "$EL_RP0" ] || EL_RP0=$EL_L0; ` +
		`EL_RP1=$(readlink -f -- "$EL_L1" 2>/dev/null || true); [ -n "$EL_RP1" ] || EL_RP1=$EL_L1; ` +
		// el_in A B: A is B or inside B (B "/" holds everything).
		`el_in() { if [ "$2" = / ]; then return 0; fi; case "$1" in "$2"|"$2"/*) return 0;; esac; return 1; }; ` +
		`EL_RB=$(readlink -f -- "$EL_LB" 2>/dev/null || true); [ -n "$EL_RB" ] || EL_RB=$EL_LB; ` +
		`EL_LIST=$(printf '%s\\n' "$EL_CFG" | LC_ALL=C awk ${shq(COMPOSE_JSON_PATHS_AWK)}); ` +
		// the folders a container can write, from THE one authority (pw_wset, shared
		// with the bind guard): the config's writable binds and named volume devices, the
		// containers of every compose project in any state (writable binds AND the devices
		// of the named volumes they mount writable), and the server copies of the config's
		// named volumes. Refused when docker cannot be read.
		writableSetFnShell() +
		`EL_BR=$(printf '%s\\n' "$EL_CFG" | LC_ALL=C awk ${shq(COMPOSE_JSON_MOUNTS_AWK)} | pw_wset "$EL_L0" "$EL_RP0" "$EL_L1" "$EL_RP1" "$EL_LB" "$EL_RB") || { echo "env file guard: refusing, ${pwErr('EL_BR')}, so the folders a container on this server can write cannot be listed and the env_file / label_file paths cannot be checked against them"; exit 1; }; ` +
		(seams.wsetTrace ? `printf '%s\\n' "$EL_BR" > ${shq(seams.wsetTrace)}; ` : '') +
		`printf '%s\\n' "$EL_LIST" | { EL_RC=0; while IFS= read -r EL_LN; do ` +
		`EL_K=\${EL_LN%% *}; EL_P=\${EL_LN#* }; ` +
		`case "$EL_K" in ` +
		`E) echo "env file guard: refusing, $EL_P, so the env_file / label_file paths cannot be checked"; EL_RC=1; continue;; ` +
		`BF) echo "env file guard: refusing, the env_file / label_file path $EL_P (as compose prints it) has characters outside [A-Za-z0-9._/-] (an escape, a variable, a space). Write it literally with letters, digits, dot, dash, underscore and slash."; EL_RC=1; continue;; ` +
		`BV) echo "env file guard: refusing, cannot check the writable bind source $EL_P (as compose prints it): powder compares every env_file / label_file against the writable binds. Write the source with plain characters."; EL_RC=1; continue;; ` +
		`F) ;; *) continue;; esac; ` +
		`EL_P=$(printf '%s' "$EL_P" | tr -s /); ` +
		`case "$EL_P" in /*) ;; *) echo "env file guard: refusing, the env_file / label_file path $EL_P is not absolute"; EL_RC=1; continue;; esac; ` +
		`case "$EL_P/" in */./*|*/../*) echo "env file guard: refusing, the env_file / label_file path $EL_P has a . or .. component; write the plain path"; EL_RC=1; continue;; esac; ` +
		// The deepest root the path is (lexically) under, and the rest of the path below it.
		`EL_RT=""; EL_RS=""; EL_BL=0; ` +
		pairs
			.map(
				([lex, res]) =>
					`if [ "${lex}" != / ]; then case "$EL_P" in "${lex}"/*) if [ \${#${lex.slice(1)}} -gt "$EL_BL" ]; then EL_BL=\${#${lex.slice(1)}}; EL_RT="${res}"; EL_RS=\${EL_P#"${lex}"/}; fi;; esac; fi; `,
			)
			.join('') +
		`if [ -n "$EL_RT" ]; then ` +
		`EL_C=$EL_RT; EL_REST=$EL_RS; EL_BAD=""; ` +
		`while [ -n "$EL_REST" ]; do EL_SEG=\${EL_REST%%/*}; case "$EL_REST" in */*) EL_REST=\${EL_REST#*/};; *) EL_REST="";; esac; EL_C="$EL_C/$EL_SEG"; ` +
		`if [ -L "$EL_C" ]; then if [ -z "$EL_REST" ] && [ -n "$EL_OWN" ] && [ "$(readlink -f -- "$EL_C" 2>/dev/null || true)" = "$EL_OWN" ]; then break; fi; EL_BAD=$EL_C; break; fi; ` +
		`if [ ! -e "$EL_C" ]; then break; fi; done; ` +
		`if [ -n "$EL_BAD" ]; then echo "env file guard: refusing, the env_file / label_file $EL_P goes through the symlink $EL_BAD (-> $(readlink -- "$EL_BAD" 2>/dev/null || true)) inside the app dir. Only a final link to the app's own $EL_OWNP is allowed there: a container that can write in the app dir may have planted it to read another app's secrets. Replace the link with the real file (or point env_file at its target) and redeploy."; EL_RC=1; continue; fi; ` +
		`else ` +
		`if [ -L "$EL_P" ]; then EL_T=$(readlink -f -- "$EL_P" 2>/dev/null || true); ` +
		`if [ -z "$EL_T" ] || { [ "$EL_T" != "$EL_OWN" ] && ! el_in "$EL_T" "$EL_RP0" && ! el_in "$EL_T" "$EL_RP1"; }; then echo "env file guard: refusing, the env_file / label_file $EL_P is a symlink to \${EL_T:-an unresolvable path}, which is outside this app (allowed: $EL_OWNP, or a file inside $EL_L0 or $EL_L1). A container that can write next to it may have planted the link to read another app's secrets. Remove the link on the server and redeploy."; EL_RC=1; continue; fi; fi; ` +
		`EL_PL=$(dirname -- "$EL_P"); EL_PD=$(readlink -f -- "$EL_PL" 2>/dev/null || true); ` +
		`if [ -n "$EL_PD" ] && [ "$EL_PD" != "$EL_PL" ] && { el_in "$EL_PD" "$EL_RP0" || el_in "$EL_PD" "$EL_RP1"; }; then echo "env file guard: refusing, the env_file / label_file $EL_P reaches into the app dir ($EL_PD) through a symlinked folder outside it. Use the path inside the app dir."; EL_RC=1; continue; fi; ` +
		`fi; ` +
		// no env / label file in a folder a container can write: its process could
		// swap the file for a link between this check and compose reading it. Checked: the
		// file's folder and the folder of what it resolves to (both via readlink -f).
		`EL_PL=$(dirname -- "$EL_P"); EL_D1=$(readlink -f -- "$EL_PL" 2>/dev/null || true); EL_D2=""; ` +
		`if [ -e "$EL_P" ]; then EL_D2=$(readlink -f -- "$EL_P" 2>/dev/null || true); if [ -n "$EL_D2" ]; then EL_D2=$(dirname -- "$EL_D2"); fi; fi; ` +
		`EL_HIT=$(printf '%s\\n' "$EL_BR" | while IFS= read -r EL_S; do [ -n "$EL_S" ] || continue; for EL_D in "$EL_D1" "$EL_D2"; do if [ -n "$EL_D" ] && el_in "$EL_D" "$EL_S"; then printf '%s\\n' "$EL_S"; break 2; fi; done; done); ` +
		`if [ -n "$EL_HIT" ]; then echo "env file guard: refusing, the env_file / label_file $EL_P sits in a folder that a container on this server (of this or another compose project, in any state) can write (writable bind of $EL_HIT). A process there could swap the file for a link to another app's env file right before compose reads it. Mount that folder read-only (:ro), or keep the env file outside it (e.g. /opt/apps/$EL_APP.env)."; EL_RC=1; continue; fi; ` +
		`done; exit $EL_RC; } || exit 1; }`
	)
}

/** Shell: refuse a mount source or a host file compose reads that goes through
 *  a symlink, and a mount source inside another writable bind of the project. A container
 *  that can write a bind-mounted folder can plant `ln -sfn / data/r`; a later compose
 *  file (or a tracked repo link) naming `.../data/r` would mount the host root.
 *  - Paths come from `docker compose config --no-interpolate --format json`, read by
 *    COMPOSE_JSON_MOUNTS_AWK: bind sources, build context / dockerfile /
 *    additional_contexts, top-level secrets / configs `file`, and volume
 *    driver_opts.device. A path built from a variable is taken from the interpolated
 *    config instead (read only after envFileLinkGuardShell passed).
 *  - The compose project name must be the app name: ownership rules key on it.
 *  - Every path is normalised first: a lexical prefix of the working dir, of
 *    `<appsBase>/<app>` or of `<appsBase>` is replaced by its `readlink -f` (on the powder
 *    server /opt/apps itself is a link to a volume, which must not count). Then every
 *    component is walked from `/`; a missing component ends the walk (docker creates it).
 *  - Bind sources and driver_opts devices: any symlink component is refused.
 *  - Build paths and secrets / configs files: a symlink is allowed only when it sits
 *    below the resolved app root, resolves inside that same root (a tracked in-repo link
 *    such as Dockerfile -> docker/Dockerfile) and is not inside a writable bind.
 *    The walk follows such a link one hop at a time, so every hop of a chain passes
 *    the same test (a planted second hop inside a writable bind is refused).
 *  - Bind sources, devices and secrets / configs files inside a DIFFERENT writable bind
 *    of the project (new config, or a running container of the project) are refused: a
 *    process there could swap a component for a link between this check and the mount.
 *  - Build paths (context, dockerfile, additional_contexts) resolved AT or inside
 *    any writable bind (any compose project, any state) are refused: the build reads
 *    them later, as root, and a container there could swap them for a link to `/`.
 *  A hard refusal in every compose guard mode. Exits 1 (the caller's shell) on refusal.
 *  Run it after envFileLinkGuardShell (it may read the interpolated config).
 *  `appsBase` is a test seam (default /opt/apps). */
export function bindLinkGuardShell(
	cf: string,
	app: string,
	workingDir: string,
	appsBase = '/opt/apps',
	/** false when the caller cannot name the app (no app_repos row): the
	 *  project name is then not checked rather than compared against a guess. */
	checkName = true,
	/** Test seam: a file the writable set (pw_wset) is written to. */
	seams: { wsetTrace?: string } = {},
): string {
	const wd = workingDir.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
	const base = appsBase.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
	const awk = shq(COMPOSE_JSON_MOUNTS_AWK)
	const pathLine = `'^[BWCSOND] .*[$]'`
	// (lexical root, resolved root), longest first: the app dir spellings, then the base.
	const roots: Array<[string, string]> = [
		['$BG_L0', '$BG_RP0'],
		['$BG_L1', '$BG_RP1'],
		['$BG_LB', '$BG_RB'],
	]
	return (
		`{ BG_APP=${shq(app)}; BG_L0=${shq(wd)}; BG_LB=${shq(base)}; BG_L1="$BG_LB/$BG_APP"; ` +
		`BG_CFG=$(docker compose ${cf} ${ALL_PROFILES} config --no-interpolate --format json 2>/dev/null) || { echo "bind guard: refusing, cannot read the uninterpolated compose config, so the mount sources cannot be checked"; exit 1; }; ` +
		`BG_LIST=$(printf '%s\\n' "$BG_CFG" | LC_ALL=C awk ${awk}); ` +
		// A path (or the name) built from a variable: take those lines from the
		// interpolated config. The env file guard ran first, so reading it is safe.
		`if printf '%s\\n' "$BG_LIST" | grep ${pathLine} >/dev/null; then ` +
		`BG_CFG2=$(docker compose ${cf} ${ALL_PROFILES} config --format json 2>/dev/null) || { echo "bind guard: refusing, a mount source or file path is built from a variable and the interpolated compose config cannot be read"; exit 1; }; ` +
		`BG_LIST=$( { printf '%s\\n' "$BG_LIST" | grep -v ${pathLine} || true; printf '%s\\n' "$BG_CFG2" | LC_ALL=C awk ${awk}; } ); fi; ` +
		`BG_PROJ=$(printf '%s\\n' "$BG_LIST" | sed -n 's/^N //p' | head -n 1); ` +
		(checkName
			? `BG_WANT=${shq(composeProjectNameFor(app))}; if [ "$BG_PROJ" != "$BG_WANT" ]; then echo "bind guard: refusing, the compose project name is '$BG_PROJ', not '$BG_WANT' (the app name $BG_APP as compose writes a project name). powder decides what an app owns (containers, volumes, networks, env files) by its name; remove the name: key (or set it to the app name)."; exit 1; fi; `
			: '') +
		`BG_RB=$(readlink -f -- "$BG_LB" 2>/dev/null || true); [ -n "$BG_RB" ] || BG_RB=$BG_LB; ` +
		`BG_RP0=$(readlink -f -- "$BG_L0" 2>/dev/null || true); [ -n "$BG_RP0" ] || BG_RP0=$BG_L0; ` +
		`BG_RP1=$(readlink -f -- "$BG_L1" 2>/dev/null || true); [ -n "$BG_RP1" ] || BG_RP1=$BG_L1; ` +
		// 2: the src/ layout (the checkout is <app dir>/src): the app dir itself
		// holds powder's runtime files (.deploy-key, the compose, pgdata) and no
		// .dockerignore powder writes, so no build path may be the app dir there.
		`BG_SRCL=0; if [ -d "$BG_RP0/src/.git" ] || [ -d "$BG_RP1/src/.git" ]; then BG_SRCL=1; fi; ` +
		// bg_ignok D: D/.dockerignore is a regular file (not a link) whose last pgdata/ and
		// kvdata/ lines no later !negation re-includes (powder writes them last).
		`bg_ignok() { [ -f "$1/.dockerignore" ] && [ ! -L "$1/.dockerignore" ] && LC_ALL=C awk '{ sub(/\r$/, "") } $0 == "pgdata/" { p = NR } $0 == "kvdata/" { k = NR } /^[ \t]*!/ { n = NR } END { m = (p < k) ? p : k; exit !(p && k && n < m) }' "$1/.dockerignore"; }; ` +
		// bg_in A B: A is B or inside B; bg_below A B: strictly inside.
		`bg_in() { if [ "$2" = / ]; then return 0; fi; case "$1" in "$2"|"$2"/*) return 0;; esac; return 1; }; ` +
		`bg_below() { if [ "$1" = "$2" ]; then return 1; fi; bg_in "$1" "$2"; }; ` +
		// bg_norm P: the lexical root prefix replaced by its resolved form.
		`bg_norm() { ` +
		roots
			.map(
				([lex, res]) =>
					`if [ "${lex}" != / ]; then case "$1" in "${lex}"|"${lex}"/*) printf '%s' "${res}\${1#"${lex}"}"; return 0;; esac; fi; `,
			)
			.join('') +
		`printf '%s' "$1"; }; ` +
		// the device of a named volume as it EXISTS on the server. compose never
		// changes an existing volume (no prompt without a TTY: it keeps the old one), and
		// docker re-resolves a bind device on every container start. So the devices of the
		// volumes this project's containers mount (any state) are walked like a config
		// device (O lines), and each named volume of the config (D lines) is compared
		// with its server copy in the loop below.
		`BG_TAB=$(printf '\\t'); ` +
		// fail closed when docker cannot list or read this project's containers or
		// their volumes (never read that as "no container").
		`BG_OWN=$(docker ps -aq --filter "label=com.docker.compose.project=$BG_PROJ" 2>/dev/null) || { echo "bind guard: refusing, cannot list the containers of the compose project $BG_PROJ (docker ps failed), so the volumes they mount cannot be checked"; exit 1; }; ` +
		`if [ -n "$BG_OWN" ]; then ` +
		`BG_OV=$(printf '%s\\n' "$BG_OWN" | xargs docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' 2>/dev/null) || { echo "bind guard: refusing, cannot read the mounts of the containers of the compose project $BG_PROJ (docker inspect failed)"; exit 1; }; ` +
		`BG_OD=$(printf '%s\\n' "$BG_OV" | { grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*$' || true; } | LC_ALL=C sort -u | xargs -r docker volume inspect --format '{{if .Options}}{{with index .Options "device"}}{{println .}}{{end}}{{end}}' 2>/dev/null) || { echo "bind guard: refusing, cannot read the options of the volumes the containers of the compose project $BG_PROJ mount (docker volume inspect failed)"; exit 1; }; ` +
		`BG_LIST=$(printf '%s\\n' "$BG_LIST"; printf '%s\\n' "$BG_OD" | grep '^/' | sed 's/^/O /'); fi; ` +
		// the folders a container can write, from THE one authority (pw_wset,
		// shared with the env file guard): the config's writable binds and named volume
		// devices, the containers of every compose project in any state (writable binds
		// AND the devices of the named volumes they mount writable: docker inspect shows a
		// volume's _data dir, so the volume is asked for its device), and the server copies of
		// the config's named volumes (a container mounts them writable unless every mount
		// says read_only). Normalised and resolved. Refused when docker cannot be read.
		writableSetFnShell() +
		`BG_W=$(printf '%s\\n' "$BG_LIST" | pw_wset "$BG_L0" "$BG_RP0" "$BG_L1" "$BG_RP1" "$BG_LB" "$BG_RB") || { echo "bind guard: refusing, ${pwErr('BG_W')}, so the folders a container on this server can write cannot be listed and the mount sources cannot be checked against them"; exit 1; }; ` +
		(seams.wsetTrace ? `printf '%s\\n' "$BG_W" > ${shq(seams.wsetTrace)}; ` : '') +
		// bg_inw P: P is inside one of the writable binds (prints it).
		`bg_inw() { printf '%s\\n' "$BG_W" | while IFS= read -r BG_S; do if [ -n "$BG_S" ] && bg_in "$1" "$BG_S"; then printf '%s\\n' "$BG_S"; break; fi; done; }; ` +
		`printf '%s\\n' "$BG_LIST" | { BG_RC=0; while IFS= read -r BG_LN; do ` +
		`BG_K=\${BG_LN%% *}; BG_P=\${BG_LN#* }; ` +
		`case "$BG_K" in ` +
		`E) echo "bind guard: refusing, $BG_P, so the mount sources cannot be checked"; BG_RC=1; continue;; ` +
		`X) echo "bind guard: refusing, cannot check the path $BG_P (as compose prints it: it holds an escape or a quote). Write mount sources and file paths with plain characters."; BG_RC=1; continue;; ` +
		// a local build cache (cache_from / cache_to type=local, src= / dest=, any
		// case) reads or writes a host path as root: refused outright.
		`KL) echo "bind guard: refusing, the build cache $BG_P is a local cache (type=local / src= / dest=); local build caches are not allowed"; BG_RC=1; continue;; ` +
		// a named volume of the config. When it exists on the server, its driver and
		// options must be the config's (compose keeps an existing volume as it is), and a
		// device it binds is walked like any mount source below.
		`D) BG_DX=\${BG_P%%"$BG_TAB"*}; BG_R=\${BG_P#*"$BG_TAB"}; BG_DD=\${BG_R%%"$BG_TAB"*}; BG_R=\${BG_R#*"$BG_TAB"}; BG_DO=\${BG_R%%"$BG_TAB"*}; BG_DN=\${BG_R#*"$BG_TAB"}; ` +
		`case "$BG_DN" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) echo "bind guard: refusing, the named volume name '$BG_DN' is not a docker volume name ([A-Za-z0-9][A-Za-z0-9_.-]*), so its server copy cannot be checked"; BG_RC=1; continue;; esac; ` +
		// A failed inspect is "not created yet" only when the server's volume list lacks the
		// name (compose creates it from the config); any other failure refuses.
		`if ! BG_VI=$(docker volume inspect --format '{{.Driver}}{{"\\t"}}{{range $k, $v := .Options}}{{$k}}={{$v}};{{end}}' -- "$BG_DN" 2>/dev/null); then ` +
		`BG_VL=$(docker volume ls -q 2>/dev/null) || { echo "bind guard: refusing, cannot inspect the volume $BG_DN or list the volumes on this server, so its server copy cannot be checked"; BG_RC=1; continue; }; ` +
		`if printf '%s\\n' "$BG_VL" | grep -qxF -- "$BG_DN"; then echo "bind guard: refusing, the volume $BG_DN exists on this server but docker volume inspect failed, so its driver options cannot be checked"; BG_RC=1; fi; continue; fi; ` +
		`BG_VD=\${BG_VI%%"$BG_TAB"*}; BG_VO=\${BG_VI#*"$BG_TAB"}; [ -n "$BG_DD" ] || BG_DD=local; ` +
		`if [ "$BG_DX" != 1 ] && { [ "$BG_VD" != "$BG_DD" ] || [ "$BG_VO" != "$BG_DO" ]; }; then echo "bind guard: refusing, the volume $BG_DN already exists on this server with driver '$BG_VD' and options '$BG_VO', but the compose config declares driver '$BG_DD' and options '$BG_DO'. compose keeps an existing volume as it is, so the containers would mount the old one. Restore the old driver_opts in the compose file, or save the data and remove the volume on the server (docker volume rm $BG_DN), then redeploy."; BG_RC=1; continue; fi; ` +
		`BG_DEV=$(docker volume inspect --format '{{if .Options}}{{index .Options "device"}}{{end}}' -- "$BG_DN" 2>/dev/null) && ` +
		`BG_DOPT=$(docker volume inspect --format '{{if .Options}}{{index .Options "o"}}{{end}}' -- "$BG_DN" 2>/dev/null) || { echo "bind guard: refusing, cannot read the device options of the volume $BG_DN"; BG_RC=1; continue; }; ` +
		`case "$BG_DEV" in /*) BG_K=O; BG_P=$BG_DEV;; *) case ",$BG_DOPT," in *,bind,*|*,rbind,*) echo "bind guard: refusing, the volume $BG_DN on this server binds the device '$BG_DEV', which is not an absolute path, so it cannot be checked"; BG_RC=1;; esac; continue;; esac;; ` +
		`B|C|S|O) ;; *) continue;; esac; ` +
		`case "$BG_P" in *'$'*) echo "bind guard: refusing, the path $BG_P still holds a \\$ after interpolation; write it literally"; BG_RC=1; continue;; esac; ` +
		`BG_P=$(printf '%s' "$BG_P" | tr -s /); ` +
		`case "$BG_P" in /*) ;; *) echo "bind guard: refusing, the path $BG_P is not absolute"; BG_RC=1; continue;; esac; ` +
		`case "$BG_P/" in */./*|*/../*) echo "bind guard: refusing, the path $BG_P has a . or .. component; write the plain path"; BG_RC=1; continue;; esac; ` +
		`BG_N=$(bg_norm "$BG_P"); BG_C=""; BG_REST=\${BG_N#/}; BG_BAD=""; BG_HOPS=0; ` +
		`while [ -n "$BG_REST" ]; do BG_SEG=\${BG_REST%%/*}; case "$BG_REST" in */*) BG_REST=\${BG_REST#*/};; *) BG_REST="";; esac; ` +
		// `.` and `..` only come from a link target followed below (the path
		// itself was refused above when it had one). BG_C holds no link at this point
		// (every link met is expanded in place), so `..` is its lexical parent.
		`if [ -z "$BG_SEG" ] || [ "$BG_SEG" = . ]; then continue; fi; if [ "$BG_SEG" = .. ]; then BG_C=\${BG_C%/*}; continue; fi; BG_C="$BG_C/$BG_SEG"; ` +
		`if [ -L "$BG_C" ]; then BG_OK=0; ` +
		`if [ "$BG_K" = C ] || [ "$BG_K" = S ]; then BG_T=$(readlink -f -- "$BG_C" 2>/dev/null || true); ` +
		`for BG_RT in "$BG_RP0" "$BG_RP1"; do if [ -n "$BG_T" ] && bg_below "$BG_C" "$BG_RT" && bg_in "$BG_T" "$BG_RT" && [ -z "$(bg_inw "$BG_C")" ]; then BG_OK=1; break; fi; done; fi; ` +
		// follow the link ONE hop and walk its target like the rest of the path,
		// so every further hop is a link this walk meets and passes the same test: below
		// the app root, resolving inside it, and its own location in no writable bind (a
		// container there could plant or swap that hop after this check).
		`if [ "$BG_OK" = 1 ]; then BG_HOPS=$((BG_HOPS+1)); BG_LT=$(readlink -- "$BG_C" 2>/dev/null || true); ` +
		`if [ -z "$BG_LT" ] || [ "$BG_HOPS" -gt 40 ]; then BG_BAD=$BG_C; break; fi; ` +
		`case "$BG_LT" in /*) BG_LT=$(bg_norm "$(printf '%s' "$BG_LT" | tr -s /)"); BG_C="";; *) BG_C=\${BG_C%/*};; esac; ` +
		`BG_REST="\${BG_LT#/}\${BG_REST:+/$BG_REST}"; continue; fi; BG_BAD=$BG_C; break; fi; ` +
		`if [ ! -e "$BG_C" ]; then break; fi; done; ` +
		`if [ -n "$BG_BAD" ]; then echo "bind guard: refusing, $BG_P goes through the symlink $BG_BAD (-> $(readlink -- "$BG_BAD" 2>/dev/null || true)). A container that can write there may have planted it to mount or read another part of the host. Remove the link on the server (or name the real path) and redeploy."; BG_RC=1; continue; fi; ` +
		`BG_X=$(readlink -f -- "$BG_N" 2>/dev/null || true); [ -n "$BG_X" ] || BG_X=$BG_N; ` +
		// a build path (context, dockerfile, additional context) is read by the
		// build later, as root, so no writable bind may cover it, AT or above (the same
		// source bound twice passes only for mounts). Checked on the path the build reads.
		`if [ "$BG_K" = C ]; then ` +
		`if [ "$BG_SRCL" = 1 ] && { [ "$BG_X" = "$BG_RP0" ] || [ "$BG_X" = "$BG_RP1" ]; }; then echo "bind guard: refusing, the build path $BG_P is the app dir itself ($BG_X), but the checkout is in src/: the app dir holds powder's runtime files (.deploy-key, the compose, data dirs) and no .dockerignore of powder's. Build from ./src (or a folder in it)."; BG_RC=1; continue; fi; ` +
		`BG_HIT=$(bg_inw "$BG_X"); ` +
		`if [ -n "$BG_HIT" ]; then echo "bind guard: refusing, the build path $BG_P (resolved $BG_X) is inside $BG_HIT, which a container on this server (of this or another compose project, in any state) can write. A process there could swap it, or a folder on the way, for a link to another part of the host before the build reads it. Mount that folder read-only (:ro), or build from a folder no container writes."; BG_RC=1; continue; fi; ` +
		// nor a writable bind strictly INSIDE it: BuildKit reads the context by
		// path after this walk, so a folder swapped for a link in there would put host files
		// into the image. A read-only bind passes, and so do the /new layout's DB data dirs
		// (`pgdata`, `kvdata` right in a build path that is the app dir itself, workdir-git
		// layout only, and only while its .dockerignore ends with them: bg_ignok).
		`BG_HIT=$(printf '%s\\n' "$BG_W" | while IFS= read -r BG_S; do if [ -n "$BG_S" ] && bg_below "$BG_S" "$BG_X"; then if [ "$BG_SRCL" = 0 ] && { [ "$BG_X" = "$BG_RP0" ] || [ "$BG_X" = "$BG_RP1" ]; } && { [ "$BG_S" = "$BG_X/pgdata" ] || [ "$BG_S" = "$BG_X/kvdata" ]; } && bg_ignok "$BG_X"; then continue; fi; printf '%s\\n' "$BG_S"; break; fi; done); ` +
		`if [ -n "$BG_HIT" ]; then echo "bind guard: refusing, the writable bind $BG_HIT (a container on this server, of this or another compose project, in any state, can write it) is inside the build path $BG_P (resolved $BG_X). The build reads that folder after this check, and a process there could swap a folder for a link to host files. Mount it read-only (:ro), or move it out of the build context."; BG_RC=1; fi; continue; fi; ` +
		`BG_HIT=$(printf '%s\\n' "$BG_W" | while IFS= read -r BG_S; do if [ -n "$BG_S" ] && [ "$BG_S" != "$BG_X" ] && bg_in "$BG_X" "$BG_S"; then printf '%s\\n' "$BG_S"; break; fi; done); ` +
		`if [ -n "$BG_HIT" ]; then echo "bind guard: refusing, $BG_P sits inside $BG_HIT, which a container on this server (of this or another compose project, in any state) can write. A process there could swap a folder on the way for a link right before compose mounts it. Mount the outer folder read-only (:ro), or move one of the two."; BG_RC=1; continue; fi; ` +
		`done; exit $BG_RC; } || exit 1; }`
	)
}

/** awk body: read the INTERPOLATED `docker compose config --format json`
 *  (same 2-space layout as COMPOSE_JSON_MOUNTS_AWK) and print, for the infra mount
 *  guard:
 *    N <project>
 *    M\t<service>\t<type>\t<source>\t<ro 0|1>   one per service volume entry; for a
 *        named volume the source is its docker name (top-level `name:`, else
 *        `<project>_<key>`); '' for an anonymous volume
 *    X <raw>  a service key, type or source printed with a JSON escape or quote
 *    E <why>  not the expected layout */
export const COMPOSE_JSON_SVC_MOUNTS_AWK = String.raw`
function ind(s) { match(s, /^ */); return RLENGTH }
function key(s,   k) { k = s; sub(/^ *"/, "", k); sub(/".*$/, "", k); return k }
function val(s,   v) { v = s; sub(/^ *"[^"]*": */, "", v); sub(/,$/, "", v); return v }
function plain(v) { return v ~ /^"[^"\\]*"$/ }
function unq(v) { return substr(v, 2, length(v) - 2) }
NR == 1 && $0 == "{}" { exit }
NR == 1 { if ($0 != "{") { print "E the compose config is not in the expected JSON layout"; exit } next }
NR == 2 && $0 !~ /^  "/ { print "E the compose config is not in the expected JSON layout"; exit }
{ i = ind($0) }
i == 2 && /^  "/ { top = key($0); f = ""; if (top == "name") { v = val($0); if (plain(v)) { proj = unq(v); print "N " proj } else print "X " v } next }
i < 2 { next }
i == 2 { top = ""; f = ""; next }
top == "services" && i == 4 && /^    "/ { f = ""; svc = ""; if ($0 ~ /^    "[A-Za-z0-9._-]+": /) svc = key($0); else print "X " $0; next }
top == "services" && i == 4 { f = ""; next }
top == "services" && i == 6 { f = ""; if (/^      "volumes": \[$/) f = "volumes"; else if (/^      "volumes": / && val($0) != "[]" && val($0) != "null") print "E the volumes of a service are not in the expected JSON layout"; next }
f == "volumes" && i == 8 && /^        [{]/ { vt = ""; vs = ""; vro = 0; next }
f == "volumes" && i == 10 && /^          "type": / { vt = val($0); next }
f == "volumes" && i == 10 && /^          "source": / { vs = val($0); next }
f == "volumes" && i == 10 && /^          "read_only": true/ { vro = 1; next }
f == "volumes" && i == 8 && /^        [}]/ {
  if (svc == "") next
  if (!plain(vt)) { print "X " vt; next }
  if (vs != "" && !plain(vs)) { print "X " vs; next }
  n++; ms[n] = svc; mt[n] = unq(vt); mv[n] = (vs == "" ? "" : unq(vs)); mr[n] = vro
  next
}
top == "volumes" && i == 4 && /^    "/ { vk = key($0); next }
top == "volumes" && i == 6 && /^      "name": / { v = val($0); if (plain(v)) vname[vk] = unq(v); else print "X " v; next }
END {
  for (j = 1; j <= n; j++) {
    s = mv[j]
    if (mt[j] == "volume" && s != "" && substr(s, 1, 1) != "/") s = (s in vname) ? vname[s] : proj "_" s
    printf "M\t%s\t%s\t%s\t%d\n", ms[j], mt[j], s, mr[j]
  }
}
`

/** Shell: before `up --no-recreate` of the infra services (`svcs`: a shell word
 *  list such as `$INFRA_SVCS`), refuse when an EXISTING container of one of them (any
 *  state) mounts something the checked config does not give that service. compose
 *  starts such a container as it is, with the binds it was created with, so a stale
 *  exited db container with an old writable bind of a parent folder would come back
 *  between two guards. Compared per container (`docker inspect` .Mounts) with the
 *  interpolated config's mounts of its service:
 *  - a bind: its source must be a bind source of the service; writable only when one of
 *    those entries is writable;
 *  - a volume: its name must be a named volume of the service (the same read_only rule),
 *    or an anonymous volume (64 hex, an image VOLUME or `- /data`) whose server copy has
 *    no driver options;
 *  - tmpfs passes; any other mount type refuses.
 *  Not the compose config-hash label: in practice every infra container's hash differs
 *  from `config --hash` (override and label files), so a hash rule would block every app.
 *  Run it after the env file guard (it reads the interpolated config). Exits 1 (the
 *  caller's shell) on a refusal. */
export function infraMountGuardShell(cf: string, svcs: string): string {
	return (
		`{ IG_CFG=$(docker compose ${cf} ${ALL_PROFILES} config --format json 2>/dev/null) || { echo "infra guard: refusing, cannot read the compose config to compare the existing infra containers' mounts with it"; exit 1; }; ` +
		`IG_LIST=$(printf '%s\\n' "$IG_CFG" | LC_ALL=C awk ${shq(COMPOSE_JSON_SVC_MOUNTS_AWK)}); ` +
		`IG_BAD=$(printf '%s\\n' "$IG_LIST" | grep -E '^(E|X) ' | head -n 1); if [ -n "$IG_BAD" ]; then echo "infra guard: refusing, cannot read the service mounts of the compose config ($IG_BAD)"; exit 1; fi; ` +
		`IG_PROJ=$(printf '%s\\n' "$IG_LIST" | sed -n 's/^N //p' | head -n 1); IG_TAB=$(printf '\\t'); IG_RC=0; ` +
		`for IG_SVC in ${svcs}; do ` +
		`IG_IDS=$(docker ps -aq --filter "label=com.docker.compose.project=$IG_PROJ" --filter "label=com.docker.compose.service=$IG_SVC" 2>/dev/null) || { echo "infra guard: refusing, cannot list the containers of the infra service $IG_SVC"; exit 1; }; ` +
		`for IG_ID in $IG_IDS; do ` +
		`IG_MS=$(docker inspect --format '{{.Name}}{{println}}{{range .Mounts}}{{json .Type}}{{"\\t"}}{{json .Source}}{{"\\t"}}{{json .Name}}{{"\\t"}}{{.RW}}{{println}}{{end}}' -- "$IG_ID" 2>/dev/null) || { echo "infra guard: refusing, cannot read the mounts of the infra container $IG_ID (service $IG_SVC)"; exit 1; }; ` +
		`IG_CN=$(printf '%s\\n' "$IG_MS" | head -n 1); IG_CN=\${IG_CN#/}; ` +
		`IG_WHY=$(printf '%s\\n' "$IG_MS" | sed 1d | { IG_W=""; while IFS="$IG_TAB" read -r IG_T IG_S IG_N IG_RW; do [ -n "$IG_T" ] || continue; ` +
		`case "$IG_T$IG_S$IG_N" in (*'\\'*) IG_W="a mount printed with an escape ($IG_T $IG_S $IG_N)"; break;; esac; ` +
		`IG_T=\${IG_T#\\"}; IG_T=\${IG_T%\\"}; IG_S=\${IG_S#\\"}; IG_S=\${IG_S%\\"}; IG_N=\${IG_N#\\"}; IG_N=\${IG_N%\\"}; ` +
		`case "$IG_T" in ` +
		`(tmpfs) continue;; ` +
		`(bind) IG_K=$IG_S;; ` +
		`(volume) IG_K=$IG_N;; ` +
		`(*) IG_W="a $IG_T mount ($IG_S) the config does not give it"; break;; esac; ` +
		`if printf '%s\\n' "$IG_LIST" | grep -qxF -- "M$IG_TAB$IG_SVC$IG_TAB$IG_T$IG_TAB$IG_K\${IG_TAB}0"; then continue; fi; ` +
		`if printf '%s\\n' "$IG_LIST" | grep -qxF -- "M$IG_TAB$IG_SVC$IG_TAB$IG_T$IG_TAB$IG_K\${IG_TAB}1"; then if [ "$IG_RW" = true ]; then IG_W="the $IG_T $IG_K writable, while the config mounts it read-only"; break; fi; continue; fi; ` +
		`if [ "$IG_T" = volume ] && printf '%s' "$IG_N" | grep -qxE '[0-9a-f]{64}'; then ` +
		`IG_O=$(docker volume inspect --format '{{.Driver}}{{range $k, $v := .Options}};{{$k}}{{end}}' -- "$IG_N" 2>/dev/null) || IG_O=missing; ` +
		`if [ "$IG_O" = local ]; then continue; fi; IG_W="the anonymous volume $IG_N with driver / options '$IG_O'"; break; fi; ` +
		`IG_W="the $IG_T $IG_K, which the compose config does not give the service"; break; ` +
		`done; printf '%s' "$IG_W"; }); ` +
		`if [ -n "$IG_WHY" ]; then echo "infra guard: refusing, the existing container $IG_CN of the infra service $IG_SVC mounts $IG_WHY. The deploy starts it as it is (up --no-recreate), with the mounts it was created with. Remove the stale container on the server (docker rm $IG_CN) or redeploy it with a force-recreate of that service, then deploy again."; IG_RC=1; fi; ` +
		`done; done; [ "$IG_RC" = 0 ] || exit 1; }`
	)
}

/** refuse, in every mode, a compose whose service list depends on the active
 *  profiles: `config --services` must equal `--profile '*' config --services`. A
 *  service behind an inactive profile is missing from the plain resolved config but
 *  `up --no-deps <service>` starts it by name. One listing failing while the other
 *  works (a service that depends on a profiled one fails the plain listing) is refused
 *  too. Both failing passes: the compose does not parse, and the next compose step
 *  (preflight INVALID, the `up`) fails with compose's own error. Runs after the env file
 *  guard (a listing reads the env files) and before the bind guard. */
export function composeProfileGuardShell(cf: string): string {
	return (
		`{ PG_A=$(docker compose ${cf} config --services 2>/dev/null) && PG_AOK=1 || PG_AOK=0; ` +
		`PG_B=$(docker compose ${cf} ${ALL_PROFILES} config --services 2>/dev/null) && PG_BOK=1 || PG_BOK=0; ` +
		`if [ "$PG_AOK$PG_BOK" = 10 ] || [ "$PG_AOK$PG_BOK" = 01 ]; then echo "profile guard: refusing, the compose service list cannot be read both with and without every profile active (a service behind a profile, or one depending on it), so the safety rules cannot see every service. Remove the profiles: keys."; exit 1; fi; ` +
		`if [ "$PG_AOK$PG_BOK" = 11 ]; then PG_A=$(printf '%s\\n' "$PG_A" | LC_ALL=C sort -u | tr '\\n' ' '); PG_B=$(printf '%s\\n' "$PG_B" | LC_ALL=C sort -u | tr '\\n' ' ');` +
		`if [ "$PG_A" != "$PG_B" ]; then echo "profile guard: refusing, the compose has services behind a profile (services: $PG_B; without profiles: $PG_A). powder's safety rules must see every service an up can start by name. Remove the profiles: keys."; exit 1; fi; fi; }`
	)
}

/** Every on-server guard that must run before compose reads or mounts anything:
 *  the env file link guard, the profile guard, then the bind / file
 *  path link guard. */
export function onServerComposeGuardShell(
	cf: string,
	app: string,
	workingDir: string,
	opts: { checkName?: boolean } = {},
): string {
	return `${envFileLinkGuardShell(cf, app, workingDir)} && ${composeProfileGuardShell(cf)} && ${bindLinkGuardShell(cf, app, workingDir, '/opt/apps', opts.checkName !== false)}`
}

/** what checkComposeForRecreate (lib/recreate-guard.ts) hands a recreate: the
 *  deploy's compose guard ran on the compose on disk and allowed it. `hash`: the full
 *  config hash (composeConfigHashShell) that check saw, pinned before the `up` ('' =
 *  nothing to pin: a warn-mode probe that could not read the config, or a container that
 *  is no registered app). `app`: the app it was checked as (null = not a registered app). */
export interface RecreateApproval {
	readonly hash: string
	readonly app: string | null
	readonly log: string
}

/** Shell: refuse when the full compose config hash moved since the recreate check. */
export function recreatePinShell(cf: string, approval: RecreateApproval): string {
	if (!/^[0-9a-f]{64}$/.test(approval.hash)) return ''
	return (
		`CG_H=$(${composeConfigHashShell(cf)}); if [ "$CG_H" != ${shq(approval.hash)} ]; then ` +
		`echo "compose guard: refusing the recreate, the resolved compose config changed after powder checked it (a file or a container changed it in between). Try again; a deploy re-checks it."; exit 1; fi; `
	)
}

/** THE way to run `docker compose up -d --force-recreate` outside
 *  buildDeployScript (domain apply, rollbacks, manual apply). Runs under bash
 *  pipefail so a failed `up` is not hidden by `| tail`, and under the per-app
 *  deploy flock so the recreate cannot land inside a running deploy's
 *  swap-to-migrate window.
 *  - `cf`: compose file args (default `-f <composeFile>`; pass composeFileArgs()
 *    for multi-file apps)
 *  - `targets`: service list as shell text (default the quoted service; a
 *    caller may pass an exported shell variable such as `$TARGETS`)
 *  - `tail`: keep only the last N output lines (default 10; null = all)
 *  - `lock: false`: the caller already holds the app lock (appLockShell); a
 *    second flock on the same file from a child would deadlock against it
 *  Always `--no-build`: these callers recreate from images a deploy
 *  already built and checked. Without it a missing image, or `pull_policy: build`,
 *  made compose build the repo's raw Dockerfile here, without the deploy's
 *  Dockerfile rewrite (build-cache.ts) and label override. A missing image now
 *  fails the `up` instead. buildDeployScript's own `up` does not use this.
 *  `--no-build` drops the build section, so a missing image, or `pull_policy:
 *  always` (daily, ...) on a build service, made compose PULL its `image:` with root's
 *  registry logins. powder's override (part of every caller's `cf`, composeFileArgs)
 *  pins `pull_policy: never` on every build service (renderOverride); services without a
 *  build keep compose's default, so a missing public infra image is still pulled. */
export function composeUpCommand(
	composeFile: string,
	service: string,
	/** REQUIRED: the lock path derives from the compose WORKING dir (the same one the deploy
	 *  script locks); dirname(composeFile) differs for configs kept in a subdirectory, which
	 *  made rollbacks take a different flock than the deploy. */
	workingDir: string,
	/** `app`: the app_repos container_name. One authority for the project-name check:
	 *  every caller that knows the app passes it; without it the name is not checked
	 *  (the roots fall back to the working dir's basename). */
	/** `approval`: REQUIRED. Only checkComposeForRecreate makes one: every
	 *  recreate first runs the deploy's compose guard on the compose on disk. */
	opts: { cf?: string; targets?: string; tail?: number | null; lock?: boolean; app?: string; approval: RecreateApproval },
): string {
	const lock = appLockPath(workingDir, service)
	// the env_file / label_file and mount source symlink checks run before
	// every recreate here too (rollback, domain apply, manual apply): `up` reads those
	// files and mounts those sources as root.
	const app = opts.app ?? (workingDir.replace(/\/+$/, '').split('/').pop() || service)
	const cf = opts.cf ?? `-f ${shq(composeFile)}`
	const targets = opts.targets ?? shq(service)
	const tail = opts.tail === undefined ? 10 : opts.tail
	// A service list must never drag its depends_on services into the recreate:
	// any `up` of a dependent recreates a dependency whose image/config changed
	// (e.g. a moved image tag), which bounced the bundled db.
	// A `$VAR` target list may be empty (recreate all), so the flag follows it.
	const varTarget = /^\$(\w+)$/.exec(targets)
	const noDeps = varTarget ? `\${${varTarget[1]}:+--no-deps} ` : '--no-deps '
	const inner =
		(opts.lock === false ? '' : appLockShell(lock)) +
		`${onServerComposeGuardShell(cf, app, workingDir, { checkName: opts.app !== undefined })} && ` +
		`{ ${recreatePinShell(cf, opts.approval)}true; } && ` +
		`docker compose ${cf} up -d --no-build --force-recreate ${noDeps}${targets} 2>&1${tail ? ` | tail -${tail}` : ''}`
	return `bash -o pipefail -c ${shq(inner)}`
}

export async function composeUpService(
	server: ServerConfig,
	configFile: string,
	service: string,
	onChunk: ((chunk: string) => void) | undefined,
	/** workingDir: compose working dir (the lock path derives from it); composeFiles: every -f the app was started with. */
	opts: { workingDir: string; composeFiles?: string[]; app?: string; approval: RecreateApproval },
): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr, code } = await runCommand(
		server,
		composeUpCommand(configFile, service, opts.workingDir, {
			tail: null,
			approval: opts.approval,
			cf: composeFileArgs(configFile, opts.composeFiles),
			...(opts.app !== undefined ? { app: opts.app } : {}),
		}),
		// flock wait (90s) + the recreate itself
		180_000,
		onChunk,
	)
	if (code !== 0) throw new Error(stderr || stdout || 'compose up failed')
	return { stdout, stderr }
}

/** `-f a.yml -f b.yml` for every compose file the app was started with, plus powder's
 *  own override (`docker-compose.powder.yml`, see compose-override.ts) as the LAST -f.
 *  The override is added only when the file exists on the server (a shell test, so an app
 *  powder never wrote one for keeps working); a stale copy of it in the container's
 *  config_files label is dropped and re-added last. `override: false` = the user's own
 *  files only (what the override writer resolves ports and opt-outs from). */
export function composeFileArgs(
	configFile: string,
	composeFiles?: string[],
	opts: { override?: boolean } = {},
): string {
	const all = composeFiles && composeFiles.length > 0 ? composeFiles : [configFile]
	// Never pass powder's per-deploy temp overrides back in (see isPowderTempComposeFile).
	const files = all.filter((f) => f.split('/').pop() !== OVERRIDE_FILE && !isPowderTempComposeFile(f))
	const user = (files.length > 0 ? files : [configFile]).map((f) => `-f ${shq(f)}`).join(' ')
	if (opts.override === false) return user
	const ov = overridePathFor(configFile, composeFiles)
	if (!isSafeOverridePath(ov)) return user
	return `${user} $([ -f ${shq(ov)} ] && printf '%s %s' -f ${shq(ov)})`
}

// Images that are state/infra, never "the app": a deploy recreates only the
// app service when any of these sit beside it, and never `down`s the project.
const INFRA_IMAGE_RE =
	/(^|\/)(postgres|pgvector|postgis|timescaledb|mysql|mariadb|redis|valkey|keydb|dragonfly|mongo|memcached|rabbitmq|minio|elasticsearch|opensearch|clickhouse|traefik)([:@]|$)/i

const INFRA_NAME_RE = /^(db|kv|postgres|redis|traefik)$/

const INFRA_DATA_DIR_RE =
	/^\/(var\/lib\/(postgresql|mysql|mongodb|redis|rabbitmq)|data\/db|bitnami)(\/|$)/

/** Which services in a resolved `docker compose config --format json` are
 *  infrastructure (database/cache/proxy), excluding `appService`. Pure. */
export function infraServicesFromConfig(config: unknown, appService: string): string[] {
	const services = (config as { services?: Record<string, Record<string, unknown>> })?.services
	if (!services || typeof services !== 'object') return []
	const out: string[] = []
	for (const [name, svc] of Object.entries(services)) {
		if (name === appService || !svc || typeof svc !== 'object') continue
		if (svc.build) continue // anything we build is an app, whatever its name
		const image = typeof svc.image === 'string' ? svc.image : ''
		const volumes = Array.isArray(svc.volumes)
			? (svc.volumes as Array<Record<string, unknown>>)
			: []
		const holdsData = volumes.some(
			(v) =>
				v &&
				v.type === 'volume' &&
				typeof v.target === 'string' &&
				INFRA_DATA_DIR_RE.test(v.target),
		)
		if (INFRA_NAME_RE.test(name) || INFRA_IMAGE_RE.test(image) || holdsData) out.push(name)
	}
	return out
}

/** The resolved `docker compose config --format json` of the target, or null
 *  when it can't be read or parsed. `cf` is composeFileArgs(). Shared by the
 *  builder phase and the deploy script's infra detection. */
export async function readComposeConfig(server: ServerConfig, cf: string): Promise<unknown | null> {
	const { stdout, code } = await runCommand(
		server,
		// never let compose read a file that uses include / extends (the deploy's
		// env file guard refuses it with the reason; here the config is just unreadable).
		`{ ${composeRawGuardShell(cf)}; } >/dev/null 2>&1 && docker compose ${cf} ${ALL_PROFILES} config --format json 2>/dev/null`,
		30_000,
	)
	if (code !== 0 || !stdout.trim()) return null
	try {
		return JSON.parse(stdout)
	} catch {
		return null
	}
}

/** Resolve the infra services from the target's compose config. null when the
 *  config can't be read (the script then falls back to the name heuristic). */
export async function resolveInfraServices(
	server: ServerConfig,
	cf: string,
	appService: string,
): Promise<string[] | null> {
	try {
		const config = await readComposeConfig(server, cf)
		return config === null ? null : infraServicesFromConfig(config, appService)
	} catch {
		return null
	}
}

/** Shell fragment that sets HAS_INFRA (count of infra services beside the app). */
export function infraCountShell(infra: string[] | null): string {
	if (infra === null) {
		return `HAS_INFRA=$(printf '%s\\n' "$SVC_LIST" | grep -cE '^(db|kv|postgres|redis|traefik)$' || true) && `
	}
	return `HAS_INFRA=${infra.length} && echo ${shq(`[infra] ${infra.length ? infra.join(',') : 'none'} (by image/volume)`)} && `
}

/** in the workdir and preview layouts the workdir IS the git
 *  checkout, so a tracked top-level `.env` becomes compose's project .env. Its
 *  plain keys only feed `${VAR}` interpolation of the compose file (which the
 *  repo already controls in that layout, and some apps rely on), so those
 *  stay. COMPOSE_* / DOCKER_* keys change how compose itself runs (project name,
 *  profiles, daemon), which retargets the deploy: refuse, naming the key (the
 *  substring anywhere in the file, any case). A
 *  tracked .env that is a symlink is refused too. `gitSafeDir` is the quoted
 *  safe.directory value. Run from the workdir. */
export function trackedDotenvGuardShell(gitSafeDir: string): string {
	return [
		`if ${gitCmd(gitSafeDir)} ls-files --error-unmatch -- .env >/dev/null 2>&1; then `,
		'if [ -L .env ]; then echo "deploy: refusing, the repo tracks a top-level .env that is a symlink (compose would read it as the project .env)"; exit 1; fi; ',
		// anywhere on a line, any case (`A="x" COMPOSE_PROJECT_NAME=victim` and
		// lower-case keys passed the line-start match). A plain key that only contains the
		// word (MY_DOCKER_TAG) is refused too: rename it or set it in powder.
		"DE_BAD=$(grep -ioE '(COMPOSE|DOCKER)_[A-Za-z0-9_]*' .env 2>/dev/null | sort -u | tr '\\n' ' '); ",
		'if [ -n "$DE_BAD" ]; then echo "deploy: refusing, the repo tracks a top-level .env that sets $DE_BAD- compose reads it as the project .env, which changes the compose project/daemon of this deploy. Remove those keys from the committed .env (or stop tracking .env; set app env in powder)"; exit 1; fi; ',
		'fi',
	].join('')
}

/** After the git sync: the compose project name must be what the preflight
 *  orphan guard checked (CP_PROJ). A synced repo file must not move the deploy
 *  into another project. Uses $CP_PROJ from the preflight. `marker` (the run's
 *  nonce-tagged projectChangedMarkerFor) is printed on a refusal, so the runner puts
 *  the checkout back on the last good commit (resetCheckoutAfterRefusal). */
export function composeProjectStableShell(cf: string, marker = ''): string {
	return [
		`CP_PROJ2=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null | awk '/^name:/{print $2; exit}'); `,
		`if [ -n "$CP_PROJ" ] && [ "$CP_PROJ2" != "$CP_PROJ" ]; then echo "deploy: refusing, the compose project changed during the git sync ('$CP_PROJ' -> '$CP_PROJ2'); a repo file (e.g. a tracked .env) must not retarget the deploy"; ${marker ? `echo ${shq(marker)}; ` : ''}exit 1; fi`,
	].join('')
}

/** the marker composeProjectStableShell prints on a refusal, tagged with the run's
 *  nonce so build output cannot fake it. */
export function projectChangedMarkerFor(nonce: string): string {
	return `__POWDER_PROJECT_CHANGED_${nonce.replace(/[^A-Za-z0-9]/g, '')}__`
}

/** ERE matching a JSON-escaped CR or LF (`\n` / `\r` preceded by an even
 *  number of backslashes, so an escaped literal backslash followed by `n` does
 *  not match) in `docker inspect -f '{{json .Config.Labels}}'` output. */
const JSON_LINEBREAK_ERE = String.raw`(^|[^\\])(\\\\)*\\[nr]`

/** ERE (use with grep -i) matching `traefik.` anywhere inside a JSON object
 *  KEY of `{{json .Config.Labels}}`. A key starts right after `{"` or `,"`;
 *  inside a JSON string a quote is always escaped, so `,"` never occurs inside
 *  a value. Case-insensitive because Traefik label parsing is. */
const JSON_TRAEFIK_KEY_ERE = String.raw`[{,]"([^"\\]|\\.)*traefik\.`

/** the com.docker.compose.* label keys powder or compose READ from a container
 *  (project membership, the compose files and dir powder re-reads, one-off and replica
 *  bookkeeping). A container powder starts outside compose (bridge, URL snapshot,
 *  rollback bridge) sets each one empty, so an image label cannot place it in another
 *  project or point powder at another compose file (container labels win over image
 *  labels on `docker run`/`create`). */
const COMPOSE_LABEL_KEYS = [
	'com.docker.compose.project',
	'com.docker.compose.service',
	'com.docker.compose.version',
	'com.docker.compose.project.config_files',
	'com.docker.compose.project.working_dir',
	'com.docker.compose.project.environment_file',
	'com.docker.compose.oneoff',
	'com.docker.compose.container-number',
	'com.docker.compose.config-hash',
	'com.docker.compose.depends_on',
	'com.docker.compose.image',
	'com.docker.compose.replace',
] as const
export const COMPOSE_LABEL_BLANKS = COMPOSE_LABEL_KEYS.map((k) => `--label ${k}=`).join(' ')

/** the only com.docker.compose.* IMAGE labels compose itself writes: `docker
 *  compose build` labels the image with project, service and version
 *  (compose v2 getImageBuildLabels), so every image compose builds carries those
 *  three. Every other com.docker.compose.* key is container state compose sets at
 *  `create` (config_files, working_dir, oneoff, ...) and never belongs on an image; an
 *  image carrying one is refused in every mode. */
const IMAGE_COMPOSE_LABELS_OK = ['com.docker.compose.project', 'com.docker.compose.service', 'com.docker.compose.version'] as const

/** Shell: reads `{{json .Config.Labels}}` text from $1 and prints every com.docker.compose.*
 *  key that is not one compose writes on a build (one per line, JSON-quoted). */
const IMAGE_COMPOSE_BAD_KEYS_SH = String.raw`grep -oE '[{,]"com\.docker\.compose\.[^"]*"' | sed 's/^[{,]//' | grep -vxE '"com\.docker\.compose\.(project|service|version)"'`

/** Pure (TS side of the same rule): the disallowed compose label keys of an image. */
export function imageComposeLabelProblems(labels: Record<string, unknown> | null | undefined): string[] {
	return Object.keys(labels ?? {}).filter(
		(k) => k.startsWith('com.docker.compose.') && !(IMAGE_COMPOSE_LABELS_OK as readonly string[]).includes(k),
	)
}

/** an image LABEL traefik.* would be merged into the container's
 *  labels and could add a higher-priority router for another tenant's hostname.
 *  powder renders every traefik label itself in compose, so a built/pulled image
 *  carrying one fails the deploy. The image is ALWAYS resolved: $STAGE_IMG, else
 *  $IMGREF, else `docker compose config --images <service>`, else
 *  `${CP_PROJ}-<service>`. Fails closed when nothing resolves and the service has
 *  a build: key ($HAS_BUILD=y), so previews/first deploys/image-less services are
 *  not skipped. */
export function imageLabelGuardShell(cf = '', service = 'app'): string {
	return (
		`{ LB_IMG="\${STAGE_IMG:-\${IMGREF:-}}"; ` +
		`if [ -z "$LB_IMG" ]; then LB_IMG=$(docker compose ${cf} ${ALL_PROFILES} config --images ${shq(service)} 2>/dev/null | head -n 1); fi; ` +
		`if [ -z "$LB_IMG" ] && [ -n "\${CP_PROJ:-}" ]; then LB_IMG="$CP_PROJ-"${shq(service)}; fi; ` +
		`if [ -z "$LB_IMG" ] && [ "\${HAS_BUILD:-}" = "y" ]; then echo "image labels: cannot resolve the image of the built service, refusing (cannot verify it carries no traefik.* label)"; exit 1; fi; ` +
		`if [ -n "$LB_IMG" ]; then if ! LB_L=$(docker image inspect -f '{{json .Config.Labels}}' "$LB_IMG" 2>/dev/null); then ` +
		`if [ "\${HAS_BUILD:-}" = "y" ]; then echo "image labels: cannot inspect image $LB_IMG (no such image), refusing (cannot verify it carries no traefik.* label)"; exit 1; fi; LB_L=""; fi; fi; ` +
		`if [ -n "$LB_IMG" ] && printf '%s' "\${LB_L:-}" | grep -qE ${shq(JSON_LINEBREAK_ERE)}; then ` +
		`echo "image labels: $LB_IMG carries a label key or value with a line break (CR/LF). powder refuses it: a line break can smuggle extra labels into a label file"; exit 1; fi; ` +
		`if [ -n "$LB_IMG" ] && printf '%s' "\${LB_L:-}" | grep -qiE ${shq(JSON_TRAEFIK_KEY_ERE)}; then ` +
		`echo "image labels: $LB_IMG carries a traefik.* image label. powder renders all traefik labels itself in compose; remove the LABEL traefik.* lines from the Dockerfile"; exit 1; fi; ` +
		// every mode (an image-level attack, no compose rule code).
		`if [ -n "$LB_IMG" ]; then LB_CK=$(printf '%s' "\${LB_L:-}" | ${IMAGE_COMPOSE_BAD_KEYS_SH} | tr '\n' ' '); if [ -n "$LB_CK" ]; then ` +
		`echo "image labels: $LB_IMG carries com.docker.compose.* image label(s) compose never sets on an image: $LB_CK- powder refuses it (they would place containers powder starts from it in another compose project or point powder at other compose files). Remove those LABEL lines"; exit 1; fi; fi; }`
	)
}

/** the image label rule for EVERY other service of the compose (workers,
 *  crons, sidecars, infra), not only the deployed one. A label check must see the
 *  image `up` will run, so before checking, this does now what `up` would have done
 *  anyway: a service with a build section is built when its image is missing or it
 *  has `pull_policy: build`, a service without one is pulled when its image is
 *  missing or its `pull_policy` pulls anyway (always, daily, ...). Each service built or pulled here gets
 *  `pull_policy: missing` in an override ($LB_F, passed to `up`/`run` only), so `up`
 *  runs exactly the image that was checked instead of building or pulling again; the
 *  deployed service gets the same pin when its policy would build or pull again (it
 *  was built or pulled in this run). A service whose image still cannot be inspected
 *  is refused, except `pull_policy: never` (its `up` fails on its own). A build or
 *  pull that fails here is a WARN and the deploy goes on as it did when `up` did
 *  that work (the has-infra path tolerates a failing infra `up`); the service is
 *  then pinned `pull_policy: never`, so `up` cannot fetch an unchecked image. Needs
 *  $DFR_DIR/list (the Dockerfile check: one `svc|...` line per service that builds).
 *  Images that carry a traefik.* or CR/LF label are refused like the deployed one's.
 *  `build`: the command prefix a build runs under (lock + timeout). `pull`: build
 *  with --pull like the deployed service (POWDER_BUILD_PULL applies to every
 *  service the deploy builds).
 *  a service with a build section is never pulled: a policy that pulls
 *  (always, daily, ...) builds it when its image is missing and otherwise pins
 *  `pull_policy: missing`, and the pull passes `--ignore-buildable`. Its `image:` may
 *  name a private repo root's registry login would fetch. powder's override pins every
 *  build service `pull_policy: never`, so `never` on a build service whose image is
 *  missing builds it here too (as `up` would), checked like any other. */
export function serviceImageLabelGuardShell(
	cf: string,
	cfb: string,
	service: string,
	build: string,
	pull = false,
): string {
	const field = (f: string) => `awk -v svc="$LB_S" -v f=${f} ${shq(SERVICE_FIELD_AWK)}`
	return (
		`{ LB_CFG=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null) && LB_ALL=$(docker compose ${cf} ${ALL_PROFILES} config --services 2>/dev/null) || { echo "image labels: cannot list the compose services, refusing (cannot verify their images carry no traefik.* label)"; exit 1; }; ` +
		`LB_OV="$DFR_DIR/labels.yml"; printf 'services:\n' > "$LB_OV"; LB_N=0; ` +
		`for LB_S in $LB_ALL; do ` +
		`LB_PP=$(printf '%s\n' "$LB_CFG" | ${field('pull_policy:')}); ` +
		`if [ "$LB_S" = ${shq(service)} ]; then case "$LB_PP" in ""|missing|if_not_present|never) ;; *) printf '  %s:\n    pull_policy: missing\n' "$LB_S" >> "$LB_OV"; LB_N=$((LB_N+1));; esac; continue; fi; ` +
		`LB_I=$(docker compose ${cf} ${ALL_PROFILES} config --images "$LB_S" 2>/dev/null | head -n 1); ` +
		`if [ -z "$LB_I" ] && [ -n "\${CP_PROJ:-}" ]; then LB_I="$CP_PROJ-$LB_S"; fi; ` +
		`if [ -z "$LB_I" ]; then echo "image labels: cannot resolve the image of service $LB_S, refusing"; exit 1; fi; ` +
		`LB_HAVE=n; docker image inspect "$LB_I" >/dev/null 2>&1 && LB_HAVE=y; LB_PIN=n; ` +
		`LB_HB=n; cut -d'|' -f1 "$DFR_DIR/list" 2>/dev/null | grep -qxF -- "$LB_S" && LB_HB=y; LB_DO=""; ` +
		`case "$LB_PP" in never) if [ "$LB_HB" = y ] && [ "$LB_HAVE" = n ]; then LB_DO=build; fi;; ""|missing|if_not_present) if [ "$LB_HAVE" = n ]; then if [ "$LB_HB" = y ]; then LB_DO=build; else LB_DO=pull; fi; fi;; build) LB_DO=build;; *) if [ "$LB_HB" = y ]; then if [ "$LB_HAVE" = n ]; then LB_DO=build; else LB_PIN=missing; fi; else LB_DO=pull; fi;; esac; ` +
		`if [ "$LB_DO" = build ]; then echo "[image labels] building service $LB_S now (up would build it) to check its labels"; if ${build} docker compose ${cfb} build ${pull ? '--pull ' : ''}"$LB_S" 2>&1; then LB_PIN=missing; else LB_PIN=never; echo "[image labels] WARN building service $LB_S failed; continuing as before, but up will neither build nor pull it (pull_policy: never), so no unchecked image can start"; fi; fi; ` +
		`if [ "$LB_DO" = pull ]; then echo "[image labels] pulling service $LB_S now (up would pull it) to check its labels"; if retry timeout "$(cap 600 240)" docker compose ${cf} pull --ignore-buildable "$LB_S" 2>&1; then LB_PIN=missing; else LB_PIN=never; echo "[image labels] WARN pulling service $LB_S failed; continuing as before, but up will neither pull nor build it (pull_policy: never), so no unchecked image can start"; fi; fi; ` +
		`if [ "$LB_PIN" != n ]; then printf '  %s:\n    pull_policy: %s\n' "$LB_S" "$LB_PIN" >> "$LB_OV"; LB_N=$((LB_N+1)); fi; ` +
		`if ! LB_L=$(docker image inspect -f '{{json .Config.Labels}}' "$LB_I" 2>/dev/null); then ` +
		`if [ "$LB_PP" = never ] || [ "$LB_PIN" = never ]; then echo "[image labels] service $LB_S: no image $LB_I and pull_policy never, skipped"; continue; fi; ` +
		`echo "image labels: cannot inspect image $LB_I of service $LB_S, refusing (cannot verify it carries no traefik.* label)"; exit 1; fi; ` +
		`if printf '%s' "$LB_L" | grep -qE ${shq(JSON_LINEBREAK_ERE)}; then echo "image labels: $LB_I (service $LB_S) carries a label key or value with a line break (CR/LF). powder refuses it: a line break can smuggle extra labels into a label file"; exit 1; fi; ` +
		`if printf '%s' "$LB_L" | grep -qiE ${shq(JSON_TRAEFIK_KEY_ERE)}; then echo "image labels: $LB_I (service $LB_S) carries a traefik.* image label. powder renders all traefik labels itself in compose; remove the LABEL traefik.* lines from that image"; exit 1; fi; ` +
		`LB_CK=$(printf '%s' "$LB_L" | ${IMAGE_COMPOSE_BAD_KEYS_SH} | tr '\n' ' '); if [ -n "$LB_CK" ]; then echo "image labels: $LB_I (service $LB_S) carries com.docker.compose.* image label(s) compose never sets on an image: $LB_CK- powder refuses it. Remove those LABEL lines from that image"; exit 1; fi; ` +
		`done; ` +
		// An empty set stays a valid compose file: an older container's config_files
		// label may still name this labels.yml.
		`if [ "$LB_N" -gt 0 ]; then LB_F="-f $LB_OV"; else printf 'services: {}\n' > "$LB_OV"; fi; }`
	)
}

/** Verdict of bridge_start, read back by the runner (deploy/run.ts) into one deduped
 *  HQ warn card per app (hq.ts). bridged / not-routed resolve the card; the rest
 *  raise it. No verdict (curl missing, no running container, container not running,
 *  or a script that never reached the bridge) means unknown: nothing is posted.
 *  Two verdicts cover apps traefik does not route and that have no bridge label,
 *  so they do not pass for not-routed: `nginx-unbridged` when host nginx proxies to
 *  the container's published 127.0.0.1 port, `host-network` when the container runs
 *  with network_mode host. Both are warnings only (POWDER_STABILITY_CARDS gates
 *  their card); any failure to read docker or nginx falls back to not-routed. */
export const BRIDGE_VERDICTS = ['bridged', 'not-routed', 'no-label', 'no-healthcheck', 'host-ports', 'unsupported', 'failed', 'internal', 'nginx-unbridged', 'host-network'] as const
export type BridgeVerdict = (typeof BRIDGE_VERDICTS)[number]

/** The verdict marker, tagged with the run's random nonce (like the sha marker) so
 *  build or test output cannot print it. No nonce: no marker is printed. */
export function bridgeVerdictMarkerFor(nonce: string): string {
	const n = nonce.replace(/[^A-Za-z0-9]/g, '')
	return n ? `__POWDER_BRIDGE_${n}__` : ''
}

/** The last nonce-tagged verdict line in the output, or null (unknown). */
export function parseBridgeVerdict(out: string, nonce: string): BridgeVerdict | null {
	const marker = bridgeVerdictMarkerFor(nonce)
	if (!marker) return null
	let v: BridgeVerdict | null = null
	for (const l of out.split('\n')) {
		if (!l.startsWith(`${marker} `)) continue
		const rest = l.slice(marker.length + 1).trim()
		if ((BRIDGE_VERDICTS as readonly string[]).includes(rest)) v = rest as BridgeVerdict
	}
	return v
}

/** Host nginx upstream checks (bridge_start runs them on every deploy, read-only via
 *  `nginx -T`), read back by the runner into two deduped HQ cards (hq.ts):
 *  - per SERVER (`nginx-upstream:<server>`): the names of upstreams whose only
 *    non-backup server lacks max_fails=0 while a `backup` server exists
 *    (NGINX_UPSTREAM_AWK). A one-server group never fails over (nginx ignores
 *    max_fails there) and a multi-primary group fails over to its peers, but one
 *    primary plus a backup is marked down by one slow response and, while the backup
 *    is not up, nginx answers 502/503 "no live upstreams" for fail_timeout
 *    (e.g. a host-network app with an empty backup line). Empty list
 *    resolves the card.
 *  - per APP (`bridge-upstream:<server>/<app>`), host-port bridge mode only: `ok`
 *    when an upstream lists `127.0.0.1:<N> backup`, `no-upstream` when none does
 *    (the bridge runs but gets no traffic), `n/a` when the app is not in host-port
 *    mode (resolves the card).
 *  No line (nginx absent, nginx -T failed, script never reached the bridge) means
 *  unknown: nothing is posted. */
export const BRIDGE_UPSTREAM_VERDICTS = ['ok', 'no-upstream', 'n/a'] as const
export type BridgeUpstreamVerdict = (typeof BRIDGE_UPSTREAM_VERDICTS)[number]
export type NginxUpstreamVerdict = {
	/** bad upstream names on the server, [] = clean, null = nginx unreadable / not run */
	server: string[] | null
	/** host-port bridge upstream of this app, null = unknown */
	app: BridgeUpstreamVerdict | null
}

/** The nginx checks' verdict marker, nonce-tagged like the bridge verdict marker. */
export function nginxUpstreamMarkerFor(nonce: string): string {
	const n = nonce.replace(/[^A-Za-z0-9]/g, '')
	return n ? `__POWDER_NGINXUP_${n}__` : ''
}

const UPSTREAM_NAME = /^[A-Za-z0-9_.:-]{1,64}$/

/** The last nonce-tagged `scan [names...]` and `app <verdict>` lines in the output. */
export function parseNginxUpstreamVerdict(out: string, nonce: string): NginxUpstreamVerdict {
	const v: NginxUpstreamVerdict = { server: null, app: null }
	const marker = nginxUpstreamMarkerFor(nonce)
	if (!marker) return v
	for (const l of out.split('\n')) {
		if (!l.startsWith(`${marker} `)) continue
		const [kind, ...rest] = l.slice(marker.length + 1).trim().split(/\s+/)
		if (kind === 'scan') {
			if (rest.every((n) => UPSTREAM_NAME.test(n))) v.server = [...new Set(rest)].slice(0, 20)
		} else if (kind === 'app' && rest.length === 1 && (BRIDGE_UPSTREAM_VERDICTS as readonly string[]).includes(rest[0] ?? '')) {
			v.app = rest[0] as BridgeUpstreamVerdict
		}
	}
	return v
}

// Shared awk prelude over `nginx -T`: strips comments, joins the dump into one line
// and walks every `upstream <name> { ... }` block (no nested braces in an upstream),
// calling blk(name, body). POSIX awk only (mawk on the hosts): no regex intervals.
// Prints nothing of the config itself.
const UPSTREAM_WALK =
	String.raw`{ sub(/#.*/, ""); buf = buf " " $0 } ` +
	String.raw`END { gsub(/[\t\r\n]/, " ", buf); ` +
	String.raw`while (match(buf, /[ ;{}]upstream[ ]+[^ {};]+[ ]*[{][^}]*[}]/)) { ` +
	String.raw`blk = substr(buf, RSTART + 1, RLENGTH - 1); buf = substr(buf, RSTART + RLENGTH); ` +
	String.raw`nm = substr(blk, 9, index(blk, "{") - 9); gsub(/ /, "", nm); blk = substr(blk, index(blk, "{") + 1); sub(/[}]$/, "", blk); ` +
	String.raw`n = split(blk, d, ";"); nb = 0; np = 0; pbad = 0; hb = 0; ` +
	String.raw`for (i = 1; i <= n; i++) { s = " " d[i] " "; gsub(/[ ]+/, " ", s); if (s !~ /^ server /) continue; ` +
	String.raw`if (s ~ / backup /) { nb++; if (s ~ ("^ server (127[.]0[.]0[.]1|localhost|[[]::1[]]):" b " ")) hb = 1 } ` +
	String.raw`else { np++; if (s !~ / max_fails=0 /) pbad = 1 } } `

/** awk over `nginx -T`: prints the name of every upstream with a backup server and
 *  exactly one non-backup server, that one without max_fails=0. One per line. */
export const NGINX_UPSTREAM_AWK =
	UPSTREAM_WALK + String.raw`if (nb > 0 && np == 1 && pbad) print nm } }`

/** awk over `nginx -T` with -v b=<bridge port>: `ok` when an upstream lists
 *  127.0.0.1:<b> (or localhost / [::1]) as backup, else `no-upstream`. */
export const NGINX_BRIDGE_AWK =
	UPSTREAM_WALK + String.raw`if (hb) found = 1 } if (found) print "ok"; else print "no-upstream" }`

/** Boot-time schema push in an image command (ERE over
 *  `{{json .Config.Cmd}} {{json .Config.Entrypoint}}`): the bridge skips such an app
 *  unless it carries powder.bridge.boot-push-ok=true. */
export const BOOT_SCHEMA_PUSH_ERE = 'push[ ",]+--force|db[ ",]+push|accept-data-loss'

/** Any schema tool run outside powder-migrate: the boot push above plus drizzle-kit
 *  push/migrate, prisma migrate deploy, knex / typeorm / sequelize migrations and
 *  `migrate`-style package scripts or files. Built from BOOT_SCHEMA_PUSH_ERE so the
 *  two never drift apart; only the migrate-path warning uses the wider pattern (the
 *  bridge keeps the narrow one, so its decisions do not change). ERE, case-sensitive. */
export const SCHEMA_TOOL_ERE =
	BOOT_SCHEMA_PUSH_ERE +
	'|drizzle-kit[ ",]+(push|migrate)|prisma[ ",]+migrate[ ",]+deploy|knex[ ",]+migrate|migration:run|db:migrate' +
	'|(npm|pnpm|yarn|bun)[ ",]+(run[ ",]+)?[A-Za-z0-9:_-]*migrat|[ ",/]migrat[A-Za-z0-9_-]*[.](js|mjs|cjs|ts|mts|sh)'

/** A schema push in the powder.release.cmd label (migrate-path case release-cmd):
 *  the boot push above plus a bare `drizzle-kit push` and a `db:push` package
 *  script. A push diffs the live schema with no ledger, so it is flagged even
 *  without --force. A ledgered migrator in the label (knex migrate, prisma migrate
 *  deploy, a migrate script) is the supported path and does not match. ERE. */
export const RELEASE_SCHEMA_PUSH_ERE = BOOT_SCHEMA_PUSH_ERE + '|drizzle-kit[ ",]+push|db:push'

/** Verdict class of a bridge skip reason: a broken step (create/start/probe/read)
 *  is `failed`, a missing healthcheck its own class, a published host port its own
 *  class (the fix is a compose ports line, not the image), a powder self-check that
 *  should never trip on real docker output `internal` (a powder bug: the label-file
 *  line count sits behind the JSON line-break check; a trip refuses every bridge, so it
 *  is reported as a powder bug, not as an app's `unsupported`), any other `unsupported`. */
export function bridgeSkipClass(why: string): BridgeVerdict {
	if (/line count differs/.test(why)) return 'internal'
	if (/no healthcheck/.test(why)) return 'no-healthcheck'
	if (/publishes host ports/.test(why)) return 'host-ports'
	if (/failed|not answering|could not read/.test(why)) return 'failed'
	return 'unsupported'
}

/** Zero-downtime overlap ("bridge") shell functions for the deploy script.
 *
 *  `docker compose up --force-recreate` stops the old container before the new
 *  one listens; Traefik (docker provider) drops the router with it, so requests
 *  404 for the ~5s the new server needs. The bridge closes that gap: before the
 *  recreate we start a temporary clone of the RUNNING container (same image id,
 *  env, labels, networks, binds, memory cap) named `<container>-powder-bridge`.
 *  Traefik merges same-named services from several containers into one load
 *  balancer, so traffic keeps flowing to old + bridge during the swap. After the
 *  recreate, bridge_handoff waits for the new container to answer, then removes
 *  the bridge. The clone carries NO com.docker.compose.* labels (compose must
 *  never see it as part of the project) and no published ports (except the
 *  loopback port of host-port mode, below). The
 *  compose labels powder reads (project, service, config_files, working_dir,
 *  oneoff) are set empty on the create, so a `LABEL com.docker.compose.project=
 *  <other app>` in the image cannot place the bridge in another app's project.
 *
 *  Readiness uses State.Health when the container has a healthcheck (Traefik's
 *  docker provider drops non-healthy containers), else an HTTP 2xx-4xx probe.
 *  OPT-IN: only runs when the running container carries the label
 *  powder.bridge.enabled=true (Dockerfile LABEL or compose labels). It starts
 *  BEFORE `db migrate` (re-running the old image's startup, e.g. drizzle-kit push,
 *  against the old schema). Caveat (expand/contract): while old + bridge serve,
 *  the new migration is already applied, so migrations must stay backward
 *  compatible with the previous release - same constraint as any rolling deploy.
 *  The bridge has its own healthcheck (file /tmp/.powder-ready, touched only
 *  after the HTTP probe passes) so Traefik routes it only when ready, and the
 *  file is removed at handoff so Traefik drains it before stop.
 *  Requires a healthcheck on the current container (traefik mode). Skipped when the command
 *  pushes schema at boot (push --force / db push / accept-data-loss) unless the
 *  label powder.bridge.boot-push-ok=true: the bridge re-runs boot side effects,
 *  which can revert schema changes made since the old container booted.
 *  Never fails a deploy: every skip/failure path logs `[bridge] ...` and
 *  returns 0, and the EXIT trap (bridge_stop) removes the bridge on every exit.
 *  HOST-PORT MODE (nginx-fronted apps on a published loopback port): with the
 *  label powder.bridge.host-port=<N> (1024-65535, and N MUST be the app host
 *  port + 10000, so a label cannot grab another app's port while that app is
 *  recreated) next to powder.bridge.enabled=true, an app that publishes host
 *  ports is bridged too. The app must publish exactly one tcp port, bound to
 *  127.0.0.1 only (never 0.0.0.0). The
 *  bridge listens on the CONTAINER port of that binding (key "3001/tcp" -> 3001,
 *  not EXPOSE) and is published as `-p 127.0.0.1:N:<that port>`; its traefik.*
 *  labels are dropped (plus traefik.enable=false), no traefik router/service
 *  labels or docker healthcheck are required (nginx does not read docker
 *  health; readiness is the HTTP probe on the container IP) and the traefik
 *  label compare at handoff is skipped. A taken port fails create/start, which
 *  skips; bridge_stop removes the bridge (and so frees N) on every path. The
 *  operator adds the bridge as a backup upstream in the vhost:
 *    upstream <app>_app { server 127.0.0.1:<port> max_fails=0; server 127.0.0.1:<N> backup; }
 *    # in each proxied location:
 *    proxy_pass http://<app>_app;
 *    proxy_next_upstream error timeout;
 *  nginx then retries a refused/reset connection on the bridge while the app
 *  container is recreated. Traefik mode is unchanged by this label.
 *  max_fails=0 is required: with the default max_fails=1 one slow response marks
 *  the only primary down and nginx answers 502/503 "no live upstreams" for
 *  fail_timeout while the bridge is not running. `timeout` never re-sends a POST
 *  (nginx does not pass a sent non-idempotent request to the next server without
 *  `non_idempotent`); it retries on the backup only while the backup is up.
 *  Every deploy (any mode) runs bridge_nginx_scan over `nginx -T` (read-only) and
 *  warns per server on an upstream with one primary without max_fails=0 next to a
 *  backup; host-port apps also get bridge_nginx_check (no upstream lists the bridge
 *  port). Marker nginxUpstreamMarkerFor, cards in hq.ts; never fails a deploy.
 *  LOOPBACK PORTS IN TRAEFIK MODE: a traefik-routed app (traefik.enable + a
 *  router label) without the host-port label whose every published binding is
 *  loopback-only (127.0.0.1 / ::1, e.g. `127.0.0.1:3040:3000`) is
 *  bridged: the clone publishes no ports and the old container keeps its binding
 *  through the overlap. A binding on any other interface (0.0.0.0, a LAN ip, an
 *  empty HostIp) still skips, as verdict `host-ports`.
 *  In host-port mode only, extra_hosts are copied as --add-host when every entry
 *  is `name:ip` / `name:host-gateway` (strict charset); any other entry skips.
 *  Traefik mode still skips on any extra_hosts.
 *  Skipped (current behaviour kept) when: no running container, host ports
 *  published without a valid host-port label (unless loopback-only on a
 *  traefik-routed app, above; in host-port mode: not exactly one loopback tcp
 *  binding, or N not the app port + 10000), non-bridge networking, no explicit
 *  traefik router+service labels in traefik mode
 *  (worker / non-http / default-named service whose name depends on the
 *  stripped compose labels), mounts not expressible as binds, extra_hosts
 *  (traefik mode) / tmpfs / cap_add / sysctls / init / shm_size set, an invalid
 *  extra_hosts entry (host-port mode), command or
 *  entrypoint overridden vs the image, a label key/value holds a CR/LF (it
 *  would split into extra label-file lines, e.g. smuggled traefik.* labels),
 *  host lacks curl, or the bridge does not
 *  answer HTTP within 60s. Pure string builder: unit-tested + bash -n checked. */
export function bridgeShellFunctions(cf: string, service: string, workingDir: string, nonce = ''): string {
	const tag = `${workingDir}|${service}`
	const psq = `docker compose ${cf} ps -q ${shq(service)} 2>/dev/null | head -1`
	const skip = (why: string) => `echo "[bridge] skipped: ${why}"; bridge_unbridged ${bridgeSkipClass(why)} ${shq(why)}; bridge_stop; return 0;`
	const mark = bridgeVerdictMarkerFor(nonce)
	const nmark = nginxUpstreamMarkerFor(nonce)
	return (
		String.raw`BRIDGE=""; B_PORT=3000; B_HP=""; B_LF=""; B_EF=""; ` +
		String.raw`bridge_stop() { if [ -n "$BRIDGE" ]; then if [ "$(docker inspect -f '{{index .Config.Labels "powder.bridge"}}' "$BRIDGE" 2>/dev/null)" = ${shq(tag)} ]; then docker rm -f "$BRIDGE" >/dev/null 2>&1 || true; echo "[bridge] removed $BRIDGE"; fi; __bs=0; while [ "$__bs" -lt 10 ] && [ -n "$(docker ps -aq --filter ${shq('label=powder.bridge=' + tag)} 2>/dev/null)" ]; do docker ps -aq --filter ${shq('label=powder.bridge=' + tag)} 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true; __bs=$((__bs+1)); sleep 2; done; fi; BRIDGE=""; rm -f "$B_LF" "$B_EF" 2>/dev/null || true; B_LF=""; B_EF=""; return 0; }; ` +
		String.raw`bridge_http() { __ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" 2>/dev/null | awk '{print $1}'); [ -n "$__ip" ] || return 1; __code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$__ip:$2/" 2>/dev/null || true); case "$__code" in [234][0-9][0-9]) return 0 ;; *) return 1 ;; esac; }; ` +
		String.raw`bridge_probe() { __hs=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || true); if [ -n "$__hs" ]; then [ "$__hs" = healthy ]; return; fi; bridge_http "$1" "$2"; }; ` +
		String.raw`bridge_wait() { __pf=bridge_probe; if [ -n "$4" ]; then __pf="$4"; fi; __end=$(( $(date +%s) + $(cap "$1" 600) )); while [ "$(date +%s)" -lt "$__end" ]; do if $__pf "$2" "$3"; then return 0; fi; sleep 1; done; return 1; }; ` +
		// A traefik-routed app (traefik.enable true/1/t, any case, as traefik parses it:
		// powder installs Traefik with exposedbydefault=false; plus a router label) that cannot be
		// bridged 502s for the whole recreate. Log it and print the nonce-tagged verdict
		// (bridgeVerdictMarkerFor); the runner turns it into one deduped HQ card per app.
		// Never fails: always returns 0.
		String.raw`bridge_mark() { ${mark ? `echo ${shq(mark)}" $1"; ` : ''}return 0; }; ` +
		// host nginx checks (NGINX_UPSTREAM_AWK per server, NGINX_BRIDGE_AWK per
		// host-port app): read-only `nginx -T`, silent when nginx is absent or fails.
		String.raw`bridge_nginx_dump() { command -v nginx >/dev/null 2>&1 || return 1; __nt=""; if command -v timeout >/dev/null 2>&1; then __nt="timeout 20"; fi; __nx=$($__nt nginx -T 2>/dev/null) || return 1; [ -n "$__nx" ] || return 1; printf '%s\n' "$__nx"; }; ` +
		String.raw`bridge_nginx_scan() { __nx=$(bridge_nginx_dump) || return 0; __nb=$(printf '%s\n' "$__nx" | awk ${shq(NGINX_UPSTREAM_AWK)} 2>/dev/null) || return 0; __nx=""; __nb=$(printf '%s\n' "$__nb" | grep -E '^[A-Za-z0-9_.:-]+$' | sort -u | head -20 | tr '\n' ' '); __nb="${'$'}{__nb% }"; ` +
		String.raw`if [ -n "$__nb" ]; then echo "[nginx] WARNING: upstream(s) with one primary without max_fails=0 plus a backup: $__nb - one slow response marks the primary down and nginx answers 502/503 (no live upstreams) for fail_timeout; add max_fails=0 to the primary server line"; else echo "[nginx] upstreams ok (no single primary without max_fails=0 next to a backup)"; fi; ${nmark ? `echo ${shq(nmark)}" scan $__nb"; ` : ''}return 0; }; ` +
		String.raw`bridge_nginx_check() { __nx=$(bridge_nginx_dump) || return 0; __nv=$(printf '%s\n' "$__nx" | awk -v b="$1" ${shq(NGINX_BRIDGE_AWK)} 2>/dev/null || true); __nx=""; ` +
		String.raw`case "$__nv" in ok) echo "[bridge] nginx lists 127.0.0.1:$1 as a backup upstream" ;; no-upstream) echo "[bridge] WARNING: no nginx upstream lists 'server 127.0.0.1:$1 backup;' - the bridge runs but gets no traffic, expect 502s during the swap; add the bridge as a backup upstream in the vhost" ;; *) return 0 ;; esac; B_NGA="$__nv"; return 0; }; ` +
		String.raw`bridge_routed() { __tl=$(docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$1" 2>/dev/null || true); printf '%s\n' "$__tl" | grep -qiE '^traefik\.enable=(1|t|true)$' && printf '%s\n' "$__tl" | grep -q '^traefik\.http\.routers\.'; }; ` +
		String.raw`bridge_unbridged() { if bridge_routed "$__old"; then if [ "$1" = internal ]; then echo "[bridge] WARNING: traefik app not bridged: $2 - expect 502s during the swap (a powder self-check tripped: this is a powder bug, nothing in the app needs to change)"; else echo "[bridge] WARNING: traefik app not bridged: $2 - expect 502s during the swap (for a missing label or healthcheck: add HEALTHCHECK + LABEL powder.bridge.enabled=true to the Dockerfile; the server compose is not synced from the repo)"; fi; bridge_mark "$1"; else echo "[bridge] not traefik-routed"; bridge_mark not-routed; fi; return 0; }; ` +
		// An app without the bridge label that traefik does not route: tell an
		// nginx-fronted one (nginx -T names 127.0.0.1:<its published loopback port>)
		// and a host-network one apart from not-routed. Runs in a command
		// substitution (no variable leaks), read-only, silent; any failure (docker
		// inspect, nginx missing / failing / slow) prints nothing = not-routed.
		String.raw`bridge_unrouted_kind() { __unm=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null) || return 0; if [ "$__unm" = host ]; then echo host-network; return 0; fi; ` +
		String.raw`__upb=$(docker inspect -f '{{range $p,$v := .HostConfig.PortBindings}}{{range $v}}{{$p}}|{{.HostIp}}|{{.HostPort}}{{println}}{{end}}{{end}}' "$1" 2>/dev/null) || return 0; ` +
		String.raw`__uhp=$(printf '%s\n' "$__upb" | grep -E '^[0-9]{1,5}/tcp[|]127[.]0[.]0[.]1[|][0-9]{1,5}$' | cut -d'|' -f3 | sort -u | head -10 | tr '\n' ' '); [ -n "$__uhp" ] || return 0; ` +
		String.raw`__unx=$(bridge_nginx_dump) || return 0; __unp=$(printf '%s\n' "$__unx" | grep -v '^[[:space:]]*#' | grep -oE '(127[.]0[.]0[.]1|localhost):[0-9]+' | cut -d: -f2 | sort -u | tr '\n' ' '); __unx=""; ` +
		String.raw`for __up in $__uhp; do case " $__unp " in *" $__up "*) echo nginx-unbridged; return 0 ;; esac; done; return 0; }; ` +
		String.raw`bridge_not_enabled() { if bridge_routed "$__old"; then bridge_unbridged no-label 'not enabled (label powder.bridge.enabled=true)'; return 0; fi; __uk=$(bridge_unrouted_kind "$__old" 2>/dev/null || true); ` +
		String.raw`case "$__uk" in host-network) echo "[bridge] WARNING: host-network app not bridged (network_mode: host) - expect 502s during the swap; the bridge needs a bridge network: move the app off host networking (publish 127.0.0.1:<port>, point nginx at it), then enable the bridge"; bridge_mark host-network ;; ` +
		String.raw`nginx-unbridged) echo "[bridge] WARNING: nginx-fronted app not bridged (host nginx proxies to its 127.0.0.1 port) - expect 502s during the swap; add LABEL powder.bridge.enabled=true and powder.bridge.host-port=<app port + 10000>, and the backup upstream server 127.0.0.1:<that port> backup; in the vhost"; bridge_mark nginx-unbridged ;; ` +
		String.raw`*) bridge_unbridged no-label 'not enabled (label powder.bridge.enabled=true)' ;; esac; return 0; }; ` +
		String.raw`bridge_start() { bridge_nginx_scan; B_NGA=""; bridge_start_body; ${nmark ? `if [ -n "$B_NGA" ]; then echo ${shq(nmark)}" app $B_NGA"; fi; ` : ''}return 0; }; ` +
		String.raw`bridge_start_body() { ` +
		String.raw`docker ps -aq --filter ${shq('label=powder.bridge=' + tag)} 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true; ` +
		String.raw`if ! command -v curl >/dev/null 2>&1; then echo "[bridge] skipped: curl not installed on host"; return 0; fi; ` +
		String.raw`__old=$(${psq} || true); ` +
		String.raw`if [ -z "$__old" ]; then echo "[bridge] skipped: no running container to overlap"; return 0; fi; ` +
		String.raw`if [ "$(docker inspect -f '{{.State.Running}}' "$__old" 2>/dev/null)" != true ]; then echo "[bridge] skipped: current container is not running"; return 0; fi; ` +
		String.raw`if [ "$(docker inspect -f '{{index .Config.Labels "powder.bridge.enabled"}}' "$__old" 2>/dev/null)" != true ]; then echo "[bridge] skipped: not enabled (label powder.bridge.enabled=true)"; B_NGA=n/a; bridge_not_enabled; return 0; fi; ` +
		String.raw`__pb=$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$__old" 2>/dev/null || echo 1); ` +
		// host-port mode (nginx-fronted apps): label powder.bridge.host-port=<N>. The
		// bridge publishes 127.0.0.1:N -> the container port of the app's one loopback
		// binding, which the vhost lists as a `backup` upstream server.
		String.raw`B_HP=$(docker inspect -f '{{index .Config.Labels "powder.bridge.host-port"}}' "$__old" 2>/dev/null || true); ` +
		// traefik mode with published ports: loopback-only bindings (127.0.0.1 / ::1) on a
		// traefik-routed app are tolerated (the clone publishes none, the old container
		// keeps its binding); any other interface, or an app traefik does not route, skips.
		String.raw`if [ -z "$B_HP" ]; then B_NGA=n/a; if [ "$__pb" != 0 ]; then ` +
		String.raw`__pbl=$(docker inspect -f '{{range $p,$v := .HostConfig.PortBindings}}{{range $v}}{{$p}}|{{.HostIp}}|{{.HostPort}}{{println}}{{end}}{{end}}' "$__old" 2>/dev/null) || { ${skip('could not read port bindings of the current container')} }; __pbl=$(printf '%s\n' "$__pbl" | grep -v '^$' || true); ` +
		String.raw`if [ -z "$__pbl" ] || printf '%s\n' "$__pbl" | grep -qvE '^[^|]+[|](127[.]0[.]0[.]1|::1|\[::1\])[|]'; then ${skip('app publishes host ports on a public interface (drop the ports line of this service in the server compose: traefik reaches the app over the docker network; an nginx-fronted app sets label powder.bridge.host-port)')} fi; ` +
		String.raw`if ! bridge_routed "$__old"; then ${skip('app publishes host ports and is not traefik-routed (set label powder.bridge.host-port for an nginx-fronted app)')} fi; ` +
		String.raw`echo "[bridge] loopback-only host ports stay on the old container; the bridge publishes none"; fi; else ` +
		String.raw`case "$B_HP" in *[!0-9]*|0*) ${skip('invalid powder.bridge.host-port label (want 1024-65535)')} ;; esac; if [ "${'$'}{#B_HP}" -gt 5 ] || [ "$B_HP" -lt 1024 ] || [ "$B_HP" -gt 65535 ]; then ${skip('invalid powder.bridge.host-port label (want 1024-65535)')} fi; ` +
		String.raw`__pbl=$(docker inspect -f '{{range $p,$v := .HostConfig.PortBindings}}{{range $v}}{{$p}}|{{.HostIp}}|{{.HostPort}}{{println}}{{end}}{{end}}' "$__old" 2>/dev/null) || { ${skip('could not read port bindings of the current container')} }; __pbl=$(printf '%s\n' "$__pbl" | grep -v '^$' || true); ` +
		String.raw`if [ "$__pb" != 1 ] || [ "$(printf '%s\n' "$__pbl" | grep -c .)" != 1 ]; then ${skip('host-port mode needs exactly one published port')} fi; ` +
		String.raw`if ! [[ "$__pbl" =~ ^([0-9]{1,5})/tcp\|127\.0\.0\.1\|([0-9]{1,5})$ ]]; then ${skip('host-port mode needs a tcp port bound to 127.0.0.1 only')} fi; ` +
		String.raw`B_PORT="${'$'}{BASH_REMATCH[1]}"; __ahp="${'$'}{BASH_REMATCH[2]}"; case "$__ahp" in 0*) ${skip('unexpected app host port')} ;; esac; if [ "$B_HP" != "$((__ahp + 10000))" ]; then ${skip('powder.bridge.host-port must be the app host port + 10000')} fi; bridge_nginx_check "$B_HP"; fi; ` +
		String.raw`__nm=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$__old" 2>/dev/null || true); ` +
		String.raw`case "$__nm" in host|none|container:*) __bad=1 ;; *) __bad=0 ;; esac; if [ "$__bad" = 1 ]; then ${skip('non-bridge network mode')} fi; ` +
		String.raw`__mc=$(docker inspect -f '{{len .Mounts}}' "$__old" 2>/dev/null || echo x); __bc=$(docker inspect -f '{{len .HostConfig.Binds}}' "$__old" 2>/dev/null || echo y); ` +
		String.raw`if [ "$__mc" != "$__bc" ]; then ${skip('mounts not expressible as binds')} fi; ` +
		String.raw`__hx=$(docker inspect -f '{{len .HostConfig.ExtraHosts}}|{{len .HostConfig.Tmpfs}}|{{len .HostConfig.CapAdd}}|{{len .HostConfig.Sysctls}}|{{.HostConfig.Init}}|{{.HostConfig.ShmSize}}' "$__old" 2>/dev/null || echo x); __xh="${'$'}{__hx%%|*}"; case "$__xh" in ''|*[!0-9]*) __bad=1 ;; *) case "${'$'}{__hx#*|}" in '0|0|0|<nil>|67108864'|'0|0|0|false|67108864') __bad=0 ;; *) __bad=1 ;; esac ;; esac; if [ -z "$B_HP" ] && [ "$__xh" != 0 ]; then __bad=1; fi; if [ "$__bad" = 1 ]; then ${skip('extra_hosts/tmpfs/cap_add/sysctls/init/shm_size set')} fi; ` +
		String.raw`if docker inspect -f '{{json .Config.Env}}' "$__old" 2>/dev/null | grep -qF '\n'; then ${skip('multi-line env value')} fi; ` +
		String.raw`if docker inspect -f '{{json .Config.Labels}}' "$__old" 2>/dev/null | grep -qE ${shq(JSON_LINEBREAK_ERE)}; then ${skip('label key or value with a line break (CR/LF)')} fi; ` +
		String.raw`__img=$(docker inspect -f '{{.Image}}' "$__old" 2>/dev/null || true); ` +
		String.raw`if [ -z "$B_HP" ] && [ -z "$(docker inspect -f '{{if .Config.Healthcheck}}y{{end}}' "$__old" 2>/dev/null)" ]; then ${skip('current container has no healthcheck (required for opt-in)')} fi; ` +
		String.raw`if docker inspect -f '{{json .Config.Cmd}} {{json .Config.Entrypoint}}' "$__old" 2>/dev/null | grep -qE ` + shq(BOOT_SCHEMA_PUSH_ERE) + String.raw`; then if [ "$(docker inspect -f '{{index .Config.Labels "powder.bridge.boot-push-ok"}}' "$__old" 2>/dev/null)" != true ]; then ${skip('boot-time schema push in command (re-running it can revert newer schema changes; set label powder.bridge.boot-push-ok=true to allow)')} fi; fi; ` +
		String.raw`__c1=$(docker inspect -f '{{json .Config.Cmd}}{{json .Config.Entrypoint}}' "$__old" 2>/dev/null || echo a); __c2=$(docker inspect --type image -f '{{json .Config.Cmd}}{{json .Config.Entrypoint}}' "$__img" 2>/dev/null || echo b); ` +
		String.raw`if [ -z "$__img" ] || [ "$__c1" != "$__c2" ]; then ${skip('command/entrypoint overridden or image unreadable')} fi; ` +
		// docker inspect -f prints the template output plus one "\n", so the label
		// dump ends in one empty line: drop exactly that one before comparing with
		// the label count. An LF inside a label still adds a line (and a CR is
		// grepped for), so this second guard behind the JSON check stays exact.
		String.raw`B_LF=$(mktemp) && B_EF=$(mktemp) || { echo "[bridge] skipped: mktemp failed"; bridge_unbridged failed 'mktemp failed'; return 0; }; ` +
		String.raw`docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$__old" 2>/dev/null > "$B_LF" || true; ` +
		String.raw`__lc=$(docker inspect -f '{{len .Config.Labels}}' "$__old" 2>/dev/null || true); case "$__lc" in ''|*[!0-9]*) ${skip('could not read labels of the current container')} ;; esac; __fl=$(wc -l < "$B_LF" | tr -d ' '); if [ "$__fl" -gt 0 ] 2>/dev/null && [ -z "$(tail -n 1 "$B_LF")" ]; then __fl=$((__fl-1)); fi; if [ "$__fl" != "$__lc" ] || LC_ALL=C grep -q "$(printf '\r')" "$B_LF"; then ${skip('label file line count differs from the label count (powder self-check)')} fi; ` +
		String.raw`grep -v '^com\.docker\.compose\.' "$B_LF" | grep -v '^$' > "$B_LF.f" || true; mv -f "$B_LF.f" "$B_LF" || { ${skip('label file rewrite failed')} }; ` +
		String.raw`if [ -n "$B_HP" ]; then grep -v '^traefik\.' "$B_LF" > "$B_LF.f" || true; mv -f "$B_LF.f" "$B_LF" || { ${skip('label file rewrite failed')} }; printf 'traefik.enable=false\n' >> "$B_LF"; else ` +
		String.raw`if ! grep -q '^traefik\.http\.routers\.' "$B_LF" || ! grep -q '^traefik\.http\.services\.' "$B_LF" || grep -q '^traefik\.enable=false' "$B_LF"; then ${skip('no explicit traefik router+service labels (worker / non-http / default-named)')} fi; ` +
		String.raw`for __r in $(grep -oE '^traefik\.http\.routers\.[^.=]+' "$B_LF" | sort -u); do if ! grep -qF "$__r.rule=" "$B_LF"; then ${skip('traefik router without an explicit rule label')} fi; done; ` +
		String.raw`B_PORT=$(grep -m1 -E '^traefik\.http\.services\.[^=]*\.loadbalancer\.server\.port=' "$B_LF" | cut -d= -f2 || true); case "$B_PORT" in ''|*[!0-9]*) B_PORT=$(docker inspect -f '{{range $p,$v := .Config.ExposedPorts}}{{$p}} {{end}}' "$__old" 2>/dev/null | awk '{split($1,a,"/"); print a[1]}'); case "$B_PORT" in ''|*[!0-9]*) B_PORT=3000 ;; esac ;; esac; fi; ` +
		String.raw`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$__old" 2>/dev/null | grep -v '^$' > "$B_EF" || true; ` +
		String.raw`set --; ` +
		String.raw`while IFS= read -r __b; do if [ -n "$__b" ]; then set -- "$@" -v "$__b"; fi; done < <(docker inspect -f '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$__old" 2>/dev/null); ` +
		String.raw`__u=$(docker inspect -f '{{.Config.User}}' "$__old" 2>/dev/null || true); if [ -n "$__u" ]; then set -- "$@" --user "$__u"; fi; ` +
		String.raw`__w=$(docker inspect -f '{{.Config.WorkingDir}}' "$__old" 2>/dev/null || true); if [ -n "$__w" ]; then set -- "$@" --workdir "$__w"; fi; ` +
		// host-port mode only (traefik mode skipped above on any extra_hosts): copied as
		// --add-host (e.g. host.docker.internal:host-gateway for a DB on the host); any
		// entry outside name:ip / name:host-gateway skips.
		String.raw`if [ -n "$B_HP" ] && [ "$__xh" != 0 ]; then __eh=$(docker inspect -f '{{range .HostConfig.ExtraHosts}}{{println .}}{{end}}' "$__old" 2>/dev/null) || { ${skip('could not read extra_hosts of the current container')} }; __ehn=0; while IFS= read -r __h; do if [ -z "$__h" ]; then continue; fi; if [[ "$__h" =~ ^([A-Za-z0-9][A-Za-z0-9._-]{0,252})[:=](host-gateway|[0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]*:[0-9A-Fa-f:]*)$ ]]; then set -- "$@" --add-host "${'$'}{BASH_REMATCH[1]}:${'$'}{BASH_REMATCH[2]}"; __ehn=$((__ehn+1)); else ${skip('unexpected extra_hosts entry')} fi; done < <(printf '%s\n' "$__eh"); if [ "$__ehn" != "$__xh" ]; then ${skip('extra_hosts count mismatch')} fi; fi; ` +
		// the bridge runs the app's image with the app's env next to the app, so it
		// keeps the running container's hardening: its cap_drop, security_opt (e.g.
		// no-new-privileges), read_only and pids_limit, plus NET_RAW always dropped (as
		// powder's override does). An unreadable setting or a custom inline seccomp
		// profile skips the bridge (the deploy itself is unchanged).
		String.raw`__cd=$(docker inspect -f '{{range .HostConfig.CapDrop}}{{.}} {{end}}' "$__old" 2>/dev/null) || { ${skip('could not read cap_drop of the current container')} }; for __c in $__cd; do case "$__c" in *[!A-Za-z0-9_]*) ${skip('unexpected cap_drop value')} ;; esac; set -- "$@" --cap-drop "$__c"; done; set -- "$@" --cap-drop NET_RAW; ` +
		String.raw`__so=$(docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$__old" 2>/dev/null) || { ${skip('could not read security_opt of the current container')} }; while IFS= read -r __s; do if [ -z "$__s" ]; then continue; fi; case "$__s" in seccomp=\{*|seccomp:\{*) ${skip('custom inline seccomp profile')} ;; esac; set -- "$@" --security-opt "$__s"; done < <(printf '%s
' "$__so"); ` +
		String.raw`__ro=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$__old" 2>/dev/null) || { ${skip('could not read read_only of the current container')} }; if [ "$__ro" = true ]; then set -- "$@" --read-only; fi; ` +
		String.raw`__pl=$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$__old" 2>/dev/null) || { ${skip('could not read pids_limit of the current container')} }; case "$__pl" in ''|'<nil>'|0|-*) ;; *[!0-9]*) ${skip('unexpected pids_limit value')} ;; *) set -- "$@" --pids-limit "$__pl" ;; esac; ` +
		String.raw`__nets=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$__old" 2>/dev/null || true); __n1=$(printf '%s\n' "$__nets" | awk '{print $1}'); ` +
		String.raw`if [ -z "$__n1" ]; then ${skip('no docker network on current container')} fi; ` +
		String.raw`__cap=$(cat /opt/apps/.mem-cap 2>/dev/null || echo 2g); ` +
		String.raw`if [ -n "$B_HP" ]; then set -- "$@" -p "127.0.0.1:$B_HP:$B_PORT"; fi; ` +
		String.raw`__name="$(docker inspect -f '{{.Name}}' "$__old" 2>/dev/null | sed 's#^/##')-powder-bridge"; BRIDGE="$__name"; ` +
		String.raw`if ! docker create --pull=never --name "$__name" --restart=no --memory "$__cap" --memory-swap "$__cap" --network "$__n1" --label ${shq('powder.bridge=' + tag)} ${COMPOSE_LABEL_BLANKS} ${SIDE_RUN_CAPS} --health-cmd 'test -f /tmp/.powder-ready' --health-interval 1s --health-retries 1 --health-start-interval 1s --health-start-period 60s --label-file "$B_LF" --env-file "$B_EF" "$@" "$__img" >/dev/null 2>&1; then ${skip('docker create failed')} fi; rm -f "$B_EF" 2>/dev/null || true; B_EF=""; ` +
		String.raw`for __n in $__nets; do if [ "$__n" != "$__n1" ]; then if ! docker network connect "$__n" "$__name" >/dev/null 2>&1; then ${skip('docker network connect failed')} fi; fi; done; ` +
		String.raw`if ! docker start "$__name" >/dev/null 2>&1; then ${skip('docker start failed')} fi; ` +
		String.raw`if bridge_wait 60 "$__name" "$B_PORT" bridge_http && docker exec "$__name" touch /tmp/.powder-ready >/dev/null 2>&1 && bridge_wait 30 "$__name" "$B_PORT"; then sleep 3; if [ -n "$B_HP" ]; then echo "[bridge] $__name answering on 127.0.0.1:$B_HP (nginx backup upstream) - overlapping old and new during the swap"; else echo "[bridge] $__name answering on :$B_PORT - overlapping old and new during the swap"; fi; bridge_mark bridged; else ${skip('bridge not answering HTTP / not healthy within budget (needs sh+test in image)')} fi; ` +
		String.raw`return 0; }; ` +
		String.raw`bridge_handoff() { if [ -z "$BRIDGE" ]; then return 0; fi; if ! docker inspect "$BRIDGE" >/dev/null 2>&1; then echo "[bridge] already removed (stale-state retry)"; BRIDGE=""; rm -f "$B_LF" "$B_EF" 2>/dev/null || true; return 0; fi; __new=$(${psq} || true); ` +
		String.raw`if [ -n "$__new" ] && [ -z "$B_HP" ]; then __nl=$(docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$__new" 2>/dev/null | grep '^traefik\.' | sort || true); __bl=$(grep '^traefik\.' "$B_LF" 2>/dev/null | sort || true); if [ "$__nl" != "$__bl" ]; then echo "[bridge] traefik labels differ between bridge and new container; removing bridge now (conflicting routers would be dropped)"; bridge_stop; return 0; fi; fi; ` +
		String.raw`if [ -n "$__new" ] && bridge_wait 90 "$__new" "$B_PORT"; then sleep 3; echo "[bridge] new container ready; draining bridge"; docker exec "$BRIDGE" rm -f /tmp/.powder-ready >/dev/null 2>&1 || true; sleep 3; docker stop -t 10 "$BRIDGE" >/dev/null 2>&1 || true; elif [ -z "$__new" ]; then echo "[bridge] no new container found after recreate; removing bridge"; else echo "[bridge] new container not ready within 90s; removing bridge anyway (health gate decides)"; fi; ` +
		String.raw`bridge_stop; return 0; }; `
	)
}

/** HTTP acceptance rule shared by the post-swap health gate and the pre-swap
 *  swap-check: with a health_url only a 2xx counts, without one any 1xx-4xx
 *  (the app answered HTTP). Shell `case` patterns, one source for both scripts. */
export const HEALTH_ACCEPT_STRICT = '2[0-9][0-9]'

export const HEALTH_ACCEPT_LOOSE = '[1-4][0-9][0-9]'

/** swap-check probe budget: same as the health gate (60s, one try per 5s). */
export const SWAP_CHECK_WAIT_SEC = 60

export const SWAP_CHECK_INTERVAL_SEC = 5

/** What buildDeployScript needs to run the pre-swap candidate probe. `skip`
 *  (a reason) means the step is off: one log line, nothing else. */
export type SwapCheckPlan =
	| { skip: string }
	| {
			/** health_url path ('/' when none); strict (2xx only) when `strict`. */
			path: string
			strict: boolean
			/** Host header for the probe (the app's live hostname). */
			host?: string
			/** better-auth sign-in probe after the health probe passes. false = off
			 *  for every app (POWDER_SWAP_CHECK_AUTH=off). Unset/true = on (the shell
			 *  detects better-auth in the cloned source; per app POWDER_AUTH_CHECK). */
			auth?: boolean
	  }

/** Decides whether the swap-check runs. Pure. Off when POWDER_SWAP_CHECK=off
 *  (every app) or app_repos.swap_check is false (per app). */
export function resolveSwapCheckPlan(p: {
	appFlag: boolean | null | undefined
	env: Record<string, string | undefined>
	probe: { path: string; host?: string } | null
}): SwapCheckPlan {
	if ((p.env.POWDER_SWAP_CHECK ?? '').trim().toLowerCase() === 'off')
		return { skip: 'disabled by POWDER_SWAP_CHECK=off' }
	if (p.appFlag === false) return { skip: 'disabled for this app (swap_check=false)' }
	const auth = (p.env.POWDER_SWAP_CHECK_AUTH ?? '').trim().toLowerCase() !== 'off'
	return { path: p.probe?.path ?? '/', strict: !!p.probe, host: p.probe?.host, auth }
}

/** Default better-auth probe path (no cookie). */
const AUTH_CHECK_PATH = '/api/auth/get-session'

/** Pre-swap candidate ("swap-check") shell functions. Before `up --force-recreate`
 *  swap_check starts `<name>-next` with `docker compose run -d --no-deps` for the
 *  service, so it gets the service's REAL resolved config: env_file AND compose
 *  `environment:` (which overrides the env file, e.g. HOSTNAME=0.0.0.0), `command:`,
 *  `user:`, volumes, networks. No --service-ports (nothing is published) and
 *  traefik.enable=false (not routed). Volumes are mounted like the real container,
 *  so the candidate shares the live app's volumes for the probe window.
 *  Probe: http://<candidate IP>:<port><path> with the app's Host header. Port, in
 *  order: PORT in the candidate's effective env, the container side of the live
 *  container's published ports, the traefik loadbalancer label, EXPOSE, 3000.
 *  Healthy: return 0 (candidate removed by swap_stop after the recreate).
 *  Real failure (strict: any non-2xx; loose: 5xx; or the candidate exited): dump
 *  its last 200 log lines, remove it, exit 1, old container untouched. Loose mode
 *  (no health_url) where no attempt ever got an HTTP answer and the candidate is
 *  still running: `swap-check: skipped (candidate never answered HTTP)`, continue
 *  (mirrors the post-swap gate for non-HTTP workloads). Also skipped for
 *  host/none/container networking, no running container, no curl, or a failed
 *  `compose run`. swap_stop is idempotent and also runs from the EXIT trap.
 *  Pure string builder: unit-tested + bash -n checked. */
export function swapCheckShellFunctions(
	cf: string,
	service: string,
	workingDir: string,
	appName: string,
	plan: Exclude<SwapCheckPlan, { skip: string }>,
): string {
	const tag = `${workingDir}|${service}`
	const candName = `${appName}-next`
	const attempts = Math.max(1, Math.floor(SWAP_CHECK_WAIT_SEC / SWAP_CHECK_INTERVAL_SEC))
	const accept = plan.strict ? HEALTH_ACCEPT_STRICT : HEALTH_ACCEPT_LOOSE
	const psq = `docker compose ${cf} ps -q ${shq(service)} 2>/dev/null | head -1`
	const skip = (why: string) => `echo "swap-check: skipped (${why})"; return 0;`
	const path = shq(plan.path.startsWith('/') ? plan.path : '/' + plan.path)
	const hostArg = plan.host ? `-H ${shq('Host: ' + plan.host)} ` : ''
	const authOn = plan.auth !== false
	const srcFiles = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']
		.flatMap((f) => [`${workingDir}/src/${f}`, `${workingDir}/${f}`])
		.map((f) => shq(f))
		.join(' ')
	// Runs after the candidate passed its health probe. Only 5xx fails; 2xx/3xx/4xx
	// pass, and no HTTP answer (000) is not a failure. Two tries 3s apart so a
	// warming-up candidate does not block a deploy; SCHEMA_MISMATCH is deterministic.
	const authFn = authOn
		? String.raw`swap_auth_check() { __ap=${shq(AUTH_CHECK_PATH)}; __force=0; ` +
			String.raw`__ao=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SC_NAME" 2>/dev/null | sed -n 's/^POWDER_AUTH_CHECK=//p' | head -1); ` +
			String.raw`case "$__ao" in off|OFF|false|FALSE|0|no) echo "swap-check: auth check skipped (POWDER_AUTH_CHECK=$__ao)"; return 0 ;; /*[!A-Za-z0-9/_.-]*) ;; /*) __ap="$__ao"; __force=1 ;; esac; ` +
			String.raw`if [ "$__force" = 0 ]; then __ba=0; for __f in ${srcFiles}; do if [ -f "$__f" ] && grep -qs 'better-auth' "$__f" 2>/dev/null; then __ba=1; break; fi; done; if [ "$__ba" = 0 ]; then return 0; fi; fi; ` +
			String.raw`__af=$(mktemp 2>/dev/null || echo /tmp/.powder-auth-$$); __j=0; __ac=000; while [ "$__j" -lt 2 ]; do __j=$((__j+1)); ` +
			String.raw`__ac=$(curl -sS --max-time 10 ${hostArg}-H 'X-Forwarded-Proto: https' -o "$__af" -w '%{http_code}' "http://$1:$2$__ap" 2>/dev/null || true); ` +
			String.raw`case "$__ac" in 5[0-9][0-9]) if [ "$__j" -lt 2 ]; then sleep 3; fi ;; *) break ;; esac; done; ` +
			String.raw`case "$__ac" in 5[0-9][0-9]) __body=$(head -c 2000 "$__af" 2>/dev/null | tr -cd '[:print:]\n' | head -n 1 | cut -c1-200); rm -f "$__af"; __m=""; if printf '%s' "$__body" | grep -qiE 'SCHEMA_MISMATCH|schema mismatch'; then __m=": $__body"; fi; swap_fail "auth check: $__ap returned $__ac (better-auth schema mismatch? run the migration)$__m" ;; esac; ` +
			String.raw`rm -f "$__af"; echo "swap-check: auth check ok ($__ap HTTP $__ac)"; return 0; }; `
		: ''
	const authCall = authOn ? String.raw`swap_auth_check "$__ip" "$__lport"; ` : ''
	return (
		authFn +
		String.raw`SC_ON=0; SC_NAME=${shq(candName)}; ` +
		String.raw`swap_stop() { if [ "$SC_ON" = 1 ]; then __sc=0; if [ "$(docker inspect -f '{{index .Config.Labels "powder.candidate.app"}}' "$SC_NAME" 2>/dev/null)" = ${shq(tag)} ]; then docker rm -f "$SC_NAME" >/dev/null 2>&1 || true; __sc=1; elif docker inspect "$SC_NAME" >/dev/null 2>&1; then echo "swap-check: a container named $SC_NAME exists but is not this app's candidate (no powder.candidate.app label) - left alone"; fi; __ids=$(docker ps -aq --filter ${shq('label=powder.candidate.app=' + tag)} 2>/dev/null || true); if [ -n "$__ids" ]; then printf '%s\n' "$__ids" | xargs -r docker rm -f >/dev/null 2>&1 || true; __sc=1; fi; if [ "$__sc" = 1 ]; then echo "swap-check: removed $SC_NAME"; fi; fi; return 0; }; ` +
		String.raw`swap_fail() { echo "swap-check: FAILED ($1)"; if docker inspect "$SC_NAME" >/dev/null 2>&1; then echo "── last 200 log lines of $SC_NAME ──"; docker logs --tail 200 "$SC_NAME" 2>&1 || true; echo "── end of $SC_NAME logs ──"; fi; swap_stop; echo "swap-check: old container untouched, not swapping"; exit 1; }; ` +
		String.raw`swap_check() { ` +
		String.raw`SC_ON=1; swap_stop; ` +
		String.raw`if ! command -v curl >/dev/null 2>&1; then ${skip('curl not installed on host')} fi; ` +
		String.raw`__old=$(${psq} || true); ` +
		String.raw`if [ -z "$__old" ]; then ${skip('no running container to compare with')} fi; ` +
		String.raw`__nm=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$__old" 2>/dev/null || true); ` +
		String.raw`case "$__nm" in host) echo "swap-check: skipped (host-network app)"; return 0 ;; none|container:*) ${skip('non-bridge network mode')} ;; esac; ` +
		String.raw`if ! docker compose ${cf} run -d --no-deps --name "$SC_NAME" --label traefik.enable=false --label powder.candidate=1 --label ${shq('powder.candidate.app=' + tag)} ${shq(service)} >/dev/null 2>&1 </dev/null; then ${skip('docker compose run failed')} fi; ` +
		String.raw`__cap=$(cat /opt/apps/.mem-cap 2>/dev/null || true); if [ -z "$__cap" ]; then __cap=$(docker inspect -f '{{.HostConfig.Memory}}' "$__old" 2>/dev/null || echo 0); case "$__cap" in ''|*[!0-9]*|0) __cap="" ;; esac; fi; if [ -n "$__cap" ]; then docker update --memory "$__cap" --memory-swap "$__cap" "$SC_NAME" >/dev/null 2>&1 || true; fi; ` +
		String.raw`__lport=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SC_NAME" 2>/dev/null | sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' | head -1); ` +
		String.raw`case "$__lport" in ''|*[!0-9]*) __lport=$(docker inspect -f '{{range $p,$v := .HostConfig.PortBindings}}{{$p}} {{end}}' "$__old" 2>/dev/null | awk '{split($1,a,"/"); print a[1]}') ;; esac; ` +
		String.raw`case "$__lport" in ''|*[!0-9]*) __lport=$(docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$__old" 2>/dev/null | grep -m1 -E '^traefik\.http\.services\.[^=]*\.loadbalancer\.server\.port=' | cut -d= -f2 || true) ;; esac; ` +
		String.raw`case "$__lport" in ''|*[!0-9]*) __lport=$(docker inspect -f '{{range $p,$v := .Config.ExposedPorts}}{{$p}} {{end}}' "$SC_NAME" 2>/dev/null | awk '{split($1,a,"/"); print a[1]}') ;; esac; ` +
		String.raw`case "$__lport" in ''|*[!0-9]*) __lport=3000 ;; esac; ` +
		String.raw`__t0=$(date +%s); echo "swap-check: candidate started ($SC_NAME, port $__lport)"; ` +
		String.raw`__i=0; __saw=0; __why="no ${accept} response after ${attempts} attempts"; while [ "$__i" -lt ${attempts} ]; do __i=$((__i+1)); if [ "$__i" = 1 ]; then sleep 2; else sleep ${SWAP_CHECK_INTERVAL_SEC}; fi; ` +
		String.raw`if [ "$(docker inspect -f '{{.State.Running}}' "$SC_NAME" 2>/dev/null)" != true ]; then __why="candidate exited (code $(docker inspect -f '{{.State.ExitCode}}' "$SC_NAME" 2>/dev/null || echo ?))"; __saw=1; break; fi; ` +
		String.raw`__ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$SC_NAME" 2>/dev/null | awk '{print $1}'); if [ -z "$__ip" ]; then continue; fi; ` +
		String.raw`__code=$(curl -sS --max-time 5 ${hostArg}-H 'X-Forwarded-Proto: https' -o /dev/null -w '%{http_code}' "http://$__ip:$__lport"${path} 2>/dev/null || true); ` +
		String.raw`case "$__code" in ${accept}) echo "swap-check: healthy in $(( $(date +%s) - __t0 ))s (HTTP $__code)"; ${authCall}return 0 ;; [1-5][0-9][0-9]) __saw=1 ;; esac; echo "swap-check: attempt $__i/${attempts}: $__code"; done; ` +
		(plan.strict
			? ''
			: String.raw`if [ "$__saw" = 0 ]; then echo "swap-check: skipped (candidate never answered HTTP)"; swap_stop; return 0; fi; `) +
		String.raw`swap_fail "$__why"; ` +
		String.raw`return 1; }; `
	)
}

/** ERE (grep -i) matching a traefik.* or com.docker.compose.* KEY in `{{json .Config.Labels}}`. */
const JSON_ROUTING_KEY_ERE = String.raw`[{,]"([^"\\]|\\.)*(traefik\.|com\.docker\.compose\.)`

/** Default test-gate image (an official Docker Hub image, always re-pulled). */
const TEST_GATE_DEFAULT_IMAGE = 'node:22-alpine'

/** what `# powder-test-image:` may name. An official `node:<tag>`
 *  (pulled with --pull=always, so a local image of that name never runs), or any
 *  image pinned by digest (`name[:tag]@sha256:<64 hex>`, which only resolves by
 *  pulling it from a registry: another app's local-only build has no such digest). */
const TEST_GATE_IMAGE_ERE = String.raw`^(node:[A-Za-z0-9._-]+|[a-z0-9]+([._/-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64})$`

/** Network the test gate runs on: its own bridge (egress for npm ci etc.), never an
 *  app network or the default bridge other containers sit on. The name is a
 *  PREFIX; every run creates `<prefix>-<random>` (labelled powder.testgate=<label>)
 *  and removes it, so two test gates (builder slots) never share a network. */
const TEST_GATE_NETWORK = 'powder-testgate'

/** Shell: remove every leftover test-gate container of this app (by label). For EXIT traps. */
export function testGateStopShell(label: string): string {
	const f = shq(`label=powder.testgate=${label}`)
	return (
		`docker ps -aq --filter ${f} 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true; ` +
		`docker network ls -q --filter ${f} 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true`
	)
}

/** ONE test-gate runner for the local deploy script and the dedicated builder.
 *  `dir` is a shell word (already quoted) holding the build context; `run` wraps the
 *  docker run (lock + timeout prefix); `tag` prefixes every log line. Exits 1 on refusal
 *  or a failing test.sh. Caller checks that $dir/.powder/test.sh exists. */
/** Builds pass --pull. Default ON since a Dockerfile
 *  cannot resolve FROM / COPY --from to another app's local-only image.
 *  POWDER_BUILD_PULL=0 (or false/no/off) opts out, e.g. for servers that hit Docker Hub's
 *  anonymous pull limits. */
export function buildPullEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return !['0', 'false', 'no', 'off'].includes((env.POWDER_BUILD_PULL ?? '').trim().toLowerCase())
}

/** POWDER_TESTGATE_MEM (e.g. 2g, 1536m): test-gate memory cap override; invalid = ignored. */
export function testGateMemOverride(
	env: Record<string, string | undefined> = process.env,
): string | null {
	const v = env.POWDER_TESTGATE_MEM?.trim()
	return v && /^[0-9]+[kmgKMG]?$/.test(v) ? v : null
}

/** names never copied into the test gate's view of the code (any depth):
 *  powder's deploy key, the runtime compose, rendered env files, bundled DB/KV data
 *  dirs, powder's own runtime files. `.powder/` (test.sh) is not matched. */
const TEST_GATE_PROTECTED = [
	'.deploy-key',
	'docker-compose.yml',
	'docker-compose.powder.yml',
	'*.env',
	'.env*',
	'pgdata',
	'kvdata',
	'.powder-*',
] as const

/** Shell: fill $TG_SRC (a fresh temp dir) with the code the test gate may see. In a git
 *  checkout: the COMMITTED tree of the context dir (`git archive HEAD:<prefix>`), so
 *  untracked server-side files (rendered env, keys, data dirs) never reach the
 *  container. Otherwise a plain copy. Both drop TEST_GATE_PROTECTED. */
function testGateCopyShell(dir: string, tag: string): string {
	const ex = TEST_GATE_PROTECTED.map((x) => `--exclude=${shq(x)}`).join(' ')
	const g = gitCmd(shq('*'), dir)
	return [
		`TG_SRC=$(mktemp -d /tmp/powder-tg-XXXXXX) || { echo "${tag} refusing: could not create the test copy"; exit 1; }; `,
		`TG_GIT=0; if TG_PFX=$(${g} rev-parse --show-prefix 2>/dev/null) && TG_TOP=$(${g} rev-parse --show-toplevel 2>/dev/null); then TG_GIT=1; `,
		`( set -o pipefail; ${gitCmd(shq('*'), '"$TG_TOP"')} archive --format=tar "HEAD:$TG_PFX" | tar -xf - -C "$TG_SRC" ${ex} ); `,
		`else ( set -o pipefail; tar -C ${dir} ${ex} -cf - . | tar -xf - -C "$TG_SRC" ); fi `,
		`|| { rm -rf "$TG_SRC"; echo "${tag} refusing: could not copy the code for the test gate"; exit 1; }; `,
		`if [ "$TG_GIT" = 1 ]; then TG_WHAT='committed files of'; else TG_WHAT='files in'; fi; `,
		`echo "${tag} test copy: $TG_WHAT the build context, without ${TEST_GATE_PROTECTED.join(' ')}"; `
	].join('')
}

/** Exit code of a builder script whose test gate ran and the tests themselves failed (see testGateShell
 *  `testsFailedExit`). The deploy then fails as a test-gate failure instead of retrying the same tests in a
 *  local build on the production server (which re-ran them under less memory and died with a heap OOM). */
export const TEST_GATE_TESTS_FAILED_EXIT = 87

/** Test-gate exit codes that say the run itself broke, not the tests: timeout (124), docker run errors
 *  (125-127), killed (137 SIGKILL incl. the kernel OOM killer, 141 SIGPIPE, 143 SIGTERM). A retry elsewhere may pass. */
const TEST_GATE_INFRA_RCS = '124|125|126|127|137|141|143'

export function testGateShell(p: {
	dir: string
	label: string
	run: string
	tag: string
	/** when set, a failure of the tests themselves exits with this code instead of 1 (infra failures still exit 1). */
	testsFailedExit?: number
	mem?: string | null
	/** POWDER_COMPOSE_GUARD=enforce: refuse instead of WARN (image allow-list, pull, labels). */
	enforce?: boolean
	app?: string
	/** the registry login owner rule (DFR_FOREIGN_AWK's login branch, the twin of
	 *  loginRegistryForeign): the app name a repo on a login registry must end in, and the
	 *  login hosts the deploy's probe read (root's own on this server are added). */
	loginSelf?: string
	loginHosts?: readonly string[]
}): string {
	const t = p.tag
	const self = (p.loginSelf ?? p.app ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '')
	const hosts = (p.loginHosts ?? []).map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.:-]+$/.test(h)).join(' ')
	const app = (p.app ?? 'app').replace(/[^A-Za-z0-9._-]/g, '_')
	const W = (code: string, detail: string) => `echo "[compose-guard] WARN ${app} ${code} ${detail}"`
	const refuseOrWarn = (code: string, detail: string) =>
		p.enforce ? `echo "${t} refusing: ${detail}"; exit 1` : W(code, detail)
	return [
		`TG_IMG=$(sed -n 's/^# *powder-test-image: *//p' ${p.dir}/.powder/test.sh | head -1 | tr -d '\\r'); : "\${TG_IMG:=${TEST_GATE_DEFAULT_IMAGE}}"; case "$TG_IMG" in -*) TG_IMG=${TEST_GATE_DEFAULT_IMAGE};; esac; `,
		// The image allow-list is ALWAYS enforced (not only with POWDER_COMPOSE_GUARD=enforce):
		// a repo naming another app's local tag would read that app's filesystem.
		`if ! printf '%s\\n' "$TG_IMG" | grep -qE ${shq(TEST_GATE_IMAGE_ERE)}; then echo "${t} refusing powder-test-image $TG_IMG: use an official node:<tag> image or pin one by digest (name@sha256:<64 hex>)"; exit 1; fi; `,
		// the pull below runs with root's registry logins: an image on a registry
		// root is logged in to must be this app's own (last path segment = the app), in
		// every guard mode, digest pin or not. Public Docker Hub images (node:*) pass.
		`TG_WHY=$(printf '%s\n' "$TG_IMG" | DFR_FOREIGN='' DFR_OTHERS='' DFR_SELF=${shq(self)} DFR_LOGIN="${hosts} $(${REGISTRY_LOGIN_HOSTS_SHELL})" LC_ALL=C awk ${shq(DFR_FOREIGN_AWK)} 2>/dev/null); `,
		`case "$TG_WHY" in "an image on "*) echo "${t} refusing powder-test-image $TG_IMG ($TG_WHY): root's registry login would pull another project's private image (refused in every guard mode). Use a public image or this app's own repo"; exit 1;; esac; `,
		`echo "${t} .powder/test.sh present - running in $TG_IMG (a non-zero exit blocks the swap)"; `,
		// Pull ONCE, then run exactly that content by its registry digest (--pull=never).
		// pull failed: a local copy is used (WARN) only for a DIGEST-pinned
		// powder-test-image whose local copy carries exactly that digest and no
		// com.docker.compose.* label. A RepoDigest is no proof of a pull (on docker 29 with
		// the containerd store another app's local build of `node:22-alpine` has one), so a
		// tag is refused in every mode when the registry does not answer.
		`TG_DIG() { docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null | grep -m1 '@sha256:' || true; }; `,
		`TG_REPO=\${TG_IMG%%@*}; case "\${TG_REPO##*/}" in *:*) TG_REPO=\${TG_REPO%:*};; esac; `,
		`TG_MATCH() { docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$TG_IMG" 2>/dev/null | awk -F@ -v r="$TG_REPO" -v p="$TG_IMG" 'function c(x){sub(/^(docker\\.io|index\\.docker\\.io|registry-1\\.docker\\.io)\\//,"",x); sub(/^library\\//,"",x); return x} $2 ~ /^sha256:[0-9a-f]+$/ && (index(p,"@") ? c($0)==c(p) : c($1)==c(r)) {print; exit}' || true; }; `,
		`if docker pull "$TG_IMG" >/dev/null 2>&1; then TG_REF=$(TG_DIG "$TG_IMG"); else TG_REF=""; case "$TG_IMG" in *@sha256:*) TG_REF=$(TG_MATCH); if [ -n "$TG_REF" ] && docker image inspect -f '{{json .Config}}' "$TG_REF" 2>/dev/null | grep -q '[{,]"com\\.docker\\.compose\\.'; then TG_REF=""; fi;; esac; if [ -n "$TG_REF" ]; then ${W('testgate_pull', 'pull of $TG_IMG failed; running the local copy $TG_REF (its digest pin)')}; fi; fi; `,
		`if [ -z "$TG_REF" ]; then echo "${t} refusing: the pull of $TG_IMG failed and no local copy can be trusted (a local tag may be another app's build: a RepoDigest is no proof of a pull; only a digest-pinned powder-test-image whose local copy has that digest and no compose labels runs without the registry). Retry when the registry answers, or pin the image by digest."; exit 1; fi; `,
		`TG_L=$(docker image inspect -f '{{json .Config.Labels}}' "$TG_REF" 2>/dev/null || true); `,
		// Routing / compose-project labels on the image are neutralised on the run
		// below either way (traefik.enable=false, empty compose project/service).
		`if printf '%s' "$TG_L" | grep -qiE ${shq(JSON_ROUTING_KEY_ERE)}; then ${refuseOrWarn('testgate_labels', '$TG_IMG carries traefik.* or com.docker.compose.* image labels')}; fi; `,
		// Memory: only POWDER_TESTGATE_MEM; default uncapped.
		`TG_MEM=${shq(p.mem ?? '')}; `,
		`if [ -n "$TG_MEM" ]; then set -- --memory "$TG_MEM" --memory-swap "$TG_MEM"; echo "${t} memory cap: $TG_MEM"; else set --; echo "${t} memory cap: none (set POWDER_TESTGATE_MEM to cap)"; fi; `,
		`TG_NET=${TEST_GATE_NETWORK}-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \\n'); `,
		// The tests need egress (npm ci etc.) on a network of their own. There is no
		// shared fallback network (test containers of different apps could reach each
		// other there): a run whose own network cannot be created is refused.
		`if ! docker network create --label ${shq(`powder.testgate=${p.label}`)} "$TG_NET" >/dev/null 2>&1; then echo "${t} refusing: cannot create the test network $TG_NET (a test gate never runs on a shared network); the old container keeps serving. Retry the deploy."; exit 1; fi; `,
		// the container sees a filtered COPY, never the context dir itself.
		testGateCopyShell(p.dir, t),
		`( set -o pipefail; ${p.run} docker run --rm --pull=never --network "$TG_NET" "$@" --pids-limit 2048 --security-opt no-new-privileges --cap-drop NET_RAW `,
		`--label traefik.enable=false --label com.docker.compose.project= --label com.docker.compose.service= --label ${shq(`powder.testgate=${p.label}`)} -v "$TG_SRC":/src:ro -w /w "$TG_REF" sh -lc 'cp -a /src/. /w/ && sh .powder/test.sh' 2>&1 | { head -c 2000000; cat >/dev/null; } ) && TG_RC=0 || TG_RC=$?; `,
		`${testGateStopShell(p.label)}; rm -rf "$TG_SRC"; `,
		`if [ "$TG_RC" -ne 0 ]; then echo "${t} FAILED (exit $TG_RC) - NOT swapping; the old container keeps serving the previous version"; ` +
			(p.testsFailedExit ? `case "$TG_RC" in ${TEST_GATE_INFRA_RCS}) exit 1;; esac; exit ${Math.trunc(p.testsFailedExit)}; fi; ` : `exit 1; fi; `),
		`echo "${t} passed"; `,
	].join('')
}
