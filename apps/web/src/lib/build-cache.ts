// BuildKit cache isolation.
//
// BuildKit shares `RUN --mount=type=cache` mounts by id across EVERY build on one
// daemon (a mount without an id uses its target path as the id). Any repo could
// name another app's cache id (or just its target, /root/.npm) and read or poison
// it. powder therefore rewrites every cache mount of the Dockerfile it builds,
// repo-provided or generated, before the build:
//
//   --mount=type=cache,target=/root/.npm          ->  --mount=type=cache,id=<app>-<h>,target=/root/.npm
//   --mount=type=cache,id=x,target=/root/.npm     ->  --mount=type=cache,id=<app>-<h>,target=/root/.npm
//
// where <h> = sha256(<namespace> "\n" <original id, else target>)[:20] and the
// namespace is derived from a random per-(server, app) salt kept in powder's DB
// (powder_meta `build_cache_salt:<serverId>:<app>`, created on the first build,
// never shown in the UI, the API or a log). The ids that reach the build log are
// hashes, so they do not reveal the salt, and no repo can compute another app's id.
// An app's explicit id= is salted the same way, so the only ids an app build can
// name are of the form <slug>-<20 hex>.
//
// Residual risk: a cache mount BuildKit runs without passing through this rewrite
// (an ONBUILD RUN --mount trigger of a registry base image: the rewrite only sees
// the repo's Dockerfile) keeps the id it names. It cannot reach another app's
// cache (those ids are salted hashes), but it can name any unsalted id on the
// daemon. powder's own build (docker/web.Dockerfile, built by bin/self-deploy.sh
// without this rewrite) therefore names its cache mounts
// powder-self-<what>-<POWDER_BUILD_CACHE_ID>, a random per-server value
// bin/self-deploy.sh keeps in <env file dir>/.powder-build-cache-id: no app
// rewrite produces that shape, and no Dockerfile or base image can guess it.
//
// The rewritten Dockerfile is written to a dir OUTSIDE the build context and handed
// to the build with `-f` (builder: mktemp -d, removed after the build) or a compose
// override setting `build.dockerfile` (target server: the persistent per-app set in
// <compose state dir>/<key>/dfr/, see deploy/script.ts; `compose up` records the
// override in the container's config_files label, so its files must stay). The
// repo's file is untouched.
//
// The same pass refuses what the rewrite cannot make safe:
//   - a `# syntax=` frontend other than docker/dockerfile (a custom frontend
//     gets the whole context and may ignore .dockerignore);
//   - a `# escape=` directive other than \ (the escape character is always \);
//   - a --mount flag with quotes, a backslash or a backtick (BuildKit drops an
//     escape character, so `type=cach\e` is a cache mount), a
//     variable `type=`, or a --mount flag split over a line continuation (the
//     rewrite could not see the real value);
//   - an ADD source that is a URL, a git remote or built from a variable, and
//     ADD --checksum / --keep-git-dir (BuildKit fetches those inside dockerd as root);
//     RUN --network= other than default / none, any RUN --security= or --device= (flag
//     position only); a FROM inside a heredoc body; the reserved name POWDER_NS.
// It also declares `ARG POWDER_NS_<hash>=1` after every FROM: an in-scope ARG is
// part of every RUN's env and so of its cache key, which makes RUN layers (and what a
// secret mount produced in them) per app. ARG only: nothing reaches the image's env.
// and checks the images the Dockerfile reads (FROM, COPY --from, --mount from=)
// against this server's local images when `--pull` is off (POWDER_BUILD_PULL=0): a
// local image that was never pulled from a registry (no RepoDigests) and is not
// one of this app's own images is another app's build, the Dockerfile twin of the
// compose guard's image_foreign rule. With --pull on, every image ref resolves
// from its registry and the check is skipped. Enforce mode refuses, warn mode
// prints `[compose-guard] WARN <app> dockerfile_image ...`.
//
// type=secret / type=ssh mounts are left alone: BuildKit only hands a build the
// secrets and ssh agents its client passed (compose build.secrets / build.ssh, both
// checked by the compose guard; the builder path refuses compose secrets).

import { createHash, randomBytes } from 'node:crypto'
import { shq } from './shell'
import { ALL_PROFILES } from './deploy/compose-hash'

/** powder_meta key of an app's build cache salt. */
export function buildCacheSaltKey(serverId: string, app: string): string {
	return `build_cache_salt:${serverId}:${app}`
}

/** The namespace the server hashes cache ids with: derived from the salt, so the salt
 *  itself never leaves powder. 32 hex chars. */
export function cacheNamespace(salt: string, serverId: string, app: string): string {
	return createHash('sha256')
		.update(`powder-build-cache\n${salt}\n${serverId}\n${app}`)
		.digest('hex')
		.slice(0, 32)
}

/** A namespace nobody can predict, for a deploy that could not read its salt: the
 *  build runs with a cold (but still isolated) cache. */
export function ephemeralCacheNamespace(): string {
	return randomBytes(16).toString('hex')
}

/** The app part of a rewritten cache id (also what generated Dockerfiles used). */
export function cacheAppSlug(app: string): string {
	return (
		app
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, '-')
			.replace(/^[^a-z0-9]+/, '')
			.slice(0, 60) || 'app'
	)
}

/** What the server computes for one cache mount (unit tests compare against it). */
export function rewrittenCacheId(ns: string, app: string, origKey: string): string {
	return `${cacheAppSlug(app)}-${createHash('sha256').update(`${ns}\n${origKey}`).digest('hex').slice(0, 20)}`
}

/** the name of the ARG the rewrite declares after every FROM (the awk computes
 *  the same: `ARG <name>=1`). Per app because it derives from the namespace. */
export function runNamespaceArgName(ns: string): string {
	return `POWDER_NS_${createHash('sha256').update(`${ns}\npowder:run-layer-ns`).digest('hex').slice(0, 20)}`
}

/** Read (or create, once) the per-(server, app) salt and return the namespace.
 *  Never throws: null when the DB is unavailable (the caller falls back to an
 *  ephemeral namespace). */
export async function loadCacheNamespace(serverId: string, app: string): Promise<string | null> {
	try {
		const { db, sql } = await import('./db')
		const key = buildCacheSaltKey(serverId, app)
		const fresh = randomBytes(32).toString('hex')
		await db.execute(
			sql`INSERT INTO powder_meta (key, value, updated_at) VALUES (${key}, ${fresh}, now()) ON CONFLICT (key) DO NOTHING`,
		)
		const rows = (await db.execute(
			sql`SELECT value FROM powder_meta WHERE key = ${key}`,
		)) as unknown as Array<{ value: string }>
		const salt = rows[0]?.value
		return salt && salt.length >= 32 ? cacheNamespace(salt, serverId, app) : null
	} catch {
		return null
	}
}

/** `# syntax=` values powder builds with: Docker's own Dockerfile frontend, any tag,
 *  optionally digest-pinned. */
export const SYNTAX_ALLOWED_ERE =
	'^((docker\\.io|index\\.docker\\.io)/)?docker/dockerfile(:[A-Za-z0-9_][A-Za-z0-9_.-]*)?(@sha256:[0-9a-f]+)?$'

export function syntaxAllowed(v: string): boolean {
	const d = v.indexOf('@sha256:')
	return new RegExp(SYNTAX_ALLOWED_ERE).test(v) && (d < 0 || v.length - d - 8 === 64)
}

// POSIX awk (mawk 1.3.4, gawk, BSD awk: no interval expressions, no gawk-only
// functions). Run with LC_ALL=C. Input: the Dockerfile. Env: DFR_NS (namespace),
// DFR_APP (slug), DFR_TF (scratch file for the hash input), DFR_RP (report file).
// stdout: the rewritten Dockerfile, line for line. Report lines:
//   REFUSE <reason>    the build must not run
//   IMG <ref>          an image the Dockerfile reads (not a stage of this file)
//   BASE <k> <ref> the base image of a FROM as resolved at its line (also an
//                      IMG line); the FROM is written back as one line that reads the
//                      token __POWDER_BASE_<k>__, which dfr_bases replaces with the
//                      inspected image pinned to its registry digest
//   UNRESOLVED <ref>   an image ref with a variable that has no ARG default
//   VARREF <ref> <resolved>   informational: a ref built from a variable
//   AT <line> <ref> <resolved or ->   informational: each image ref as resolved at
//                      its line with the ARGs in scope there, before the backstop
//   REWROTE <n>        cache mounts rewritten
// Comment lines are copied as they are (BuildKit drops them, also inside a
// continuation). A `--mount=` in RUN flag position gets the strict treatment
// (refusals for quotes, backslashes or backticks, a variable type, a flag
// continued over a line break);
// any other `type=cache` mount text on an instruction line (shell text, heredoc
// bodies, an instruction this parser placed wrongly) is still rewritten, without
// refusals: rewriting shell text is harmless, skipping a real flag is not.
export const DOCKERFILE_REWRITE_AWK = String.raw`
function rep(s) { print s > RP }
function hash(k,   cmd, h) {
  printf "%s\n%s", ENVIRON["DFR_NS"], k > TF
  close(TF)
  cmd = "sha256sum < \"" TF "\""
  h = ""
  cmd | getline h
  close(cmd)
  if (length(h) < 20) { rep("REFUSE cannot hash a cache id (sha256sum missing?)"); return "x" }
  return substr(h, 1, 20)
}
function fkey(f,   j, k) {
  j = index(f, "=")
  k = j ? substr(f, 1, j - 1) : f
  gsub(/^[ \t]+|[ \t]+$/, "", k)
  return tolower(k)
}
function fval(f,   j) { j = index(f, "="); return j ? substr(f, j + 1) : "" }
# strict = 1: a real RUN flag. 0: mount-looking text elsewhere (no refusals; a
# quoted cache spec is rewritten without its quotes).
function rewrite(spec, strict,   n, f, i, k, type, idv, tgt, out, s2) {
  s2 = spec
  # BuildKit unquotes the flag and drops an escape character before it
  # splits the spec, so cach\e reads as cache and fr\om= as from=. Which character
  # depends on the frontend version (1.14 and older: always \; 1.16 and newer: the
  # escape= directive's), and # syntax= may pick any version: refuse both \ and the
  # backtick, whatever the directive says. A continuation at the end of the
  # physical line is stripped by the caller (procline) before this check.
  if (strict && (spec ~ /["'\\@BT@]/ || spec ~ HI)) { rep("REFUSE a --mount= flag with quotes, a backslash, a backtick or a non-ASCII byte is not supported (write it plainly; a line continuation goes after the flag, as its own word): --mount=" spec); return spec }
  if (spec ~ /["']/) gsub(/["']/, "", s2)
  n = split(s2, f, ",")
  type = "bind"; idv = ""; tgt = ""
  for (i = 1; i <= n; i++) {
    k = fkey(f[i])
    if (k == "type") type = tolower(fval(f[i]))
    else if (k == "id") idv = fval(f[i])
    else if (k == "target" || k == "dst" || k == "destination") tgt = fval(f[i])
    else if (k == "from" && strict) PM[++npm] = fval(f[i])
  }
  if (type ~ /[$]/) {
    if (strict) rep("REFUSE a --mount= type set from a variable is not supported: --mount=" spec)
    return spec
  }
  if (type != "cache") return spec
  if (idv == "" && tgt == "") return spec
  out = "type=cache,id=" APP "-" hash(idv != "" ? idv : tgt)
  for (i = 1; i <= n; i++) {
    k = fkey(f[i])
    if (k == "type" || k == "id") continue
    out = out "," f[i]
  }
  rewrote++
  return out
}
# Mount text inside one word that is not a flag (e.g. echo "--mount=...").
function textmount(w,   p, low) {
  low = tolower(w)
  p = index(low, "--mount=")
  if (p == 0) return w
  return substr(w, 1, p + 7) rewrite(substr(w, p + 8), 0)
}
# One instruction line (not a comment): rewrites, tracks the RUN flag position
# across continuation lines (state: incont, inflags, onb).
# an instruction keyword (or a prefix of one) with the continuation glued
# to it (R\ + UN ..., RUN\ + --mount=...): this parser would not see the keyword
# on that line, so the RUN flag pass would treat the flags as text. Only words that
# are a keyword prefix count, so a heredoc body line such as echo\ is not refused.
# BuildKit's line continuation: the last non-blank character is ESC and the one
# before it is not ESC, or ESC stands alone (with blanks) on the line.
function contd(t) {
  sub(/[ \t]+$/, "", t)
  return (length(t) > 0 && substr(t, length(t), 1) == ESC && (length(t) == 1 || substr(t, length(t) - 1, 1) != ESC))
}
function kwglued(w,   k, n, i) {
  if (length(w) < 2 || !contd(w)) return
  k = toupper(substr(w, 1, length(w) - 1))
  n = split("FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL", KWS, " ")
  for (i = 1; i <= n; i++)
    if (index(KWS[i], k) == 1) { rep("REFUSE an instruction keyword continued over a line break is not supported: " w); return }
}
function procline(line,   rest, out, w, pre, wi, first, last, kw, cr, sp, tl) {
  cr = ""
  if (substr(line, length(line), 1) == "\r") { cr = "\r"; line = substr(line, 1, length(line) - 1) }
  rest = line; out = ""; first = !incont; wi = 0
  if (first) { inflags = 0; onb = 0 }
  while (match(rest, /[^ \t]+/)) {
    pre = substr(rest, 1, RSTART - 1); w = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH)
    wi++
    last = (rest ~ /^[ \t]*$/)
    if (first && wi == 1) { kwglued(w); kw = toupper(w); ikw = kw; inflags = (kw == "RUN"); onb = (kw == "ONBUILD"); out = out pre w; continue }
    if (onb && wi == 2 && first) { kwglued(w); inflags = (toupper(w) == "RUN"); onb = 0; out = out pre w; continue }
    if (inflags && last && w == ESC) { out = out pre w; continue }
    if (inflags && substr(w, 1, 2) == "--") {
      if (last && length(w) > 2 && contd(w))
        rep1("REFUSE a RUN flag continued over a line break is not supported (keep each --mount= on one line): " w)
      if (tolower(substr(w, 1, 8)) == "--mount=") {
        # a continuation glued to the flag at the end of the line is not part of the
        # spec (it is refused above as a split flag; keep it in the output as is)
        sp = substr(w, 9); tl = ""
        if (last && length(sp) > 0 && contd(sp)) { tl = ESC; sp = substr(sp, 1, length(sp) - 1) }
        w = substr(w, 1, 8) rewrite(sp, 1) tl
      }
      out = out pre w
      continue
    }
    inflags = 0
    out = out pre textmount(w)
  }
  out = out rest cr
  incont = contd(line)
  return out
}
function count(s,   n, p, low) {
  n = 0; low = tolower(s)
  while ((p = index(low, "--mount=")) > 0) { n++; low = substr(low, p + 8) }
  return n
}
# Logical instructions with the active escape char, joined the way BuildKit does
# (comment and blank lines dropped; a continued line keeps its leading whitespace;
# the ESC and the blanks after it are removed). Feeds ARG / FROM / --from= and the
# split check.
function join_add(line,   t) {
  if (line ~ /^[ \t]*(#.*)?[\r]?$/) return
  t = line
  if (contd(t)) {
    sub(/[ \t]+$/, "", t)
    jbuf = (jcont ? jbuf : "") substr(t, 1, length(t) - 1)
    jcont = 1
    gluedflag(jbuf)
    return
  }
  jbuf = (jcont ? jbuf : "") t
  jcont = 0
  instr(ESC, jbuf)
  jbuf = ""
}
# a RUN flag word glued to a line continuation (--mount=...\ and the next line):
# BuildKit joins the next line to the flag as it is, while rewrite() reads the
# physical line. The joined line is the authority (an ONBUILD or a keyword continued
# over a line break included). COPY / ADD / FROM flags are read from the joined line
# only, which joins as BuildKit does. s: the joined text so far.
function gluedflag(s,   w, n, i, j) {
  if (s == "" || s ~ /[ \t]$/) return
  n = split(s, w, /[ \t]+/); i = 1
  if (w[1] == "") i = 2
  if (toupper(w[i]) == "ONBUILD") i++
  if (n <= i || toupper(w[i]) != "RUN") return
  for (j = i + 1; j <= n; j++) if (substr(w[j], 1, 2) != "--") return
  rep1("REFUSE a RUN flag continued over a line break is not supported (keep each --mount= on one line): " w[n] ESC)
}
function mountcheck(spec,   n, f, i, k, type) {
  if (spec ~ /["']/) { rep("REFUSE a --mount= flag with quotes is not supported (write it unquoted): --mount=" spec); return }
  n = split(spec, f, ",")
  type = "bind"
  for (i = 1; i <= n; i++) {
    k = fkey(f[i])
    if (k == "type") type = tolower(fval(f[i]))
    else if (k == "from") qref(fval(f[i]), 1, 0, 1)
  }
  if (type ~ /[$]/) rep("REFUSE a --mount= type set from a variable is not supported: --mount=" spec)
}
# one RUN flag word (lowercase name): --network other than default / none,
# any --security, any --device.
function runflag(f,   low, v) {
  low = tolower(f); v = f; sub(/^[^=]*=?/, "", v); gsub(/["']/, "", v)
  if (low ~ /^--network(=|$)/ && v != "default" && v != "none") rep("REFUSE a RUN --network= other than default or none is not supported (the step would share the host's network): " f)
  else if (low ~ /^--security(=|$)/) rep("REFUSE a RUN --security= flag is not supported (insecure runs the step with every capability): " f)
  else if (low ~ /^--device(=|$)/) rep("REFUSE a RUN --device= flag is not supported (it hands the step a host device): " f)
}
# why an ADD source word is fetched from outside the build context, or "".
# Twin of addSourceRefusal (TS); a test runs both on one table.
function addsrc(src, json,   t) {
  # BuildKit unquotes and unescapes a source (shlex, or a JSON string decode) before it
  # decides whether to fetch it, so this parser would read another word: refuse \ and '
  # always, and a double quote outside the JSON form (where it delimits the strings).
  if (index(src, "\\") || index(src, "'")) return "quoted or escaped (write it plainly)"
  if (!json && index(src, "\"")) return "quoted or escaped (write it plainly)"
  t = tolower(src); gsub(/["\[\],]/, "", t)
  if (t == "") return ""
  if (index(t, "://")) return "a URL"
  if (index(t, "$")) return "built from a variable"
  if (substr(t, 1, 4) == "git@" || t ~ /^[^\/]*@[^\/]*:/) return "a git remote (user@host:path)"
  if (substr(t, 1, 11) == "github.com/" || t ~ /[.]git$/ || index(t, "#")) return "a git remote"
  return ""
}
# the heredoc markers of a joined RUN / COPY / ADD line with <<. BuildKit
# (heredocsFromLine) splits the line into shell words (quotes and \ escapes kept,
# braced variables expanded, Unicode spaces, blanks right after << kept in the word:
# << EOF is <<EOF) and reads each word matching ^(\d*)<<(-?)\s*([^<]*)$ as a marker; a
# lexing error (an unbalanced quote, a bad braced variable) drops every marker. Only
# the forms this parser reads exactly as BuildKit does pass: a whole word
# [0-9]*<<[-]NAME, <<"NAME" or <<'NAME' (NAME: [A-Za-z_][A-Za-z0-9_]*) outside quotes,
# on an ASCII line whose braced variables are all plain {NAME}. Any other << on the
# line is refused, so a body this parser misses can never be read as instructions.
function heredocs(s,   t, tot, nw, W, wd, q, c, k, ln, ok, v, hc) {
  if (s ~ HI) { rep("REFUSE a non-ASCII character on a RUN / COPY / ADD line with a heredoc marker (<<) is not supported (BuildKit splits the marker words on Unicode spaces): " s); return }
  t = s
  while (match(t, /[$][{]/)) {
    if (substr(t, RSTART) !~ /^[$][{][A-Za-z_][A-Za-z0-9_]*[}]/) { rep("REFUSE a braced variable other than $" "{NAME} on a line with a heredoc marker (<<) is not supported: " s); return }
    t = substr(t, RSTART + 2)
  }
  # shell words: blanks split outside quotes; \ keeps the next character in the
  # word (inside double quotes too); single quotes keep everything to the next one.
  q = ""; wd = ""; nw = 0; ln = length(s)
  for (k = 1; k <= ln; k++) {
    c = substr(s, k, 1)
    if (q == "'") { wd = wd c; if (c == "'") q = ""; continue }
    if (c == "\\") { wd = wd c; if (k < ln) wd = wd substr(s, ++k, 1); continue }
    if (q == "\"") { wd = wd c; if (c == "\"") q = ""; continue }
    if (c == " " || c == "\t") { if (wd != "") W[++nw] = wd; wd = ""; continue }
    if (c == "'" || c == "\"") q = c
    wd = wd c
  }
  if (q != "") { rep("REFUSE an unbalanced quote on a line with a heredoc marker (<<) is not supported: " s); return }
  if (wd != "") W[++nw] = wd
  t = s; tot = gsub(/<</, "", t); ok = 0
  for (k = 1; k <= nw; k++) if (W[k] ~ /^[0-9]*<<-?([A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*"|'[A-Za-z_][A-Za-z0-9_]*')$/) {
    ok++; v = W[k]; sub(/^[0-9]*<</, "", v); hc = (substr(v, 1, 1) == "-"); if (hc) v = substr(v, 2)
    gsub(/["']/, "", v); HDN[++nhd] = v; HDC[nhd] = hc
  }
  if (ok != tot) rep("REFUSE a heredoc marker other than <<NAME, <<-NAME, <<\"NAME\" or <<'NAME' as its own word (NAME: letters, digits, _; no blank after <<, no <<<, no << inside quotes or another word) is not supported: " s)
}
# s without its quoted parts ('...' and "..." with \ escapes, as the shell lexer
# reads them); an unbalanced quote keeps the rest of the line.
function unquoted(s,   out, q, c, k, ln, st) {
  out = ""; q = ""; ln = length(s)
  for (k = 1; k <= ln; k++) {
    c = substr(s, k, 1)
    if (q == "'") { if (c == "'") q = ""; continue }
    if (q == "\"") { if (c == "\\") k++; else if (c == "\"") q = ""; continue }
    if (c == "\\") { out = out c substr(s, k + 1, 1); k++; continue }
    if (c == "'" || c == "\"") { q = c; st = k; continue }
    out = out c
  }
  return q == "" ? out : out substr(s, st)
}
function instr(e, s,   w, n, i, kw, a, j, v, low, fe, last, hc, ob, fl) {
  # trailing blanks (BuildKit trims them): split() below would read an empty last word
  sub(/[ \t]+$/, "", s)
  joined += count(s)
  # the reserved name on the joined logical line (POWDER_\ + NS_x)
  if (!nsseen && toupper(s) ~ /POWDER_NS/) { nsseen = 1; rep("REFUSE the name POWDER_NS is reserved for powder's per-app build namespace") }
  # a Unicode space outside quotes in an instruction (heredoc bodies are free text):
  # BuildKit's shell lexer splits words there, this parser does not.
  if (!body && s ~ USP && unquoted(s) ~ USP) rep("REFUSE a Unicode space (e.g. a no-break space) outside quotes in an instruction is not supported (BuildKit splits words there, this parser does not; write a plain space): line " NR)
  n = split(s, w, /[ \t]+/)
  i = 1
  if (w[1] == "") i = 2
  kw = toupper(w[i])
  # the line a ref is reported at (the instruction's last physical line), and
  # the --mount from= values rewrite() saw on this instruction's lines.
  CURLN = NR; for (j = 1; j <= npm; j++) qref(PM[j], 1, 0, 1)
  npm = 0
  ob = 0
  if (kw == "ONBUILD" && i < n) { i++; kw = toupper(w[i]); ob = 1 }
  # flag words of RUN/COPY/ADD/FROM are read unquoted here; BuildKit would
  # unquote them, so a quote or backslash means this parser may see another value.
  # BuildKit's flag splitter drops \ (frontend 1.14 and older, whatever
  # escape= says) or the escape= character (1.16 and newer), so --fr@BT@om= is --from=
  # and --mou@BT@nt= is --mount=: refuse \ and the backtick in every flag word, the
  # --mount= ones included. join_add already removed a line continuation at the end
  # of a physical line (glued to the flag or not), so it is never counted here.
  fe = i + 1
  # RUN<no-break space>--mount=...: BuildKit may split the keyword there.
  if (match(w[i], HI)) {
    a = toupper(substr(w[i], 1, RSTART - 1))
    if (a == "RUN" || a == "COPY" || a == "ADD" || a == "FROM" || a == "ONBUILD") rep("REFUSE an instruction keyword followed by a non-ASCII byte is not supported: " w[i])
  }
  if (kw == "RUN" || kw == "COPY" || kw == "ADD" || kw == "FROM") {
    # bytes >= 0x80 next to the keyword or in a flag word (0x85 / 0xA0 split
    # words in BuildKit's flag parser) are refused; a word that starts with such
    # bytes and then -- is a flag to BuildKit too. Shell text after the flags is free.
    for (fe = i + 1; fe <= n; fe++) {
      a = w[fe]; while (substr(a, 1, 1) ~ HI) a = substr(a, 2)
      if (a !~ /^--/) break
      if (w[fe] ~ HI) { rep("REFUSE a " kw " flag with a non-ASCII byte (e.g. a no-break space) is not supported: " w[fe]); continue }
      if (w[fe] ~ /[\\@BT@]/) { rep("REFUSE a " kw " flag with a backslash or a backtick is not supported (write it plainly): " w[fe]); continue }
      # RUN flags that widen what the build step can reach on the host (flag
      # position only: --network-timeout after the command is the command's).
      if (kw == "RUN") runflag(w[fe])
      # ADD flags that only make sense with a URL or git source.
      if (kw == "ADD") { low = tolower(w[fe]); if (substr(low, 1, 14) == "--keep-git-dir" || substr(low, 1, 10) == "--checksum") rep("REFUSE an ADD " w[fe] " flag is not supported (it goes with a URL or git source, which the build would fetch as root on the host)") }
      # the joined logical line is the authority for --mount flags (a keyword
      # or flag list split over physical lines still reaches here): the same strict
      # checks as rewrite(): no quotes, no variable type=, from= images collected
      # (a repeat of an IMG or REFUSE line from rewrite() is harmless).
      if (tolower(substr(w[fe], 1, 8)) == "--mount=") { if (kw == "RUN") mountcheck(substr(w[fe], 9)); continue }
      if (w[fe] ~ /["']/) rep("REFUSE a " kw " flag with a quote is not supported (write it unquoted): " w[fe])
    }
  }
  # ADD with a URL, git remote or variable source.
  if (kw == "ADD" && fe <= n) {
    hc = (substr(w[fe], 1, 1) == "[")
    last = hc ? n : n - 1
    if (last < fe) last = fe
    for (j = fe; j <= last; j++) { v = (w[j] ~ /^[0-9]*<<[^<]/) ? "" : addsrc(w[j], hc); if (v != "") rep("REFUSE an ADD source that is " v " is not supported (BuildKit fetches it inside dockerd as root on the host, with root's git and registry credentials); download it in a RUN step or COPY it from the repo: " w[j]) }
  }
  # heredoc markers of RUN / COPY / ADD: the next physical lines are their
  # bodies, where no ARG is inserted. A line inside a body is no instruction to
  # BuildKit: its << words start nothing.
  if ((kw == "RUN" || kw == "COPY" || kw == "ADD") && !body && index(s, "<<")) heredocs(s)
  if (kw == "ARG") {
    for (j = i + 1; j <= n; j++) argdecl(w[j], ob)
  } else if (kw == "ENV" && i < n) {
    # backstop: an ENV value of a name a ref uses is checked as well.
    if (index(w[i + 1], "=")) { for (j = i + 1; j <= n; j++) { a = index(w[j], "="); if (a > 1) { v = substr(w[j], a + 1); gsub(/["']/, "", v); envdecl(substr(w[j], 1, a - 1), v, ob) } } }
    else { v = w[i + 2]; for (j = i + 3; j <= n; j++) v = v " " w[j]; gsub(/["']/, "", v); envdecl(w[i + 1], v, ob) }
  } else if (kw == "FROM") {
    # --platform= picks another variant of the base than the one dfr_bases
    # inspects; only the build's own platform variables pass.
    fl = ""
    for (j = i + 1; j <= n && w[j] ~ /^--/; j++) {
      v = w[j]; low = tolower(v)
      if (substr(low, 1, 11) == "--platform=" && (substr(v, 12) == "$BUILDPLATFORM" || substr(v, 12) == "$" "{BUILDPLATFORM}" || substr(v, 12) == "$TARGETPLATFORM" || substr(v, 12) == "$" "{TARGETPLATFORM}")) fl = fl " " v
      else rep("REFUSE a FROM flag other than --platform=$BUILDPLATFORM or --platform=$TARGETPLATFORM is not supported (powder checks the base image variant of this server's platform): " v)
    }
    if (j <= n) {
      # FROM resolves against the meta ARGs; then a new stage starts with no ARGs.
      # a FROM sees only the stages declared on EARLIER FROM lines (never its own
      # AS): QF holds this FROM's stage number, stage[] the number that declared a name.
      qref(w[j], 1, 1); if (w[j] != "") QF[nq] = nstg + 1
      # the base image this FROM reads, as BuildKit resolves it at this line
      # (build args over the meta ARGs; an earlier stage or scratch is no image). The
      # FROM is written back as one line with a token for it, which dfr_bases replaces
      # with the image it inspected, pinned to its registry digest: the build reads
      # exactly what was checked. A ref that does not resolve cannot be checked.
      if (!ob && !body) {
        v = (w[j] ~ /[$]/) ? QV[nq] : w[j]
        if (v == "") rep("REFUSE a FROM image ref that does not resolve (a variable with no ARG default or build arg) is not supported: powder must inspect the base image before the build: " w[j])
        else if (!((tolower(v) in stage) || tolower(v) == "scratch") && v ~ /^[A-Za-z0-9._\/:@-]+$/) {
          FTOK = "__POWDER_BASE_" (++nbase) "__"; rep("BASE " nbase " " v)
          # no --platform flag on the written line: the build reads the variant
          # of the inspected (pinned) image, whatever a platform ARG would say
          FOUT = "FROM " FTOK
          if (j + 2 == n && toupper(w[j + 1]) == "AS") FOUT = FOUT " AS " w[j + 2]
          else if (j != n) rep("REFUSE a FROM line other than FROM [--platform=...] <image> [AS <name>] is not supported: " s)
        } else if (w[j] ~ /[$]/ && ((tolower(v) in stage) || tolower(v) == "scratch")) {
          # a variable ref that names an earlier stage or scratch: written back as that
          # literal, so BuildKit reads exactly the stage this parser resolved (not
          # whatever its own values, e.g. the automatic ARGs, would make of the variable).
          FTOK = "-"; FOUT = "FROM" fl " " v
          if (j + 2 == n && toupper(w[j + 1]) == "AS") FOUT = FOUT " AS " w[j + 2]
          else if (j != n) rep("REFUSE a FROM line other than FROM [--platform=...] <image> [AS <name>] is not supported: " s)
        }
      }
      if (j + 2 <= n && toupper(w[j + 1]) == "AS" && !(tolower(w[j + 2]) in stage)) stage[tolower(w[j + 2])] = nstg + 1
    }
    nstg++; split("", SA); split("", SE)
  }
  for (j = i + 1; j <= n; j++) {
    low = tolower(w[j])
    if (substr(low, 1, 7) == "--from=") qref(substr(w[j], 8), (j < fe && (kw == "COPY" || kw == "ADD")), 0)
  }
}
# ARG scope as BuildKit has it. An ARG before the first FROM is a meta ARG (MA),
# the only ones FROM sees; an ARG inside a stage (SA, emptied at every FROM) is what
# COPY --from / --mount from= on later lines of that stage see. A build arg the build
# passes (OVR: compose build.args, the builder's args) wins for a declared ARG; a stage
# ARG without a default inherits the meta value. A default is expanded at its line
# (left with its $ when it does not resolve, so a ref using it stays UNRESOLVED).
# BuildKit's automatic platform ARGs; a value set for one (an ARG default or a
# build arg) makes a FROM resolve another variant than the one dfr_bases inspected.
function platarg(k) { return toupper(k) ~ /^(BUILD|TARGET)(PLATFORM|OS|ARCH|VARIANT|OSVERSION)$/ }
# BuildKit's automatic global args (its defaultArgs: the platform ones and TARGETSTAGE,
# the last stage's name with no --target) are set with no ARG line, to values this parser
# does not see. A name whose ARG / ENV value uses one (TAINT) carries it on. A strict
# image ref that uses either is refused (qref).
function autoarg(k) { return platarg(k) || toupper(k) == "TARGETSTAGE" }
function usesauto(v,   nm) {
  while (match(v, /[$][{]?[A-Za-z_][A-Za-z0-9_]*/)) {
    nm = substr(v, RSTART, RLENGTH); sub(/^[$][{]?/, "", nm); v = substr(v, RSTART + RLENGTH)
    if (autoarg(nm) || (nm in TAINT)) return nm
  }
  return ""
}
function argdecl(wd, ob,   a, k, v, e) {
  a = index(wd, "="); k = a ? substr(wd, 1, a - 1) : wd
  if (k == "") return
  if (a && platarg(k)) rep("REFUSE a value for the build platform ARG " k " is not supported (powder checks the base image variant of this server's platform; a bare ARG " k " without a default is fine): " wd)
  if (a) {
    v = substr(wd, a + 1); gsub(/["']/, "", v)
    if (usesauto(v) != "") TAINT[k] = 1
    e = v; if (v ~ /[$]/) { e = nstg ? subst(v, SA) : subst(v, MA); if (e == "") e = v }
    addcand(k, e)
  }
  # an ONBUILD ARG runs in a child build: a backstop value only
  if (ob) return
  if (k in OVR) e = OVR[k]
  else if (!a) e = (nstg && (k in MA)) ? MA[k] : ""
  if (nstg) SA[k] = e; else MA[k] = e
}
# an ENV value is expanded at its line with the stage's ARGs and earlier ENVs
# (an unset name expands to nothing, as BuildKit does), then kept as a backstop value;
# an empty result is dropped.
function envdecl(k, v, ob,   e, t) {
  if (k == "") return
  if (usesauto(v) != "") TAINT[k] = 1
  split("", EX); for (t in SA) EX[t] = SA[t]; for (t in SE) EX[t] = SE[t]
  e = v
  # a braced form this parser cannot expand ({P%Z}, {P:?e}, ...) keeps the raw
  # value, so a ref using the name stays UNRESOLVED (fail closed, as argdecl does);
  # only a value that really expands to nothing is dropped.
  if (v ~ /[$]/) { UNR = 0; if (nstg) e = xpand(v, EX, 1, 0); else e = xpand(v, MA, 1, 0); if (UNR) e = v }
  addcand(k, e)
  if (!ob && nstg) SE[k] = e
}
# backstop: every value a name is ever given (ARG defaults anywhere, ENV, the
# build arg); a ref using the name is checked with each of them too.
function addcand(k, v) {
  if (v == "" || ((k, v) in CS)) return
  CS[k, v] = 1; CV[k, ++CN[k]] = v
}
# Queue an image ref, resolved AT ITS LINE (meta = 1: the meta ARGs, else this stage's),
# with the in-scope values of the names it uses (for the backstop at END). mnt = 1: a RUN
# --mount from= (QM), which BuildKit looks up by stage name only.
function qref(r, strict, meta, mnt,   s, nm) {
  if (r == "") return
  nq++; QR[nq] = r; QS[nq] = strict; QN[nq] = 0; QM[nq] = mnt
  if (r !~ /[$]/) { QV[nq] = r; rep1("AT " CURLN " " r " " r); return }
  nm = usesauto(r)
  if (strict && nm != "") rep1("REFUSE an image ref that uses BuildKit's automatic ARG " nm " (directly or through an ARG or ENV value) is not supported: BuildKit gives it a value powder does not see when it checks the ref: " r)
  # in a stage the ENVs above the line count too, over an ARG of the same name
  # (BuildKit's precedence)
  if (!meta) { split("", EX); for (nm in SA) EX[nm] = SA[nm]; for (nm in SE) EX[nm] = SE[nm] }
  QV[nq] = meta ? subst(r, MA) : subst(r, EX)
  if (QV[nq] ~ /[$]/) QV[nq] = ""
  # the ref as resolved at its line, without the backstop (informational)
  rep1("AT " CURLN " " r " " (QV[nq] == "" ? "-" : QV[nq]))
  s = r
  while (match(s, /[$][{]?[A-Za-z_][A-Za-z0-9_]*/)) {
    nm = substr(s, RSTART, RLENGTH); sub(/^[$][{]?/, "", nm); s = substr(s, RSTART + RLENGTH)
    QK[nq, ++QN[nq]] = nm
    QL[nq, QN[nq]] = meta ? ((nm in MA) ? MA[nm] : "") : ((nm in EX) ? EX[nm] : "")
  }
}
# expand the variables of r with the values in A, left to right; a value is
# not expanded again. $N and the braced forms {N}, {N:-w} / {N-w} (w when N is unset or
# empty), {N:+w} / {N+w} (w when N is set, else nothing); w is expanded the same way
# (nested, depth 8, the matching brace found by counting). Strict (lax = 0, image refs):
# an unset or empty name without a default makes the whole ref unresolved (UNR = 1). Lax
# (ENV values): it expands to nothing. A malformed braced form is unresolved in both.
function xpand(r, A, lax, dep,   out, i, n, c, j, k, bd, name, op, w, v, set) {
  if (dep > 8) { UNR = 1; return "" }
  out = ""; i = 1; n = length(r)
  while (i <= n) {
    c = substr(r, i, 1)
    if (c != "$") { out = out c; i++; continue }
    if (substr(r, i + 1, 1) == "{") {
      j = i + 2
      if (!match(substr(r, j), /^[A-Za-z_][A-Za-z0-9_]*/)) { UNR = 1; return "" }
      name = substr(r, j, RLENGTH); j += RLENGTH; op = ""; w = ""
      if (substr(r, j, 1) == "}") k = j
      else {
        if (substr(r, j, 2) == ":-" || substr(r, j, 2) == ":+") { op = substr(r, j + 1, 1); j += 2 }
        else if (substr(r, j, 1) == "-" || substr(r, j, 1) == "+") { op = substr(r, j, 1); j++ }
        else { UNR = 1; return "" }
        bd = 1
        for (k = j; k <= n; k++) { c = substr(r, k, 1); if (c == "{") bd++; else if (c == "}" && --bd == 0) break }
        if (k > n) { UNR = 1; return "" }
        w = substr(r, j, k - j)
      }
      set = ((name in A) && A[name] != "")
      if (op == "-") v = set ? A[name] : xpand(w, A, lax, dep + 1)
      else if (op == "+") v = set ? xpand(w, A, lax, dep + 1) : ""
      else if (set) v = A[name]
      else if (lax) v = ""
      else { UNR = 1; return "" }
      if (UNR) return ""
      out = out v; i = k + 1
      continue
    }
    if (match(substr(r, i + 1), /^[A-Za-z_][A-Za-z0-9_]*/)) {
      name = substr(r, i + 1, RLENGTH); i += 1 + RLENGTH
      if ((name in A) && A[name] != "") out = out A[name]
      else if (!lax) { UNR = 1; return "" }
      continue
    }
    out = out c; i++
  }
  return out
}
# Strict expansion (image refs, ARG defaults): "" when unresolved.
function subst(r, A,   s) { UNR = 0; s = xpand(r, A, 0, 0); return UNR ? "" : s }
function rep1(s) { if (!(s in EMT)) { EMT[s] = 1; rep(s) } }
# strict = 1: a real image ref (FROM, a COPY/ADD --from= flag, a RUN --mount from=).
# 0: --from= text elsewhere (shell text): odd characters are dropped, not refused.
# s: the ref as resolved. fi: the stage number of a FROM ref (0: COPY --from,
# --mount from=). A FROM reads a stage only when an earlier FROM declared it, and a number
# there is an image name; COPY --from reads any stage name or index. mnt = 1: a RUN
# --mount from=, which BuildKit (detectRunMount, findStateByName) looks up by stage name
# only, so a number there is an image name too.
function isstg(x, fi) { return fi ? ((x in stage) && stage[x] < fi) : (x in stage) }
# a COPY / ADD --from= number is a stage index only when Go's strconv.Atoi parses it (up to 9
# significant digits here, which fits any int); a longer one is a name to BuildKit, so an
# image ref. An index past the last stage fails the build: refused here (strict).
function stgidx(r,   t) { if (r !~ /^[0-9]+$/) return 0; t = r; sub(/^0+/, "", t); return length(t) <= 9 }
function ref_out(r, strict, s, bk, fi, mnt) {
  if (!fi && !mnt && stgidx(r)) { if (strict && r + 0 >= nstg) rep1("REFUSE a stage index past the last stage is not supported (BuildKit fails the build): --from=" r); return }
  if (r == "" || isstg(tolower(r), fi) || tolower(r) == "scratch") return
  # a backstop value that is no image name (spaces, quotes) cannot be pulled
  if (bk && s !~ /[$]/ && s !~ /^[A-Za-z0-9._\/:@-]*$/) return
  if (s == "" || s ~ /[$]/) { rep1("UNRESOLVED " r); return }
  # a ref built from a variable, as written and as resolved (informational;
  # dfr_one ignores the line, the server probe prints it)
  if (r ~ /[$]/) rep1("VARREF " r " " s)
  if (isstg(tolower(s), fi) || tolower(s) == "scratch") return
  if (s !~ /^[A-Za-z0-9._\/:@-]+$/) {
    if (strict) rep1("REFUSE image ref " r " has characters an image name cannot have (quotes, backslashes, spaces): write it plainly")
    return
  }
  rep1("IMG " s)
}
BEGIN {
  SYNTAX = ENVIRON["DFR_SYNTAX"]; RP = ENVIRON["DFR_RP"]; TF = ENVIRON["DFR_TF"]; APP = ENVIRON["DFR_APP"]
  ESC = "\\"; head = 1; rewrote = 0; BOM = sprintf("%c%c%c", 239, 187, 191)
  # BuildKit's whitespace is Go's unicode.IsSpace, which adds \v, \f and the
  # bytes 0x85 / 0xA0 (byte-wise in its flag splitter) to space and tab. HI matches
  # one byte >= 0x80 (each byte listed: no locale-dependent ranges; run with LC_ALL=C).
  # an allow-list, not a deny-list. BuildKit reads \r, \v and \f as whitespace
  # (directive regex \s, splitCommand [\t\v\f\r ]+) where this parser splits on space
  # and tab only, so every control byte (0x00-0x1F, 0x7F) other than tab is refused.
  # Each byte is listed (no locale-dependent ranges); NUL only where awk keeps it
  # (mawk), dfr_one checks NUL in the shell first.
  nctl = 0; for (i = 0; i < 32; i++) if (i != 9 && i != 10) { c = sprintf("%c", i); if (length(c) == 1) CTL[++nctl] = c }
  CTL[++nctl] = sprintf("%c", 127)
  HI = "["; for (i = 128; i < 256; i++) HI = HI sprintf("%c", i); HI = HI "]"
  # the UTF-8 forms of the non-ASCII spaces of Go's unicode.IsSpace (U+0085, U+00A0,
  # U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000): BuildKit's shell
  # lexer splits words there, this parser does not.
  # Each byte is listed (no ranges).
  c = "["; for (i = 128; i <= 138; i++) c = c sprintf("%c", i)
  c = c sprintf("%c%c%c", 168, 169, 175) "]"
  USP = sprintf("%c%c|%c%c|%c%c%c|%c%c", 194, 133, 194, 160, 225, 154, 128, 226, 128) c "|" sprintf("%c%c%c|%c%c%c", 226, 129, 159, 227, 128, 128)
  if (APP == "" || length(ENVIRON["DFR_NS"]) < 16) rep("REFUSE no build cache namespace")
  # an ARG declared right after every FROM puts this per-app name in the env of
  # every RUN of the stage, so BuildKit's RUN cache keys (which ignore secret mount
  # content) differ per app. The name derives from the namespace (a salted hash).
  NSARG = "ARG POWDER_NS_" hash("powder:run-layer-ns") "=1"
  # the build args of this build (DFR_ARGF: KEY=VALUE lines), see ARG below.
  AF = ENVIRON["DFR_ARGF"]
  if (AF != "") { while ((getline al < AF) > 0) { ai = index(al, "="); if (ai > 1 && platarg(substr(al, 1, ai - 1))) rep("REFUSE a build arg for the build platform ARG " substr(al, 1, ai - 1) " is not supported (powder checks the base image variant of this server's platform)"); if (ai > 1) { OVR[substr(al, 1, ai - 1)] = substr(al, ai + 1); addcand(substr(al, 1, ai - 1), substr(al, ai + 1)) } } close(AF) }
  # meta ARGs, the ARGs of the current stage, the stage count
  split("", MA); split("", SA); split("", SE); nstg = 0; npm = 0
  nhd = 0; hdi = 1
}
function syntax_check(line,   v, d) {
  v = line; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t\r]+$/, "", v)
  d = index(v, "@sha256:")
  if (v !~ SYNTAX || (d > 0 && length(substr(v, d + 8)) != 64))
    rep("REFUSE syntax=" v " is not allowed: powder builds only with Docker's Dockerfile frontend (# syntax=docker/dockerfile:<version>, optionally @sha256:<digest>); a custom frontend can read files .dockerignore keeps out of the build")
}
{
  line = $0
  # BuildKit strips a UTF-8 byte order mark before it looks for directives.
  if (NR == 1 && substr(line, 1, 3) == BOM) line = substr(line, 4)
  # CRLF: one trailing \r per physical line, so a CRLF Dockerfile reads like LF.
  if (substr(line, length(line), 1) == "\r") line = substr(line, 1, length(line) - 1)
  # any control byte other than tab left after that (a mid-line \r, \v, \f,
  # NUL, ESC, ...) is refused, heredoc bodies included: BuildKit reads some of them
  # as whitespace (blank lines, comment indentation, flag separators, directive
  # padding) and none has a legitimate use in a Dockerfile.
  if (!ctlseen) for (i = 1; i <= nctl; i++) if (index(line, CTL[i])) { ctlseen = 1; rep("REFUSE a Dockerfile with control characters other than tab is not supported"); break }
  # A line that starts (after spaces and tabs) with a byte >= 0x80: a no-break space
  # or another Unicode space would make BuildKit read a comment, a blank line or a
  # flag where this parser sees text.
  if (match(line, /^[ \t]*/) && substr(line, RLENGTH + 1, 1) ~ HI)
    rep("REFUSE a line that starts with a non-ASCII character (e.g. a no-break space) is not supported (line " NR ")")
  if (head) {
    if (line ~ /^[ \t]*((#|\/\/).*)?[\r]?$/) {
      low = tolower(line)
      # A directive-like key padded with bytes >= 0x80 (no-break spaces): its key
      # with those bytes, #, / and blanks removed decides; escape is refused.
      if (index(line, "=")) {
        dk = substr(line, 1, index(line, "=") - 1); dh = (dk ~ HI)
        gsub(HI, "", dk); gsub(/[ \t#\/]/, "", dk)
        if (dh && tolower(dk) == "escape") rep("REFUSE a # escape= parser directive other than \\ is not supported")
        if (dh && tolower(dk) == "syntax") syntax_check(line)
      }
      # BuildKit reads directives only up to the first line that is not one
      # (a blank line or an ordinary comment ends them); this parser cannot tell
      # every case apart, so ESC is always \ and any escape directive in the leading
      # comment block with another value is refused.
      if (low ~ /^[ \t]*#[ \t]*escape[ \t]*=/) { v = line; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t\r]+$/, "", v); if (v != "\\") rep("REFUSE a # escape= parser directive other than \\ is not supported") }
      # BuildKit reads the syntax directive from # lines and from // lines.
      if (low ~ /^[ \t]*(#|\/\/)[ \t]*syntax[ \t]*=/) syntax_check(line)
    } else {
      head = 0
      # A JSON Dockerfile ({"syntax": ...}) selects its frontend from a JSON key.
      if (line ~ /^[ \t]*[{]/) rep("REFUSE a JSON-form Dockerfile is not supported (BuildKit takes its frontend from the JSON syntax key); use the plain Dockerfile syntax")
    }
  }
  # inside a heredoc body (after a RUN / COPY / ADD << marker, up to its
  # terminator) no ARG is inserted; a FROM there is refused, so a body this parser
  # misjudges can never hide a stage from the ARG insertion.
  body = 0
  if (hdi <= nhd) {
    body = 1; t = line; if (HDC[hdi]) sub(/^\t+/, "", t)
    if (t == HDN[hdi]) hdi++
    else if (line ~ /^[ \t]*[Ff][Rr][Oo][Mm]([ \t]|$)/) rep("REFUSE a FROM line inside a heredoc body is not supported (line " NR ")")
  }
  if (!tokseen && index(line, "__POWDER_BASE_")) { tokseen = 1; rep("REFUSE the name __POWDER_BASE_ is reserved for powder's base image pins (line " NR ")") }
  if (line ~ /^[ \t]*#/ || line ~ /^[ \t\r]*$/) { print line; next }
  if (!nsseen && toupper(line) ~ /POWDER_NS/) { nsseen = 1; rep("REFUSE the name POWDER_NS is reserved for powder's per-app build namespace (line " NR ")") }
  # a line ending in two or more ESC: BuildKit reads no continuation there, older
  # frontends (which # syntax= may pick) read one.
  t = line; sub(/[ \t]+$/, "", t)
  if (length(t) > 1 && substr(t, length(t), 1) == ESC && substr(t, length(t) - 1, 1) == ESC) rep("REFUSE a line ending in two or more escape characters is not supported (line " NR ")")
  if (!incont) ikw = ""
  pl += count(line)
  # the physical lines of a FROM are held until the instruction ends; then it
  # is written back as one line with its base image token (instr: FTOK, FOUT), or as
  # it was (a stage, scratch, a refused ref).
  pline = procline(line)
  if (ikw == "FROM" && !body) fbuf = fbuf pline "\n"; else print pline
  join_add(line)
  if (!incont && ikw == "FROM" && !body) { if (FTOK != "") print FOUT; else printf "%s", fbuf; fbuf = ""; FTOK = ""; print NSARG }
}
END {
  if (jbuf != "") instr(ESC, jbuf)
  # a FROM continued to the end of the file: written as it was (BuildKit refuses it)
  if (fbuf != "") printf "%s", fbuf
  CURLN = NR; for (j = 1; j <= npm; j++) qref(PM[j], 1, 0, 1)
  if (joined > pl) rep("REFUSE a --mount= flag is split over a line continuation (keep each --mount= on one line)")
  # each ref as resolved at its line; then, fail closed, with every value any
  # ARG / ENV / build arg of each name it uses is ever given (the other names at their
  # in-scope values). rewrite() and mountcheck() may both queue one --mount from=: a
  # report line is written once.
  for (q = 1; q <= nq; q++) {
    ref_out(QR[q], QS[q], QV[q], 0, QF[q], QM[q])
    for (j = 1; j <= QN[q]; j++) { nm = QK[q, j]
      for (c = 1; c <= CN[nm]; c++) {
        split("", T); for (k = 1; k <= QN[q]; k++) T[QK[q, k]] = QL[q, k]
        T[nm] = CV[nm, c]; ref_out(QR[q], QS[q], subst(QR[q], T), 1, QF[q], QM[q])
      }
    }
  }
  rep("REWROTE " rewrote)
}
`.replace(/@BT@/g, '`')

/** BuildKit's automatic platform ARGs (any case). A Dockerfile ARG default, a
 *  compose build arg or a builder arg for one is refused (twin of the awk's platarg). */
export const PLATFORM_ARG_RE = /^(BUILD|TARGET)(PLATFORM|OS|ARCH|VARIANT|OSVERSION)$/i

/** BuildKit's automatic global args (the platform ones and TARGETSTAGE), set with no
 *  ARG line; a strict image ref that uses one is refused (twin of the awk's autoarg). */
const AUTO_ARG_RE = /^((BUILD|TARGET)(PLATFORM|OS|ARCH|VARIANT|OSVERSION)|TARGETSTAGE)$/i

/** the only FROM flags powder passes (the build's own platform). */
const FROM_PLATFORM_OK = new Set(['$BUILDPLATFORM', '$' + '{BUILDPLATFORM}', '$TARGETPLATFORM', '$' + '{TARGETPLATFORM}'])

/** the TS twin of the image-ref pass of DOCKERFILE_REWRITE_AWK (argdecl, addcand,
 *  qref, subst, ref_out and the END loop): the report lines it writes about image refs
 *  (`IMG`, `UNRESOLVED`, `VARREF`, `REFUSE image ref ...`, and `AT <line> <ref>
 *  <resolved>` before the backstop), once each, in order. A ref is
 *  resolved AT ITS LINE: FROM against the meta ARGs (declared before the first FROM), COPY
 *  --from / RUN --mount from= against the ARGs of its stage declared above it (a stage ARG
 *  without a default inherits the meta value; a build arg overrides a declared ARG). Then,
 *  fail closed, against every value any ARG, ENV or build arg of each name it uses is ever
 *  given. Plain Dockerfile syntax only (escape `\`, no heredocs): the awk stays the
 *  authority on the server; a test runs both on one table. */
export function dockerfileImageRefReport(text: string, buildArgs: Record<string, string> = {}): string[] {
	const out: string[] = []
	const emitted = new Set<string>()
	const rep = (s: string) => {
		if (!emitted.has(s)) {
			emitted.add(s)
			out.push(s)
		}
	}
	const cand = new Map<string, string[]>()
	const addcand = (k: string, v: string) => {
		if (v === '') return
		const l = cand.get(k) ?? []
		if (!l.includes(v)) l.push(v)
		cand.set(k, l)
	}
	const ovr = new Map<string, string>()
	for (const [k, v] of Object.entries(buildArgs)) {
		// twin of the awk's platarg rule for build args
		if (PLATFORM_ARG_RE.test(k)) rep(`REFUSE a build arg for the build platform ARG ${k} is not supported (powder checks the base image variant of this server's platform)`)
		ovr.set(k, v)
		addcand(k, v)
	}
	const meta = new Map<string, string>()
	let st = new Map<string, string>()
	let nstg = 0
	// a stage name and the number of the FROM that declared it; a FROM ref carries
	// its own stage number (fi) and sees only names declared before it.
	const stages = new Map<string, number>()
	let nbase = 0
	// mnt: a RUN --mount from= (looked up by stage name only, twin of the awk's QM)
	const queue: { r: string; strict: boolean; v: string; names: [string, string][]; fi: number; mnt: boolean }[] = []
	// twin of xpand / subst: null = unresolved
	const xpand = (r: string, a: Map<string, string>, lax: boolean, dep: number): string | null => {
		if (dep > 8) return null
		let o = ''
		let i = 0
		const n = r.length
		while (i < n) {
			const c = r[i]
			if (c !== '$') {
				o += c
				i++
				continue
			}
			if (r[i + 1] === '{') {
				let j = i + 2
				const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(r.slice(j))
				if (!nm) return null
				const name = nm[0]
				j += name.length
				let op = ''
				let w = ''
				let k = j
				if (r[j] !== '}') {
					if (r.slice(j, j + 2) === ':-' || r.slice(j, j + 2) === ':+') {
						op = r[j + 1]
						j += 2
					} else if (r[j] === '-' || r[j] === '+') {
						op = r[j]
						j++
					} else return null
					let bd = 1
					for (k = j; k < n; k++) {
						if (r[k] === '{') bd++
						else if (r[k] === '}' && --bd === 0) break
					}
					if (k >= n) return null
					w = r.slice(j, k)
				}
				const val = a.get(name) ?? ''
				let v: string | null
				if (op === '-') v = val !== '' ? val : xpand(w, a, lax, dep + 1)
				else if (op === '+') v = val !== '' ? xpand(w, a, lax, dep + 1) : ''
				else if (val !== '') v = val
				else if (lax) v = ''
				else return null
				if (v === null) return null
				o += v
				i = k + 1
				continue
			}
			const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(r.slice(i + 1))
			if (nm) {
				const val = a.get(nm[0]) ?? ''
				i += 1 + nm[0].length
				if (val !== '') o += val
				else if (!lax) return null
				continue
			}
			o += c
			i++
		}
		return o
	}
	const subst = (r: string, a: Map<string, string>): string => xpand(r, a, false, 0) ?? ''
	let se = new Map<string, string>()
	let curln = 0
	// twin of the awk's TAINT / usesauto
	const taint = new Set<string>()
	const usesAuto = (v: string): string => {
		for (const m of v.matchAll(/\$\{?[A-Za-z_][A-Za-z0-9_]*/g)) {
			const nm = m[0].replace(/^\$\{?/, '')
			if (AUTO_ARG_RE.test(nm) || taint.has(nm)) return nm
		}
		return ''
	}
	const qref = (r: string, strict: boolean, isMeta: boolean, mnt = false) => {
		if (r === '') return
		const scope = isMeta ? meta : new Map([...st, ...se])
		if (!r.includes('$')) {
			queue.push({ r, strict, v: r, names: [], fi: 0, mnt })
			rep(`AT ${curln} ${r} ${r}`)
			return
		}
		const an = usesAuto(r)
		if (strict && an !== '') rep(`REFUSE an image ref that uses BuildKit's automatic ARG ${an} (directly or through an ARG or ENV value) is not supported: BuildKit gives it a value powder does not see when it checks the ref: ${r}`)
		const names: [string, string][] = []
		for (const m of r.matchAll(/\$\{?[A-Za-z_][A-Za-z0-9_]*/g)) {
			const nm = m[0].replace(/^\$\{?/, '')
			names.push([nm, scope.get(nm) ?? ''])
		}
		const v0 = subst(r, scope)
		const v = v0.includes('$') ? '' : v0
		queue.push({ r, strict, v, names, fi: 0, mnt })
		rep(`AT ${curln} ${r} ${v === '' ? '-' : v}`)
	}
	const envdecl = (k: string, v: string, ob: boolean) => {
		if (k === '') return
		if (usesAuto(v) !== '') taint.add(k)
		const e = v.includes('$') ? (xpand(v, nstg ? new Map([...st, ...se]) : meta, true, 0) ?? v) : v
		addcand(k, e)
		if (!ob && nstg) se.set(k, e)
	}
	const argdecl = (wd: string, ob: boolean) => {
		const a = wd.indexOf('=')
		const k = a >= 0 ? wd.slice(0, a) : wd
		if (k === '') return
		if (a >= 0 && PLATFORM_ARG_RE.test(k)) rep(`REFUSE a value for the build platform ARG ${k} is not supported (powder checks the base image variant of this server's platform; a bare ARG ${k} without a default is fine): ${wd}`)
		let e = ''
		if (a >= 0) {
			const v = wd.slice(a + 1).replace(/["']/g, '')
			if (usesAuto(v) !== '') taint.add(k)
			e = v
			if (v.includes('$')) e = subst(v, nstg ? st : meta) || v
			addcand(k, e)
		}
		if (ob) return
		if (ovr.has(k)) e = ovr.get(k) as string
		else if (a < 0) e = nstg && meta.has(k) ? (meta.get(k) as string) : ''
		;(nstg ? st : meta).set(k, e)
	}
	const mountFroms = (spec: string) => {
		if (/["'\\`]/.test(spec)) return
		for (const f of spec.split(',')) {
			const j = f.indexOf('=')
			const key = (j >= 0 ? f.slice(0, j) : f).trim().toLowerCase()
			if (key === 'from') qref(j >= 0 ? f.slice(j + 1) : '', true, false, true)
		}
	}
	const instr = (s0: string) => {
		// twin of the awk: trailing blanks trimmed before the split
		const s = s0.replace(/[ \t]+$/, '')
		const w = ['', ...s.split(/[ \t]+/)]
		const n = w.length - 1
		let i = w[1] === '' ? 2 : 1
		let kw = (w[i] ?? '').toUpperCase()
		let ob = false
		if (kw === 'ONBUILD' && i < n) {
			i++
			kw = w[i].toUpperCase()
			ob = true
		}
		let fe = i + 1
		if (kw === 'RUN' || kw === 'COPY' || kw === 'ADD' || kw === 'FROM') {
			for (fe = i + 1; fe <= n; fe++) {
				if (!w[fe].startsWith('--')) break
				if (/[\\`]/.test(w[fe])) continue
				if (w[fe].slice(0, 8).toLowerCase() === '--mount=' && kw === 'RUN') mountFroms(w[fe].slice(8))
			}
		}
		if (kw === 'ARG') {
			for (let j = i + 1; j <= n; j++) argdecl(w[j], ob)
		} else if (kw === 'ENV' && i < n) {
			if (w[i + 1].includes('=')) {
				for (let j = i + 1; j <= n; j++) {
					const a = w[j].indexOf('=')
					if (a > 0) envdecl(w[j].slice(0, a), w[j].slice(a + 1).replace(/["']/g, ''), ob)
				}
			} else {
				let v = w[i + 2] ?? ''
				for (let j = i + 3; j <= n; j++) v += ` ${w[j]}`
				envdecl(w[i + 1], v.replace(/["']/g, ''), ob)
			}
		} else if (kw === 'FROM') {
			let j = i + 1
			// twin of the awk's FROM flag rule and BASE line
			for (; j <= n && w[j].startsWith('--'); j++) {
				const v = w[j]
				if (!(v.slice(0, 11).toLowerCase() === '--platform=' && FROM_PLATFORM_OK.has(v.slice(11))))
					rep(`REFUSE a FROM flag other than --platform=$BUILDPLATFORM or --platform=$TARGETPLATFORM is not supported (powder checks the base image variant of this server's platform): ${v}`)
			}
			if (j <= n) {
				qref(w[j], true, true)
				const q = queue[queue.length - 1]
				if (q && q.r === w[j]) q.fi = nstg + 1
				if (!ob) {
					const v = w[j].includes('$') ? (q?.v ?? '') : w[j]
					if (v === '') rep(`REFUSE a FROM image ref that does not resolve (a variable with no ARG default or build arg) is not supported: powder must inspect the base image before the build: ${w[j]}`)
					else if (!(stages.has(v.toLowerCase()) || v.toLowerCase() === 'scratch') && /^[A-Za-z0-9._/:@-]+$/.test(v)) rep(`BASE ${++nbase} ${v}`)
				}
				if (j + 2 <= n && w[j + 1].toUpperCase() === 'AS' && !stages.has(w[j + 2].toLowerCase())) stages.set(w[j + 2].toLowerCase(), nstg + 1)
			}
			nstg++
			st = new Map()
			se = new Map()
		}
		for (let j = i + 1; j <= n; j++) {
			if (w[j].slice(0, 7).toLowerCase() === '--from=') qref(w[j].slice(7), j < fe && (kw === 'COPY' || kw === 'ADD'), false)
		}
	}
	let buf = ''
	let cont = false
	const lines = text.split('\n')
	if (text.endsWith('\n')) lines.pop()
	let ln = 0
	for (let line of lines) {
		ln++
		curln = ln
		if (line.endsWith('\r')) line = line.slice(0, -1)
		if (/^[ \t]*(#.*)?$/.test(line)) continue
		// twin of the awk's contd / join_add: the last non-blank character of the physical
		// line is \ and the one before it is not (or \ stands alone); a continued line
		// keeps its leading whitespace.
		const t = line.replace(/[ \t]+$/, '')
		if (t.endsWith('\\') && (t.length === 1 || t[t.length - 2] !== '\\')) {
			buf = (cont ? buf : '') + t.slice(0, -1)
			cont = true
			continue
		}
		buf = (cont ? buf : '') + line
		cont = false
		instr(buf)
		buf = ''
	}
	curln = ln
	if (buf !== '') instr(buf)
	const isStage = (x: string, fi: number) => {
		const d = stages.get(x.toLowerCase())
		return d !== undefined && (fi === 0 || d < fi)
	}
	// twin of the awk's stgidx: a COPY / ADD --from= stage index only when strconv.Atoi
	// parses it; a --mount from= number is an image name (mnt)
	const stgIdx = (r: string) => /^[0-9]+$/.test(r) && r.replace(/^0+/, '').length <= 9
	const refOut = (r: string, strict: boolean, s: string, bk = false, fi = 0, mnt = false) => {
		if (fi === 0 && !mnt && stgIdx(r)) {
			if (strict && Number(r) >= nstg) rep(`REFUSE a stage index past the last stage is not supported (BuildKit fails the build): --from=${r}`)
			return
		}
		if (r === '' || isStage(r, fi) || r.toLowerCase() === 'scratch') return
		if (bk && !s.includes('$') && !/^[A-Za-z0-9._/:@-]*$/.test(s)) return
		if (s === '' || s.includes('$')) return rep(`UNRESOLVED ${r}`)
		if (r.includes('$')) rep(`VARREF ${r} ${s}`)
		if (isStage(s, fi) || s.toLowerCase() === 'scratch') return
		if (!/^[A-Za-z0-9._/:@-]+$/.test(s)) {
			if (strict) rep(`REFUSE image ref ${r} has characters an image name cannot have (quotes, backslashes, spaces): write it plainly`)
			return
		}
		rep(`IMG ${s}`)
	}
	for (const q of queue) {
		refOut(q.r, q.strict, q.v, false, q.fi, q.mnt)
		for (const [nm] of q.names) {
			for (const c of cand.get(nm) ?? []) {
				const tmap = new Map(q.names)
				tmap.set(nm, c)
				refOut(q.r, q.strict, subst(q.r, tmap), true, q.fi, q.mnt)
			}
		}
	}
	return out
}

/** why an ADD source word makes BuildKit fetch from outside the build context
 *  (inside dockerd, as root on the host, with root's git and registry credentials), or
 *  null. JSON-form punctuation (`[`, `]`, `,`, quotes) is dropped first. The awk twin is
 *  `addsrc` in DOCKERFILE_REWRITE_AWK; a test runs both on one table. */
export function addSourceRefusal(src: string, json = false): string | null {
	// BuildKit unquotes / unescapes a source (shlex, or a JSON string decode) before it
	// decides whether to fetch it: \ and ' always, a double quote outside the JSON form.
	// a heredoc marker (`<<EOF`, `<<"EOF"`) is not a source path; the awk checks markers
	if (/^[0-9]*<<[^<]/.test(src)) return null
	if (src.includes('\\') || src.includes("'")) return 'quoted or escaped (write it plainly)'
	if (!json && src.includes('"')) return 'quoted or escaped (write it plainly)'
	const t = src.toLowerCase().replace(/["[\],]/g, '')
	if (t === '') return null
	if (t.includes('://')) return 'a URL'
	if (t.includes('$')) return 'built from a variable'
	if (t.startsWith('git@') || /^[^/]*@[^/]*:/.test(t)) return 'a git remote (user@host:path)'
	if (t.startsWith('github.com/') || /[.]git$/.test(t) || t.includes('#')) return 'a git remote'
	return null
}

/** awk (one image ref per line on stdin): prints why the ref is another app's
 *  image on this server, or nothing. The shell twin of dockerfileImageForeign
 *  (compose-safety.ts, the same rules as a service image); a test runs both on one
 *  table. Inputs (env): DFR_FOREIGN (canonical repos other projects built, their
 *  compose-default build names), DFR_OTHERS (other registered apps and previews),
 *  DFR_SELF (this app), all lowercase and space-separated. */
export const DFR_FOREIGN_AWK = String.raw`
BEGIN {
  nf = split(ENVIRON["DFR_FOREIGN"], F, " "); for (i = 1; i <= nf; i++) FX[F[i]] = 1
  no = split(ENVIRON["DFR_OTHERS"], O, " "); self = ENVIRON["DFR_SELF"]
  nl = split(ENVIRON["DFR_LOGIN"], L, " "); for (i = 1; i <= nl; i++) LG[L[i]] = 1
}
{
  r = tolower($0); gsub(/^[ \t]+|[ \t]+$/, "", r)
  if (r == "") next
  if (r ~ /^sha256:[0-9a-f]+$/ || (r ~ /^[0-9a-f]+$/ && length(r) >= 12 && length(r) <= 64)) { print "a local image ID"; exit }
  dig = (r ~ /@sha256:[0-9a-f]+$/)
  at = index(r, "@"); if (at) r = substr(r, 1, at - 1)
  np = split(r, P, "/"); st = 1
  if (np > 1 && (P[1] == "docker.io" || P[1] == "index.docker.io" || P[1] == "registry-1.docker.io")) st = 2
  if (np - st + 1 > 1 && P[st] == "library") st++
  repo = P[st]; for (i = st + 1; i <= np; i++) repo = repo "/" P[i]
  lastp = P[np]; c = index(lastp, ":")
  if (c) { lastp = substr(lastp, 1, c - 1); repo = substr(repo, 1, length(repo) - length(P[np])) lastp }
  # a registry root is logged in to (DFR_LOGIN): only the app's own repo.
  # before the local-image rules, so the every-mode refusal wins.
  if (st == 1 && np > 1 && (P[1] ~ /[.:]/ || P[1] == "localhost") && (P[1] in LG) && lastp != self) { print "an image on " P[1] ", where root is logged in, not named after this app"; exit }
  if (repo in FX) { print "an image another project built on this server"; exit }
  for (i = 1; i <= no; i++) if (O[i] != "" && O[i] != self && (O[i] == repo || O[i] == lastp)) { print "named after the app " O[i] " on this server"; exit }
  if (!dig) {
    best = ""; mine = 0
    if (self != "" && (repo == self || index(repo, self "-") == 1 || index(repo, self "_") == 1)) { best = self; mine = 1 }
    for (i = 1; i <= no; i++) { o = O[i]; if (o == "" || o == self) continue
      if ((repo == o || index(repo, o "-") == 1 || index(repo, o "_") == 1) && length(o) > length(best)) { best = o; mine = 0 } }
    if (best != "" && !mine) { print "named after the app " best " on this server"; exit }
  }
}
`

/** the env words the Dockerfile image check reads (DFR_FOREIGN, DFR_OTHERS,
 *  DFR_SELF), from the deploy's compose-guard context. Empty lists when the probe did
 *  not report them (then only the RepoDigest signal below remains). */
export function dockerfileAuthorityShell(a: { self: string; foreign: string[]; others: string[]; loginHosts?: string[]; owned?: string[] } | null | undefined): string {
	const clean = (xs: string[]) => xs.filter((x) => /^[a-z0-9._/:-]+$/.test(x)).join(' ')
	// DFR_OWNED, the repos the image ownership authority says this app owns
	// (image-ownership.ts). `*` (the server's build list alone decides, the older rule) only
	// when there is no ownership list: no authority at all (warn mode with an unreadable
	// compose probe: the deploy runs UNCHECKED and says so). Every deploy's authority comes
	// from checkComposeForDeploy, which always computes the list.
	const owned = a?.owned ? shq(clean(a.owned)) : `'*'`
	// the login hosts the deploy's probe read on the app's server, plus the ones root
	// is logged in to on THIS server (the builder may differ).
	return `DFR_FOREIGN=${shq(clean(a?.foreign ?? []))}; DFR_OTHERS=${shq(clean(a?.others ?? []))}; DFR_SELF=${shq(clean(a?.self ? [a.self] : []))}; DFR_OWNED=${owned}; DFR_LOGIN="${clean(a?.loginHosts ?? [])} $(${REGISTRY_LOGIN_HOSTS_SHELL})"; `
}

/** prints the registry hosts root's docker client is logged in to, space
 *  separated: the key names of root's docker config.json (always /root/.docker, never
 *  $DOCKER_CONFIG, which sshCommand points at the login-free dir; auths,
 *  credHelpers) that look like a registry host, lowercased, scheme and path dropped,
 *  Docker Hub left out. Only `"<key>":` tokens are matched and only host-shaped names
 *  ([a-z0-9.:-], with a dot, a colon or localhost) are printed, so a credential (a
 *  base64 value is never followed by a colon and has neither) never is. A missing or
 *  unreadable file prints `ghcr.io` (assume the common registry login, fail closed). */
export const REGISTRY_LOGIN_HOSTS_SHELL = String.raw`__dc=/root/.docker/config.json; if [ -f "$__dc" ] && [ -r "$__dc" ]; then { grep -oE '"[^"]+"[[:space:]]*:' "$__dc" 2>/dev/null || true; } | LC_ALL=C awk '{ h = tolower($0); sub(/^"/, "", h); sub(/"[ \t]*:$/, "", h); sub(/^[a-z]+:\/\//, "", h); sub(/\/.*$/, "", h); if (h ~ /^[a-z0-9.:-]+$/ && (h ~ /[.:]/ || h == "localhost") && h !~ /^(docker\.io|index\.docker\.io|registry-1\.docker\.io)(:|$)/ && !(h in seen)) { seen[h] = 1; printf "%s ", h } }'; else printf 'ghcr.io'; fi`

/** `dfr_src <Dockerfile> <context dir>`: non-zero (with a message) when the
 *  Dockerfile resolves (symlinks followed) outside the build context or is not a
 *  regular file. powder reads it as root, so this holds in every guard mode: reading
 *  a file outside the context is never legitimate. A missing file passes (the build
 *  itself fails on it). */
export const DFR_SRC_FN =
	'dfr_src() { if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi; ' +
	'if [ ! -f "$1" ]; then echo "[build-cache] refusing $1: the Dockerfile is not a regular file"; return 1; fi; ' +
	'__fr=$(readlink -f -- "$1" 2>/dev/null) && __cr=$(readlink -f -- "$2" 2>/dev/null) && [ -n "$__fr" ] && [ -n "$__cr" ] || { echo "[build-cache] refusing $1: cannot resolve the Dockerfile or the build context $2"; return 1; }; ' +
	'case "$__fr" in "$__cr"/*) return 0;; esac; ' +
	'echo "[build-cache] refusing $1: the Dockerfile resolves to $__fr, outside the build context $__cr"; return 1; }; '

/** `dfr_copy <Dockerfile> <context dir> <copy>`: dfr_src, then copy the file it
 *  resolved to into <copy> (a new path in powder's temp dir) without following a link
 *  (cp -R -P from inside its folder, entered with cd -P and checked to be the folder
 *  dfr_src resolved), and refuse when the copy is not a regular file. Callers read only
 *  the copy, so a Dockerfile swapped for a link after the check is never read. A tracked
 *  in-context link (`Dockerfile -> docker/Dockerfile`) is copied from its target. */
export const DFR_COPY_FN =
	'dfr_copy() { __fr=""; dfr_src "$1" "$2" || return 1; if [ -z "$__fr" ]; then echo "[build-cache] no Dockerfile at $1"; return 1; fi; ' +
	'__fd=$(dirname -- "$__fr"); ' +
	'( cd -P -- "$__fd" 2>/dev/null && [ "$(pwd -P)" = "$__fd" ] && cp -R -P -- "./${__fr##*/}" "$3" ) || { echo "[build-cache] refusing $1: the Dockerfile changed while it was read"; return 1; }; ' +
	'if [ -L "$3" ] || [ ! -f "$3" ]; then echo "[build-cache] refusing $1: the Dockerfile is not a regular file"; return 1; fi; }; '

/** where the image provenance record lives on a build host: one image ID per line,
 *  each the ID of an image powder itself pulled anonymously (dfr_prov). Root only
 *  (0700 dir); no app can bind it (compose bind rule: /var/lib is never exemptable). */
export const IMAGE_PULL_RECORD = '/var/lib/powder/image-pulls'

/** `dfr_prov <ref> [1]`: the local copy of an image a build reads that is not this
 *  app's own (dfr_own) must be one powder pulled from its registry. A RepoDigest is never
 *  proof of a pull: on docker 29 with the containerd store a local build carries one too,
 *  so another app could build (or tag) `alpine/git:latest` and every later build reading
 *  that base would get its content pinned to the hostile digest. So: a digest ref
 *  (`@sha256:`) names content (pulled only when it is missing); a tag passes when its local
 *  image ID is in IMAGE_PULL_RECORD and the image has no `com.docker.compose.project`
 *  label; anything else (a local build, a tag another app wrote, an image never checked,
 *  or a second argument 1: --pull is on) is pulled anonymously (every remote command
 *  runs under NOCREDS_PREFIX), which writes the registry's content back over the tag, and
 *  the pulled ID is recorded. Non-zero with `$__pvwhy` set when the pull fails or the
 *  pulled image carries a compose project label. When bases are public registry images,
 *  the first deploy with this check pulls each base once per server. */
export const DFR_PROV_FN =
	[
		`dfr_prov() { __pvwhy=""; __pvf="\${DFR_PROV_FILE:-${IMAGE_PULL_RECORD}}"; __pvt=""; if command -v timeout >/dev/null 2>&1; then __pvt="timeout 300"; fi; `,
		'case "$1" in *@sha256:*) if [ "${2:-0}" = 1 ] || ! docker image inspect -- "$1" >/dev/null 2>&1 </dev/null; then $__pvt docker pull -q -- "$1" >/dev/null 2>&1 </dev/null || { __pvwhy="cannot pull $1 anonymously"; return 1; }; fi; return 0;; esac; ',
		'__pvl() { docker image inspect --format \'{{json .Config}}\' -- "$1" 2>/dev/null </dev/null | grep -c \'[{,]"com\\.docker\\.compose\\.project":\' || true; }; ',
		'__pvid=""; if [ "${2:-0}" != 1 ]; then __pvid=$(docker image inspect --format \'{{.Id}}\' -- "$1" 2>/dev/null </dev/null) || __pvid=""; fi; ',
		'if [ -n "$__pvid" ] && [ "$(__pvl "$1")" = 0 ] && [ -f "$__pvf" ] && grep -qxF -- "$__pvid" "$__pvf" 2>/dev/null; then return 0; fi; ',
		'__pvo=$($__pvt docker pull -- "$1" 2>/dev/null </dev/null) || { if [ -n "$__pvid" ]; then __pvwhy="a local build may shadow the image $1: its local copy is not one powder pulled from its registry, and the anonymous pull to replace it failed"; else __pvwhy="cannot pull $1 anonymously"; fi; return 1; }; ',
		// the ID recorded is the one of the digest the pull reported (repo@digest),
		// never the tag read back after the pull (another app can retag it in between). A
		// pull output without a Digest line falls back to the tag (older docker output).
		'__pvd=$(printf \'%s\\n\' "$__pvo" | sed -n \'s/^Digest: \\(sha256:[0-9a-f]\\{64\\}\\)$/\\1/p\' | tail -n 1); __pvref="$1"; ',
		'case "$__pvd" in sha256:*) __pvr="$1"; case "${__pvr##*/}" in *:*) __pvr="${__pvr%:*}";; esac; __pvref="$__pvr@$__pvd";; esac; ',
		'__pvid=$(docker image inspect --format \'{{.Id}}\' -- "$__pvref" 2>/dev/null </dev/null) || __pvid=""; ',
		'case "$__pvid" in sha256:*) ;; *) __pvwhy="cannot inspect $1 after pulling it"; return 1;; esac; ',
		'if [ "$(__pvl "$__pvref")" != 0 ]; then __pvwhy="a local build shadows the image $1: it carries a com.docker.compose.project label"; return 1; fi; ',
		'case "$__pvid" in *[!A-Za-z0-9:]*) __pvwhy="unexpected image ID for $1"; return 1;; esac; ',
		'{ [ -d "${__pvf%/*}" ] || mkdir -p -m 700 "${__pvf%/*}"; } 2>/dev/null; if [ ! -L "$__pvf" ]; then grep -qxF -- "$__pvid" "$__pvf" 2>/dev/null || printf \'%s\\n\' "$__pvid" >> "$__pvf" 2>/dev/null || true; fi; return 0; }; ',
	].join('')

/** a base image's ONBUILD triggers run in the child build before
 *  anything powder inserts, unchecked: a trigger can `COPY --from=<another app's local
 *  image>` and its RUN cache mounts skip the per-app namespace. The Dockerfile rewrite
 *  writes every FROM that reads an image (not a stage, not scratch) back as one line that
 *  reads the token `__POWDER_BASE_<k>__` and reports `BASE <k> <ref>` (the ref as BuildKit
 *  resolves it at that line); dfr_one lists them in `$DFR_DIR/bases` with the rewritten
 *  file. dfr_bases then takes each base that is not this app's own build (dfr_own): it
 *  pulls it first when --pull is on (DFR_PULL=1) or it is not on this server (anonymously:
 *  every remote command runs under NOCREDS_PREFIX, lib/docker-env.ts), else reads the
 *  local image; refuses it when `docker image inspect` shows `.Config.OnBuild` or cannot
 *  inspect it; and replaces the token with the image pinned to the digest it inspected
 *  (the RepoDigests entry of that repo; a ref with `@sha256:` stays as written), so the
 *  build reads exactly the checked image, with or without --pull. A base with no registry
 *  digest is refused; the app's own images are written back unpinned. Refused in EVERY
 *  guard mode; non-zero on a refusal; a token left in a file is a refusal. FROM
 *  --platform= other than the build's own platform variables, compose `platform`,
 *  `build.platforms` and `build.pull` are refused elsewhere (each would read another
 *  image than the inspected one). */
export const DFR_BASES_FN =
	"dfr_canon() { __c=\"$1\"; __c=\"${__c%%@*}\"; case \"${__c##*/}\" in *:*) __c=\"${__c%:*}\";; esac; case \"$__c\" in docker.io/*) __c=\"${__c#docker.io/}\";; index.docker.io/*) __c=\"${__c#index.docker.io/}\";; registry-1.docker.io/*) __c=\"${__c#registry-1.docker.io/}\";; esac; case \"$__c\" in library/*) __c=\"${__c#library/}\";; esac; printf '%s' \"$__c\" | tr 'A-Z' 'a-z'; }; dfr_bases() { if [ ! -s \"$DFR_DIR/bases\" ]; then rm -f \"$DFR_DIR/bases\"; return 0; fi; __bb=0; __tab=$(printf '\\t'); : > \"$DFR_DIR/bases.pin\" || { echo \"[build-cache] cannot write the base image pins\"; return 1; }; while IFS=\"$__tab\" read -r __f __kr; do [ -n \"$__f\" ] || continue; __k=\"${__kr%% *}\"; __i=\"${__kr#* }\"; case \"$__k\" in ''|*[!0-9]*) echo \"[build-cache] refusing: unreadable base image list line\"; __bb=1; continue;; esac; __p=$(awk -F\"$__tab\" -v r=\"$__i\" '$1 == r { print $2; exit }' \"$DFR_DIR/bases.pin\"); if [ -z \"$__p\" ]; then if dfr_own \"$__i\"; then __p=\"$__i\"; else if ! dfr_prov \"$__i\" \"${DFR_PULL:-0}\"; then echo \"[build-cache] refusing: the base image $__i: $__pvwhy (refused in every guard mode)\"; __bb=1; continue; fi; __ob=$(docker image inspect --format '{{if .Config}}{{len .Config.OnBuild}}{{else}}0{{end}}' -- \"$__i\" 2>/dev/null </dev/null) || __ob=x; case \"$__ob\" in 0) ;; [1-9]|[1-9][0-9]|[1-9][0-9][0-9]) echo \"[build-cache] refusing: the base image $__i has $__ob ONBUILD trigger(s); they would run in this build unchecked (they can read another app's local image, and their cache mounts skip this app's namespace). Use a base image without ONBUILD (refused in every guard mode)\"; __bb=1; continue;; *) echo \"[build-cache] refusing: cannot inspect the base image $__i for ONBUILD triggers (refused in every guard mode)\"; __bb=1; continue;; esac; case \"$__i\" in *@sha256:*) __p=\"$__i\";; *) __rc=$(dfr_canon \"$__i\"); for __d in $(docker image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' -- \"$__i\" 2>/dev/null </dev/null); do if [ \"$(dfr_canon \"$__d\")\" = \"$__rc\" ]; then __p=\"$__d\"; break; fi; done;; esac; if [ -z \"$__p\" ]; then echo \"[build-cache] refusing: the base image $__i has no registry digest on this server, so the build cannot be pinned to the image powder checked (a local build of another project?). Use a registry image (refused in every guard mode)\"; __bb=1; continue; fi; fi; case \"$__p\" in *[!A-Za-z0-9._/:@-]*) echo \"[build-cache] refusing: unexpected characters in the base image pin of $__i\"; __bb=1; continue;; esac; printf '%s\\t%s\\n' \"$__i\" \"$__p\" >> \"$DFR_DIR/bases.pin\"; fi; awk -v t=\"__POWDER_BASE_${__k}__\" -v p=\"$__p\" '{ i = index($0, t); if (i) $0 = substr($0, 1, i - 1) p substr($0, i + length(t)); print }' \"$__f\" > \"$__f.pin\" && mv -f \"$__f.pin\" \"$__f\" || { echo \"[build-cache] refusing: cannot write the base image pin into $__f\"; __bb=1; continue; }; [ \"$__p\" = \"$__i\" ] || echo \"[build-cache] base image $__i pinned to $__p (checked: no ONBUILD triggers)\"; done < \"$DFR_DIR/bases\"; if [ \"$__bb\" = 0 ]; then while IFS=\"$__tab\" read -r __f __kr; do if [ -n \"$__f\" ] && grep -q '__POWDER_BASE_' \"$__f\" 2>/dev/null; then echo \"[build-cache] refusing: a base image of $__f was not pinned\"; __bb=1; fi; done < \"$DFR_DIR/bases\"; fi; rm -f \"$DFR_DIR/bases\" \"$DFR_DIR/bases.pin\"; [ \"$__bb\" = 0 ]; }; "

/** the build reads exactly the paths the guard checked. The compose bind guard
 *  checks every build context and additional context (`C` lines, resolved with
 *  `readlink -f`: no link it does not allow on the way, no writable bind at or above
 *  it), but compose would resolve the paths again when it builds, later.
 *    dfr_pin <svc> <context> <ac file> <acy file>   for the Dockerfile check: resolves
 *      the context and every absolute additional context (`name=path` lines of the ac
 *      file) with `readlink -f`, records `<path>\t<resolved>` in $DFR_DIR/pins, sets
 *      $__pc (the resolved context, '' when the context is no host path) and writes the
 *      resolved additional contexts as override lines into the acy file. Refuses a path
 *      that does not resolve or resolves to a character outside [A-Za-z0-9._/-] (it is
 *      written into a YAML override), and an additional context name outside
 *      [A-Za-z0-9._-].
 *    dfr_pinchk   before each `compose build` (and in el_guard): every pinned path must
 *      still resolve to its pin, and the pin to itself; non-zero (with a message) when
 *      one changed. No pins yet (before the Dockerfile check) passes.
 *    dfr_pinned <path>   prints the pin of <path>, else <path>. */
export const DFR_PIN_FN =
	"dfr_pinok() { case \"$1\" in /*) ;; *) return 1;; esac; case \"$1\" in *[!A-Za-z0-9._/-]*) return 1;; esac; return 0; }; " +
	"dfr_pin() { __pc=''; : > \"$4\" || return 1; " +
	"case \"$2\" in /*) __pc=$(readlink -f -- \"$2\" 2>/dev/null || true); if [ -z \"$__pc\" ] || ! dfr_pinok \"$__pc\"; then echo \"[build-cache] refusing: service $1: the build context $2 resolves to '$__pc', which powder cannot pin for the build (it does not resolve, or holds a character outside [A-Za-z0-9._/-])\"; return 1; fi; printf '%s\\t%s\\n' \"$2\" \"$__pc\" >> \"$DFR_DIR/pins\" || return 1;; esac; " +
	"if [ -s \"$3\" ]; then while IFS= read -r __al || [ -n \"$__al\" ]; do __an=\"${__al%%=*}\"; __av=\"${__al#*=}\"; case \"$__av\" in /*) ;; *) continue;; esac; " +
	"case \"$__an\" in ''|*[!A-Za-z0-9._-]*) echo \"[build-cache] refusing: service $1: the additional context name '$__an' holds a character outside [A-Za-z0-9._-]\"; return 1;; esac; " +
	"__ar=$(readlink -f -- \"$__av\" 2>/dev/null || true); if [ -z \"$__ar\" ] || ! dfr_pinok \"$__ar\"; then echo \"[build-cache] refusing: service $1: the additional context $__an ($__av) resolves to '$__ar', which powder cannot pin for the build (it does not resolve, or holds a character outside [A-Za-z0-9._/-])\"; return 1; fi; " +
	"printf '%s\\t%s\\n' \"$__av\" \"$__ar\" >> \"$DFR_DIR/pins\" && printf '        %s: %s\\n' \"$__an\" \"$__ar\" >> \"$4\" || return 1; done < \"$3\"; fi; return 0; }; " +
	"dfr_pinchk() { [ -n \"${DFR_DIR:-}\" ] || return 0; if [ ! -f \"$DFR_DIR/pins\" ]; then [ -z \"${DFR_F:-}\" ] && return 0; echo \"[build-cache] refusing: the build path pins ($DFR_DIR/pins) are gone, so the build cannot be checked against them\"; return 1; fi; " +
	"__pb=0; __ptab=$(printf '\\t'); while IFS=\"$__ptab\" read -r __po __pr; do [ -n \"$__po\" ] || continue; __pn=$(readlink -f -- \"$__po\" 2>/dev/null || true); __pq=$(readlink -f -- \"$__pr\" 2>/dev/null || true); " +
	"if [ \"$__pn\" != \"$__pr\" ] || [ \"$__pq\" != \"$__pr\" ]; then echo \"[build-cache] refusing: the build path $__po resolved to $__pr when powder checked it and resolves to '$__pn' now (a link on the way changed, or a container swapped a folder); the old container keeps serving\"; __pb=1; fi; done < \"$DFR_DIR/pins\"; [ \"$__pb\" = 0 ]; }; " +
	"dfr_pinned() { __pv=''; if [ -n \"${DFR_DIR:-}\" ] && [ -f \"$DFR_DIR/pins\" ]; then __pv=$(awk -F'\\t' -v o=\"$1\" '$1 == o { print $2; exit }' \"$DFR_DIR/pins\"); fi; printf '%s' \"${__pv:-$1}\"; }; "

/** Shell functions for the build hosts (target deploy script and builder script).
 *  Needs DFR_NS, DFR_APP, DFR_DIR (a fresh dir outside every build context; with
 *  DFR_FINAL set, the override names DFR_FINAL paths and the set is moved there),
 *  DFR_MODE (enforce|warn), DFR_PULL (1 = builds run with --pull), DFR_OWN
 *  (space-separated image repos this app builds). Defines:
 *    dfr_one <src Dockerfile> <dst> [label] [args file]   rewrite + checks; non-zero =
 *      refuse. The args file (KEY=VALUE lines) holds the build args the build passes:
 *      they override ARG defaults in the image refs. With a registry login
 *      known (DFR_LOGIN), an image ref whose variable resolves to nothing (UNRESOLVED)
 *      and a ref the login owner rule flags are refused in EVERY guard mode; the other
 *      dockerfile_image findings stay enforce-refuse / warn-WARN.
 *    dfr_src <src Dockerfile> <ctx>   containment check (DFR_SRC_FN)
 *    dfr_bases after the dfr_one calls: no FROM image with ONBUILD triggers
 *      (DFR_BASES_FN); non-zero = refuse, in every guard mode
 *    dfr_pin / dfr_pinchk / dfr_pinned   build path pins (DFR_PIN_FN)
 *  Messages: `[build-cache] ...`; warn-mode findings as compose-guard WARN lines.
 *  dfr_own splits $DFR_OWN on whitespace with globbing off (set -f, restored
 *  after), so an image name with `*` or `?` cannot expand against the cwd. */
export function dockerfileRewriteFunctions(app: string): string {
	const warn = (code: string, detail: string) =>
		`echo "[compose-guard] WARN ${app.replace(/[^A-Za-z0-9._-]/g, '_')} ${code} ${detail}"`
	return `DFR_AWK=${shq(DOCKERFILE_REWRITE_AWK)}; DFR_FOREIGN_AWK=${shq(DFR_FOREIGN_AWK)}; ${DFR_SRC_FN}${DFR_COPY_FN}${DFR_PROV_FN}${DFR_BASES_FN}${DFR_PIN_FN}dfr_own() { __r="$1"; __r="\${__r%%@*}"; case "\${__r##*/}" in *:*) __r="\${__r%:*}";; esac; __hit=1; case $- in *f*) __nf="";; *) __nf=1; set -f;; esac; for __o in $DFR_OWN; do __o="\${__o%%@*}"; case "\${__o##*/}" in *:*) __o="\${__o%:*}";; esac; if [ "$__r" = "$__o" ]; then __hit=0; break; fi; done; if [ "$__hit" = 0 ] && [ "\${DFR_OWNED-}" != '*' ]; then __hit=1; __rc=$(dfr_canon "$1"); for __o in \${DFR_OWNED-}; do if [ "$__rc" = "$__o" ]; then __hit=0; break; fi; done; fi; if [ -n "$__nf" ]; then set +f; fi; return "$__hit"; }; dfr_one() { __lb="\${3:-$1}"; if [ ! -f "$1" ]; then echo "[build-cache] no Dockerfile at $__lb"; return 1; fi; if [ "$(tr -d '\\000' < "$1" | wc -c)" -ne "$(wc -c < "$1")" ]; then echo "[build-cache] refusing $__lb: a Dockerfile with control characters other than tab is not supported"; return 1; fi; __tf=$(mktemp "$DFR_DIR/h.XXXXXX") && __rp=$(mktemp "$DFR_DIR/r.XXXXXX") || { echo "[build-cache] cannot create temp files"; return 1; }; DFR_NS="$DFR_NS" DFR_APP="$DFR_APP" DFR_TF="$__tf" DFR_RP="$__rp" DFR_ARGF="\${4:-}" DFR_SYNTAX=${shq(SYNTAX_ALLOWED_ERE)} LC_ALL=C awk "$DFR_AWK" "$1" > "$2" || { echo "[build-cache] could not rewrite $__lb"; rm -f "$__tf" "$__rp"; return 1; }; rm -f "$__tf"; __bad=0; while IFS= read -r __l; do case "$__l" in "REFUSE "*) echo "[build-cache] refusing $__lb: \${__l#REFUSE }"; __bad=1;; "REWROTE "*) echo "[build-cache] \${__l#REWROTE } cache mount(s) in $__lb isolated to this app";; "BASE "*) printf '%s\\t%s\\n' "$2" "\${__l#BASE }" >> "$DFR_DIR/bases";; "UNRESOLVED "*) __lg="\${DFR_LOGIN:-}"; __lg="\${__lg// /}"; if [ -n "$__lg" ]; then echo "[build-cache] refusing $__lb: image ref \${__l#UNRESOLVED } uses a variable with no ARG default or build arg; with a registry login on this server powder cannot tell whether it names a private image root's login would pull (refused in every guard mode)"; __bad=1; elif [ "$DFR_PULL" != 1 ]; then if [ "$DFR_MODE" = enforce ]; then echo "[build-cache] refusing $__lb: image ref \${__l#UNRESOLVED } uses a variable with no ARG default or build arg; powder cannot tell whether it names another app's local image or a private image root's registry login would pull"; __bad=1; else ${warn('dockerfile_image', '$__lb: unresolved image ref ${__l#UNRESOLVED }')}; fi; fi;; "IMG "*) __i="\${__l#IMG }"; __why=""; if dfr_own "$__i"; then __why=$(printf '%s\\n' "$__i" | DFR_FOREIGN='' DFR_OTHERS='' DFR_SELF="\${DFR_SELF:-}" DFR_LOGIN="\${DFR_LOGIN:-}" LC_ALL=C awk "$DFR_FOREIGN_AWK" 2>/dev/null); case "$__why" in "an image on "*", where root is logged in"*) ;; *) __why="";; esac; else __why=$(printf '%s\\n' "$__i" | DFR_FOREIGN="\${DFR_FOREIGN:-}" DFR_OTHERS="\${DFR_OTHERS:-}" DFR_SELF="\${DFR_SELF:-}" DFR_LOGIN="\${DFR_LOGIN:-}" LC_ALL=C awk "$DFR_FOREIGN_AWK" 2>/dev/null); if [ -z "$__why" ] && __n=$(docker image inspect --format '{{len .RepoDigests}}' -- "$__i" 2>/dev/null) && [ "$__n" = 0 ]; then __why="a local image built on this server (no registry digest)"; fi; if [ -z "$__why" ] && [ "$DFR_PULL" != 1 ] && ! dfr_prov "$__i"; then __why="$__pvwhy"; fi; fi; if [ -n "$__why" ]; then case "$__why" in "an image on "*", where root is logged in"*) echo "[build-cache] refusing $__lb: it reads $__i ($__why); root's registry login would pull another project's private image (refused in every guard mode). Use this app's own repo or a public image"; __bad=1; continue;; esac; if [ "$DFR_MODE" = enforce ]; then echo "[build-cache] refusing $__lb: it reads the local image $__i ($__why), which is not this app's (another app's code and build secrets). Use a public registry image or this app's own"; __bad=1; else ${warn('dockerfile_image', '$__lb reads the local image $__i ($__why), not this app')}; fi; fi;; esac; done < "$__rp"; rm -f "$__rp"; [ "$__bad" = 0 ]; }; `
}

/** Shell (deploy script, target server): rewrite the Dockerfile of every compose service
 *  that builds, into $DFR_DIR, and write the override `$DFR_DIR/override.yml` that
 *  points each service's build.dockerfile at its rewritten copy. Sets DFR_F
 *  ("-f <override>") for every compose command that may build. `cf` is the compose
 *  file args. A `<Dockerfile>.dockerignore` is copied next to the copy with powder's
 *  protected entries last. Exits the script on refusal.
 *  the override also pins each service's build.context and every absolute
 *  additional_contexts value to its `readlink -f` result (dfr_pin, recorded in
 *  $DFR_DIR/pins; dfr_pinchk re-verifies them before each build). A build
 *  service whose Dockerfile is missing or not a regular file refuses the deploy (left
 *  in the list without an override, it would be built later from the original,
 *  unchecked file). */
export function composeDockerfileRewriteShell(
	cf: string,
	protectIgnore: (file: string) => string,
): string {
	// One line per service with a build section: svc|context|dockerfile|image or -|inline (0/1).
	// A value with a | in it is refused (the shell splits on it).
	const listAwk = String.raw`
function unq(v) { sub(/^[ \t]+/, "", v); sub(/[ \t\r]+$/, "", v); if (v ~ /^".*"$/ || v ~ /^'.*'$/) v = substr(v, 2, length(v) - 2); return v }
function flush() { if (cur != "" && hasb) { print cur "|" ctx "|" (df == "" ? "Dockerfile" : df) "|" (img == "" ? "-" : img) "|" inl; if (inl) close(INL "/" n ".inline") } }
/^services:/ { s = 1; next }
/^[^ ]/ { flush(); s = 0; cur = ""; next }
s && /^  [^ ]/ { flush(); cur = $1; sub(/:$/, "", cur); cur = unq(cur); b = 0; ctx = ""; df = ""; img = ""; inl = 0; hasb = 0; ib = 0; ia = 0; iac = 0; next }
s && cur != "" && /^    [^ ]/ { ib = 0; ia = 0; iac = 0; b = ($1 == "build:"); if (b) { hasb = 1; n++; printf "" > (INL "/" n ".args"); printf "" > (INL "/" n ".ac") } if ($1 == "image:") img = unq(substr($0, index($0, ":") + 1)); next }
s && b && /^      [^ ]/ { ib = 0; ia = 0; iac = 0 }
s && b && /^      args:/ { ia = 1; next }
s && b && /^      additional_contexts:/ { iac = 1; next }
s && b && iac && /^        [^ ]/ { k = substr($0, 9); k = substr(k, 1, index(k, ":") - 1); k = unq(k); v = unq(substr($0, index($0, ":") + 1)); print k "=" v > (INL "/" n ".ac"); next }
s && b && ia && /^        [^ ]/ { k = substr($0, 9); k = substr(k, 1, index(k, ":") - 1); k = unq(k); v = substr($0, index($0, ":") + 1); raw = v; gsub(/^[ \t]+|[ \t\r]+$/, "", raw); v = unq(v); if (k ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && raw != "null" && raw != "~") print k "=" v > (INL "/" n ".args"); next }
s && b && /^      context:/ { ctx = unq(substr($0, index($0, ":") + 1)) }
s && b && /^      dockerfile:/ { df = unq(substr($0, index($0, ":") + 1)) }
s && b && /^      dockerfile_inline:/ { inl = 1; ib = 1; v = unq(substr($0, index($0, ":") + 1)); printf "" > (INL "/" n ".inline"); if (v !~ /^[|>][-+]?$/) { print v > (INL "/" n ".inline"); ib = 0 } next }
s && b && ib && /^        / { print substr($0, 9) > (INL "/" n ".inline"); next }
s && b && ib && /^[ \t]*$/ { print "" > (INL "/" n ".inline"); next }
END { flush() }
`
	return `DFR_CFG=$(docker compose ${cf} ${ALL_PROFILES} config 2>/dev/null) && DFR_LIST=$(printf '%s\n' "$DFR_CFG" | awk -v INL="$DFR_DIR" ${shq(listAwk)}) || { echo "preflight: cannot read the compose build sections for the Dockerfile check"; exit 1; }; printf '%s\\n' "$DFR_LIST" > "$DFR_DIR/list"; : > "$DFR_DIR/pins" || { echo "preflight: cannot write $DFR_DIR/pins"; exit 1; }; DFR_OWN="$DFR_OWN $(awk -F'|' -v p="\${CP_PROJ:-}" 'NF{ if ($4 != "-") print $4; if (p != "") print p "-" $1 }' "$DFR_DIR/list" | tr '\\n' ' ')"; printf 'services:\\n' > "$DFR_DIR/override.yml"; DFR_N=0; DFR_BAD=0; while IFS='|' read -r __s __c __d __i __in __x; do [ -n "$__s" ] || continue; DFR_N=$((DFR_N+1)); if [ -n "$__x" ]; then echo "[build-cache] refusing: a build path of service $__s contains a |"; DFR_BAD=1; continue; fi; case "$__s" in *[!A-Za-z0-9._-]*) echo "[build-cache] refusing: service name $__s"; DFR_BAD=1; continue;; esac; if [ "$__in" = 1 ]; then __src="$DFR_DIR/$DFR_N.inline"; else case "$__d" in /*) __src="$__d";; *) __src="$__c/$__d";; esac; fi; __dst="$DFR_DIR/$DFR_N.Dockerfile"; if [ "$__in" != 1 ]; then dfr_src "$__src" "$__c" || { DFR_BAD=1; continue; }; fi; if [ ! -f "$__src" ]; then echo "[build-cache] refusing: service $__s has no Dockerfile at $__src (missing or not a regular file), so powder cannot check what a build of it would read; add the Dockerfile or remove the build section of $__s"; DFR_BAD=1; continue; fi; __rd="$__src"; if [ "$__in" != 1 ]; then __rd="$DFR_DIR/$DFR_N.src"; dfr_copy "$__src" "$__c" "$__rd" || { DFR_BAD=1; continue; }; fi; dfr_one "$__rd" "$__dst" "$__src" "$DFR_DIR/$DFR_N.args" || { rm -f "$DFR_DIR/$DFR_N.args"; DFR_BAD=1; continue; }; rm -f "$DFR_DIR/$DFR_N.args"; if [ "$__in" != 1 ]; then rm -f "$__rd"; fi; if [ "$__in" != 1 ] && { [ -e "$__src.dockerignore" ] || [ -L "$__src.dockerignore" ]; }; then cp -R -P -- "$__src.dockerignore" "$__dst.dockerignore" || { DFR_BAD=1; continue; }; if [ -L "$__dst.dockerignore" ]; then echo "[build-cache] refusing: $__src.dockerignore is a symlink"; DFR_BAD=1; continue; fi; if [ ! -f "$__dst.dockerignore" ]; then echo "[build-cache] refusing: $__src.dockerignore is not a regular file"; DFR_BAD=1; continue; fi; ( ${protectIgnore('$__dst.dockerignore').replace(/'\$__dst\.dockerignore'/g, '"$__dst.dockerignore"')} ) || { DFR_BAD=1; continue; }; fi; dfr_pin "$__s" "$__c" "$DFR_DIR/$DFR_N.ac" "$DFR_DIR/$DFR_N.acy" || { DFR_BAD=1; continue; }; printf '  %s:\\n    build:\\n      dockerfile: %s\\n' "$__s" "\${DFR_FINAL:-$DFR_DIR}/$DFR_N.Dockerfile" >> "$DFR_DIR/override.yml"; if [ -n "$__pc" ]; then printf '      context: %s\\n' "$__pc" >> "$DFR_DIR/override.yml"; fi; if [ -s "$DFR_DIR/$DFR_N.acy" ]; then printf '      additional_contexts:\\n' >> "$DFR_DIR/override.yml"; cat "$DFR_DIR/$DFR_N.acy" >> "$DFR_DIR/override.yml"; fi; if [ "$__in" = 1 ]; then printf '      dockerfile_inline: !reset null\\n' >> "$DFR_DIR/override.yml"; fi; done < "$DFR_DIR/list"; rm -f "$DFR_DIR"/*.args "$DFR_DIR"/*.ac "$DFR_DIR"/*.acy; if [ "$DFR_BAD" = 0 ] && ! dfr_bases; then DFR_BAD=1; fi; rm -f "$DFR_DIR/bases"; if [ "$DFR_BAD" != 0 ]; then echo "preflight: build refused by the Dockerfile check (see [build-cache] lines above); the old container keeps serving"; exit 1; fi; printf 'services: {}\\n' > "$DFR_DIR/labels.yml" || { echo "preflight: cannot write $DFR_DIR/labels.yml"; exit 1; }; if [ -n "\${DFR_FINAL:-}" ]; then { rm -rf "$DFR_FINAL.old" && { [ ! -e "$DFR_FINAL" ] || mv "$DFR_FINAL" "$DFR_FINAL.old"; } && mv "$DFR_DIR" "$DFR_FINAL" && rm -rf "$DFR_FINAL.old"; } || { echo "preflight: cannot install the build override set at $DFR_FINAL"; exit 1; }; DFR_DIR="$DFR_FINAL"; fi; if [ "$DFR_N" -gt 0 ]; then DFR_F="-f $DFR_DIR/override.yml"; fi; `
}
