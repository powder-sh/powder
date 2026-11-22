import type { ServerConfig } from '../servers'
import { SAFE_NAME, assertSafeName, shq } from '../shell'
import { DockerCommandError } from '../container-state'
import { runCommand } from './connection'
import { isPowderTempComposeFile } from '../compose-override'
import { OUTPUT_TRUNCATED_MARKER } from '../capped-output'

export interface ContainerInfo {
	name: string
	image: string
	status: string
	state: string
	ports: string
	createdAt: string
}

// Parse nginx vhosts to map upstream → public URLs.
// Two sources:
//   1. host nginx (`/etc/nginx/sites-enabled/*`) → upstreams typically on 127.0.0.1:port
//   2. containerized nginx (`docker exec <nginx> nginx -T`) → upstreams typically by compose service DNS name
// A `proxy_pass` to a named `upstream { }` group (the zero-downtime bridge layout)
// resolves to that group's primary servers (parseNginxRoutes).
export interface NginxRoute {
	host: string | null // upstream hostname (e.g. "127.0.0.1", "myapp")
	port: number | null // upstream port if specified
	urls: string[]
}

export async function getNginxRoutes(
	server: ServerConfig,
	/** container names of the powder apps on this server (app_repos, and their
	 *  preview containers, preview_deploys). `nginx -T` never runs in one of them, nor in
	 *  any container of their compose projects: an app container named like nginx or
	 *  proxy could print any `server_name` it likes (and `docker exec` runs the app's
	 *  binary). Required, so no caller forgets it. Nor in any container whose
	 *  compose working dir is under /opt/apps (or its resolved path): that is app space. */
	managedNames: string[],
): Promise<NginxRoutes> {
	// Defense-in-depth: even though docker container names follow a tight regex,
	// belt-and-braces sanitize the loop variable with a post-`head` regex filter
	// so `$c` can never expand to anything that would let a hostile container
	// name inject shell. `head -10` first to cap the iteration count, then the
	// regex filter so we never accept a name with anything but [A-Za-z0-9._-].
	const managed = managedNames.filter((n) => SAFE_NAME.test(n))
	const cmd =
		`{ OPTR=$(readlink -f /opt/apps 2>/dev/null || true); OPTR=\${OPTR:-/opt/apps}; ` +
		`inapp() { case "$1" in (/opt/apps|/opt/apps/*|"$OPTR"|"$OPTR"/*) return 0;; esac; return 1; }; ` +
		// HOST NGINX, read only while a host nginx master runs (the config of a stopped
		// nginx is not routing anything). Running = the pid file (named by the config's
		// `pid`, else /run/nginx.pid) holds the pid of a live process in the HOST pid
		// namespace (its /proc/<pid>/ns/pid equals pid 1's; an unreadable ns counts as
		// not running) whose name is nginx, openresty or angie. Not pgrep: the host sees
		// every container's nginx too, and a stale pid file can name a reused pid of a
		// container's nginx; the namespace check rules that out. Not systemctl: it needs
		// systemd and misses an nginx started another way. With a running `nginx` master
		// and the `nginx` binary, `nginx -T` is read; for an openresty/angie master, no
		// nginx binary on PATH, or a failing -T, the sites-enabled and conf.d files.
		`HS=none; HN=''; NT=''; if command -v timeout >/dev/null 2>&1; then NT='timeout 6'; fi; ` +
		`HAVE=''; if command -v nginx >/dev/null 2>&1; then HAVE=y; HN=$($NT nginx -T 2>/dev/null) || HN=''; fi; ` +
		`PF=$(printf '%s\n' "$HN" | sed -n 's/^[[:space:]]*pid[[:space:]][[:space:]]*\\([^;[:space:]]*\\);.*/\\1/p' | head -1); ` +
		`if [ -z "$PF" ]; then for p in /run/nginx.pid /var/run/nginx.pid /run/openresty.pid /usr/local/openresty/nginx/logs/nginx.pid /run/angie.pid /var/run/angie.pid; do if [ -f "$p" ]; then PF=$p; break; fi; done; fi; ` +
		`MP=''; if [ -n "$PF" ]; then MP=$(head -c 16 "$PF" 2>/dev/null | tr -cd 0-9); fi; ` +
		`N1=$(readlink /proc/1/ns/pid 2>/dev/null || true); NP=''; MC=''; ` +
		`if [ -n "$MP" ]; then NP=$(readlink /proc/$MP/ns/pid 2>/dev/null || true); MC=$(cat /proc/$MP/comm 2>/dev/null || true); fi; ` +
		`if [ -n "$MP" ] && [ -n "$N1" ] && [ "$NP" = "$N1" ] && { [ "$MC" = nginx ] || [ "$MC" = openresty ] || [ "$MC" = angie ]; }; then ` +
		`  HS=read; if [ "$MC" != nginx ] || [ -z "$HAVE" ]; then HN=''; fi; ` +
		`elif [ -n "$HAVE" ]; then HS=not-running; fi; ` +
		// TRUST per real file, fail closed. Every file of the host config is checked: each
		// line of `nginx -T` that starts with `# configuration file ` is a header (one
		// trailing `:` stripped; a file name with a newline leaves its first part here,
		// which still names the directory), else every sites-enabled and conf.d entry
		// (a glob loop, so no name is split). A file that resolves (readlink -f, so a
		// symlink counts by its target) under app space, /opt/apps or its resolved path,
		// makes the state `app-space`; a header path that does not resolve to an existing
		// file makes it `unverifiable`. Either way nothing of the host config is read. A
		// header printed from inside a file cannot hide that file: its own header is real.
		`chk() { f=$1; r=$(readlink -f -- "$f" 2>/dev/null) || r=''; if inapp "$f" || { [ -n "$r" ] && inapp "$r"; }; then echo app-space; elif [ -z "$r" ] || [ ! -e "$r" ]; then echo unverifiable; fi; }; ` +
		`if [ "$HS" = read ]; then ` +
		`  if [ -n "$HN" ]; then V=$(printf '%s\n' "$HN" | sed -n 's/^# configuration file //p' | while IFS= read -r f; do chk "\${f%:}"; done); ` +
		`  else V=$(for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do if [ -e "$f" ] || [ -L "$f" ]; then chk "$f"; fi; done); fi; ` +
		`  case "$V" in (*app-space*) HS=app-space;; (*unverifiable*) HS=unverifiable;; esac; ` +
		`fi; ` +
		`echo "## HOST:$HS ##"; ` +
		`if [ "$HS" = read ]; then if [ -n "$HN" ]; then printf '%s\n' "$HN"; else for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do if [ -f "$f" ]; then cat -- "$f"; printf '\n'; fi; done; fi; fi; HN=''; V=''; ` +
		// the compose projects of powder's apps (their containers are app-controlled)
		`MANAGED=${shq(managed.join('\n'))}; ` +
		`MPROJ=$(printf '%s\\n' "$MANAGED" | grep -E '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' | while IFS= read -r m; do docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' -- "$m" 2>/dev/null; done | grep -v '^$' | sort -u); ` +
		// containerized nginx-ish containers that powder does not manage
		`CANDS=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'nginx|caddy|traefik|proxy' | grep -E '^[a-zA-Z0-9._-]+$' | while IFS= read -r c; do ` +
		`  if printf '%s\\n' "$MANAGED" | grep -qxF -- "$c"; then continue; fi; ` +
		`  CP=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' -- "$c" 2>/dev/null || true); ` +
		`  if [ -n "$CP" ] && printf '%s\\n' "$MPROJ" | grep -qxF -- "$CP"; then continue; fi; ` +
		`  CWD=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' -- "$c" 2>/dev/null || true); ` +
		`  case "$CWD" in (/opt/apps|/opt/apps/*|"$OPTR"|"$OPTR"/*) continue;; esac; ` +
		`  echo "$c"; ` +
		`done | head -10); ` +
		`for c in $CANDS; do ` +
		`  echo "## CONTAINER:$c ##"; ` +
		`  docker exec "$c" nginx -T 2>/dev/null || true; ` +
		`done; } 2>&1`
	let stdout = ''
	try {
		const result = await runCommand(server, cmd, 10_000)
		stdout = result.stdout
	} catch {
		return []
	}
	const routes: NginxRoutes = parseNginxRoutes(stdout)
	const host = hostState(stdout)
	if (host === 'app-space') {
		routes.hostSkipped = 'app-space'
		console.warn(`[discovery] ${server.id}: host nginx config includes a file from app space (/opt/apps); host routes not read`)
	} else if (host === 'unverifiable') {
		routes.hostSkipped = 'unverifiable'
		console.warn(`[discovery] ${server.id}: host nginx config names a file that could not be checked; host routes not read`)
	} else if (host === 'not-running') {
		routes.hostSkipped = 'not-running'
	}
	if (stdout.length > MAX_NGINX_PARSE_CHARS || stdout.includes(`\n${OUTPUT_TRUNCATED_MARKER}\n`)) {
		routes.tooLarge = true
		console.warn(
			`[discovery] ${server.id}: proxy config output (${stdout.length} chars) was cut at the parser or SSH cap; some routes not read`,
		)
	}
	return routes
}

/** What the host part of getNginxRoutes did: `read` (a running host nginx, every file
 *  outside app space), `not-running` (nginx installed, no master running: its config
 *  is not routing anything), `app-space` (some file of the host config resolves under
 *  /opt/apps: nothing of it read, fail closed), `unverifiable` (a file it names does
 *  not resolve to an existing file: nothing read, fail closed), `none` (no running
 *  host nginx, openresty or angie and no nginx installed). Only
 *  the FIRST line counts, which the command prints before any config text. */
export type HostNginxState = 'read' | 'not-running' | 'app-space' | 'unverifiable' | 'none'
export function hostState(stdout: string): HostNginxState | null {
	const m = /^## HOST:(read|not-running|app-space|unverifiable|none) ##(?:\n|$)/.exec(stdout)
	return m ? (m[1] as HostNginxState) : null
}

/** getNginxRoutes' result: the routes, and why the host config was not read when it
 *  was skipped for a reason an operator should see. */
export type NginxRoutes = NginxRoute[] & {
	hostSkipped?: 'app-space' | 'unverifiable' | 'not-running'
	/** the output was longer than MAX_NGINX_PARSE_CHARS or cut by the SSH runner: text
	 *  past the cut was not parsed, so some routes may be missing */
	tooLarge?: boolean
}

/** One `server` entry of an `upstream { }` block that nginx sends requests to. */
interface UpstreamTarget {
	host: string
	port: number | null
}

/** One `server` statement of an upstream block, as written. */
export interface UpstreamEntry {
	/** the address word: `127.0.0.1:3017`, `web:3000`, `unix:/run/x.sock`, `[::1]:3017` */
	address: string
	/** the words after the address (`max_fails=0`, `backup`, `weight=2`, ...) */
	params: string[]
	backup: boolean
	/** host and port when the address is `name[:port]`; null for unix sockets and [ipv6] */
	host: string | null
	port: number | null
}

/** The `## CONTAINER:<name> ##` lines getNginxRoutes prints before each proxy
 *  container's `nginx -T`. Everything before the first one is the host nginx. */
const SECTION_MARKER = /## CONTAINER:[A-Za-z0-9._-]+ ##/

/** The most text the nginx parser reads. The SSH runner already keeps at most
 *  256 KiB of head plus 1 MiB of tail of a command's output (CappedOutput); this is the
 *  parser's own bound, so a caller with other input cannot hand it more. */
export const MAX_NGINX_PARSE_CHARS = 1_500_000

/** Linear scan for flat `<keyword> <arg>... { body }` blocks (no nested braces), the
 *  same matches as the regex `(?:^|[\s;{}])<keyword>\s+<arg>(\s+<arg>)*\s*\{[^}]*\}`
 *  taken leftmost and non-overlapping, without its retries: the text is cut once into
 *  words and the punctuation `{`, `}`, `;`, a candidate is checked on the next few
 *  tokens, and a missing `}` ends the scan (no later block could close either).
 *  `args` is the exact number of words between the keyword and `{`, and `accept` may
 *  reject a candidate by its words (the scan then goes on from the next token, as a
 *  regex with those words spelled out would). The keyword is compared
 *  case-insensitively when `ci` is set. */
function scanFlatBlocks(
	text: string,
	keyword: string,
	args: number,
	ci = false,
	accept: (args: string[]) => boolean = () => true,
): Array<{ args: string[]; body: string }> {
	const toks: Array<{ t: string; at: number }> = []
	let i = 0
	const n = text.length
	// kind of a char code: 1 = punctuation, 2 = whitespace (as \s), 0 = word
	const kind = (c: number) =>
		c === 123 || c === 125 || c === 59
			? 1
			: c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
				? 2
				: 0
	while (i < n) {
		const k = kind(text.charCodeAt(i))
		if (k === 1) {
			toks.push({ t: text[i] as string, at: i })
			i++
		} else if (k === 2) {
			i++
		} else {
			const start = i
			while (i < n && kind(text.charCodeAt(i)) === 0) i++
			toks.push({ t: text.slice(start, i), at: start })
		}
	}
	const kw = ci ? keyword.toLowerCase() : keyword
	const out: Array<{ args: string[]; body: string }> = []
	let k = 0
	while (k < toks.length) {
		const tok = toks[k] as { t: string; at: number }
		if ((ci ? tok.t.toLowerCase() : tok.t) !== kw) {
			k++
			continue
		}
		// the keyword must be followed by whitespace, then `args` words, then `{`
		const argToks = toks.slice(k + 1, k + 1 + args)
		const open = toks[k + 1 + args]
		const wsAfterKw = /\s/.test(text[tok.at + tok.t.length] ?? '')
		if (
			!wsAfterKw ||
			argToks.length !== args ||
			argToks.some((a) => a.t === '{' || a.t === '}' || a.t === ';') ||
			open?.t !== '{' ||
			!accept(argToks.map((a) => a.t))
		) {
			k++
			continue
		}
		let close = k + 2 + args
		while (close < toks.length && (toks[close] as { t: string }).t !== '}') close++
		if (close >= toks.length) break
		out.push({
			args: argToks.map((a) => a.t),
			body: text.slice((open as { at: number }).at + 1, (toks[close] as { at: number }).at),
		})
		k = close + 1
	}
	return out
}

/** Pure: every `upstream <name> { ... }` block of one nginx instance, in order. The one
 *  reading of an upstream block in TypeScript, and the same reading as the deploy-time
 *  awk walk over `nginx -T` (UPSTREAM_WALK in deploy/fragments.ts; the parity test
 *  nginx-upstream-parity.test.ts keeps the two from drifting): `#` comments are cut to
 *  the end of the line first (also inside quotes, as the awk does), a block is
 *  `upstream <name> {` up to the first `}`, statements split on `;`, an entry is a
 *  statement whose first word is `server`, and an entry with the word `backup` is the
 *  backup (the zero-downtime bridge port), every other entry a primary. */
export function parseUpstreamBlocks(section: string): Array<{ name: string; entries: UpstreamEntry[] }> {
	const out: Array<{ name: string; entries: UpstreamEntry[] }> = []
	const text = section.slice(0, MAX_NGINX_PARSE_CHARS).replace(/#[^\n]*/g, '')
	for (const b of scanFlatBlocks(text, 'upstream', 1)) {
		const entries: UpstreamEntry[] = []
		for (const stmt of b.body.split(';')) {
			const words = stmt.trim().split(/\s+/)
			if (words[0] !== 'server' || !words[1]) continue
			const address = words[1]
			const params = words.slice(2)
			// unix:/path does not match (the colon is followed by a path), nor [ipv6]:port
			const addr = address.startsWith('unix:') ? null : /^([A-Za-z0-9._-]+)(?::(\d+))?$/.exec(address)
			entries.push({
				address,
				params,
				backup: params.includes('backup'),
				host: addr ? (addr[1] ?? null) : null,
				port: addr?.[2] ? Number(addr[2]) : null,
			})
		}
		out.push({ name: b.args[0] ?? '', entries })
	}
	return out
}

/** Pure: the targets of each upstream of ONE nginx instance (the host files, or one
 *  container's `nginx -T`), by lower-cased name (nginx matches upstream names
 *  case-insensitively). A target is a primary entry with a host:
 *  - `backup` and `down` entries are left out: nginx sends a request to a backup only
 *    while every primary is down (powder's zero-downtime bridge is such an entry, a
 *    port that is only up during a deploy swap), and never to a `down` one. The
 *    hostname belongs to the primary; a backup can be a different container (a
 *    maintenance page, or whatever else publishes that port), so attaching the
 *    hostname to it could hand an app a domain it does not serve.
 *  - `unix:` sockets and [ipv6] addresses are skipped (no container to match).
 *  - parameters after the address (weight, max_fails, ...) are ignored.
 *  A name defined twice with different targets resolves to nothing: nginx refuses to
 *  load a config with a duplicate upstream, so neither definition is provably the one
 *  running, and neither "last one wins" nor a merge would be sure to name the container
 *  nginx really proxies to. Identical duplicates (the same file listed twice) resolve. */
export function parseNginxUpstreams(section: string): Map<string, UpstreamTarget[] | null> {
	const out = new Map<string, UpstreamTarget[] | null>()
	for (const block of parseUpstreamBlocks(section)) {
		const name = block.name.toLowerCase()
		const targets: UpstreamTarget[] = []
		for (const e of block.entries) {
			if (e.backup || e.params.includes('down') || e.host == null) continue
			targets.push({ host: e.host, port: e.port })
		}
		const key = (t: UpstreamTarget[]) => JSON.stringify(t)
		if (out.has(name)) {
			const prev = out.get(name)
			out.set(name, prev && key(prev) === key(targets) ? prev : null)
		} else {
			out.set(name, targets)
		}
	}
	return out
}

/** Pure: the routes in getNginxRoutes' output. Server blocks are read as before
 *  (direct `proxy_pass http(s)://host[:port]` and the two `set $var` forms); a
 *  `proxy_pass http(s)://<name>` without a port that names an upstream block of the
 *  same nginx instance becomes one route per primary entry of that upstream (an
 *  explicit upstream takes precedence over a DNS name, as in nginx, and nginx refuses
 *  a port on a proxy_pass to an explicit upstream). Upstreams never cross from one
 *  instance to another: the host files and each proxy container are separate sections. */
export function parseNginxRoutes(stdout: string): NginxRoute[] {
	const map = new Map<string, Set<string>>() // key = "host|port"
	const text = stdout.slice(0, MAX_NGINX_PARSE_CHARS).replace(/^## HOST:[a-z-]+ ##\n?/, '')
	for (const section of text.split(SECTION_MARKER)) addSectionRoutes(section, map)
	return [...map.entries()].map(([key, urls]) => {
		const [host, portStr] = key.split('|')
		return {
			host: host || null,
			port: portStr ? Number(portStr) : null,
			urls: [...urls].sort(),
		}
	})
}

/** Pure: the `map $host $var { ... }` (and `map $http_host`) blocks of ONE nginx
 *  instance, by lower-cased variable name: lower-cased hostname -> value. Only exact
 *  hostname keys count: `default`, the `hostnames` / `include` / `volatile` directives,
 *  regex keys (`~...`) and wildcard keys (`*.x`, `.x`) are skipped, as is a value that
 *  holds another variable. A map keyed on anything other than the host is ignored. A
 *  variable mapped twice with different entries resolves to nothing (nginx refuses
 *  a duplicate variable, as with upstreams). */
export function parseHostMaps(section: string): Map<string, Map<string, string> | null> {
	const out = new Map<string, Map<string, string> | null>()
	const text = section.slice(0, MAX_NGINX_PARSE_CHARS).replace(/#[^\n]*/g, '')
	const isHostMap = (a: string[]) => /^\$(host|http_host)$/i.test(a[0] ?? '') && /^\$[A-Za-z0-9_]+$/.test(a[1] ?? '')
	for (const b of scanFlatBlocks(text, 'map', 2, true, isHostMap)) {
		const v = (b.args[1] ?? '').slice(1).toLowerCase()
		const entries = new Map<string, string>()
		for (const stmt of b.body.split(';')) {
			const words = stmt.trim().split(/\s+/).filter(Boolean)
			if (words.length !== 2) continue
			const key = (words[0] ?? '').replace(/^["']|["']$/g, '').toLowerCase()
			const value = (words[1] ?? '').replace(/^["']|["']$/g, '')
			if (!key || ['default', 'hostnames', 'include', 'volatile'].includes(key)) continue
			if (key.startsWith('~') || key.startsWith('.') || key.includes('*') || key.startsWith('\\')) continue
			if (!value || value.includes('$')) continue
			entries.set(key, value)
		}
		if (out.has(v)) {
			const prev = out.get(v)
			const same = prev && JSON.stringify([...prev]) === JSON.stringify([...entries])
			out.set(v, same ? prev : null)
		} else {
			out.set(v, entries)
		}
	}
	return out
}

function addSectionRoutes(section: string, map: Map<string, Set<string>>): void {
	const upstreams = parseNginxUpstreams(section)
	const hostMaps = parseHostMaps(section)
	const add = (host: string, port: number | null, urls: string[]) => {
		const targets =
			port == null && upstreams.has(host.toLowerCase()) ? (upstreams.get(host.toLowerCase()) ?? []) : [{ host, port }]
		for (const t of targets) {
			const key = `${t.host}|${t.port ?? ''}`
			const set = map.get(key) ?? new Set<string>()
			for (const u of urls) set.add(u)
			map.set(key, set)
		}
	}
	const blocks = section.split(/\bserver\s*\{/).slice(1)
	for (const block of blocks) {
		const closeIdx = findMatchingClose(block)
		const body = closeIdx === -1 ? block : block.slice(0, closeIdx)
		const serverName = firstServerName(body)
		if (serverName == null) continue
		const names = serverName
			.trim()
			.split(/\s+/)
			.filter((n) => n && n !== '_' && !n.startsWith('localhost'))
		// Some nginx configs use `set $upstream "..."` indirection. Inline those
		// so the proxy_pass regex below catches the upstream. Two flavors:
		//   set $u "http://X:Y";  proxy_pass $u;            (scheme in set)
		//   set $u "X:Y";         proxy_pass http://$u;     (scheme on proxy_pass)
		let inlinedBody = inlineSet(
			body,
			/set\s+\$([A-Za-z0-9_]+)\s+["']?(https?:\/\/[A-Za-z0-9._:-]+)["']?\s*;/g,
			/proxy_pass\s+()\$([A-Za-z0-9_]+)\s*;/g,
			(value) => `proxy_pass ${value};`,
		)
		inlinedBody = inlineSet(
			inlinedBody,
			/set\s+\$([A-Za-z0-9_]+)\s+["']?([A-Za-z0-9._:-]+)["']?\s*;/g,
			/proxy_pass\s+(https?:\/\/)\$([A-Za-z0-9_]+)\s*;/g,
			(value, scheme) => `proxy_pass ${scheme}${value};`,
		)
		// match any proxy_pass http(s)://<host>(:port)?
		const proxyMatches = [
			...inlinedBody.matchAll(/proxy_pass\s+https?:\/\/([A-Za-z0-9._-]+)(?::(\d+))?/g),
		]
		const isHttps = /listen\s+443/.test(body) || /ssl_certificate\s+/.test(body)
		const proto = isHttps ? 'https' : 'http'
		for (const m of proxyMatches) {
			const host = m[1] ?? ''
			const port = m[2] ? Number(m[2]) : null
			const upstreamName = host.toLowerCase()
			// a named upstream group: its primary entries are the targets. A group that
			// resolves to nothing (only backup/unix entries, or a conflicting duplicate)
			// gives no route; nginx would not look the name up in DNS either.
			const targets =
				port == null && upstreams.has(upstreamName) ? (upstreams.get(upstreamName) ?? []) : [{ host, port }]
			for (const t of targets) {
				const key = `${t.host}|${t.port ?? ''}`
				const set = map.get(key) ?? new Set<string>()
				for (const name of names) set.add(`${proto}://${name}`)
				map.set(key, set)
			}
		}
		// `proxy_pass` through a `map $host` variable: each server_name of this block
		// that is a key of the map routes to that key's value only. Three shapes:
		//   proxy_pass http://$v;        value host[:port] or an upstream name
		//   proxy_pass $v;               value http(s)://host[:port]
		//   proxy_pass http://HOST:$v;   value a port
		for (const m of inlinedBody.matchAll(/proxy_pass\s+(https?:\/\/)?(?:([A-Za-z0-9._-]+):)?\$([A-Za-z0-9_]+)\s*[;/]/g)) {
			const withScheme = !!m[1]
			const fixedHost = m[2] ?? null
			if (fixedHost && !withScheme) continue
			const entries = hostMaps.get((m[3] ?? '').toLowerCase())
			if (!entries) continue
			for (const name of names) {
				const value = entries.get(name.toLowerCase())
				if (!value) continue
				const url = `${proto}://${name}`
				if (fixedHost) {
					if (/^\d{1,5}$/.test(value)) add(fixedHost, Number(value), [url])
					continue
				}
				const hp = withScheme
					? /^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/.exec(value)
					: /^https?:\/\/([A-Za-z0-9._-]+)(?::(\d{1,5}))?\/?$/.exec(value)
				if (hp) add(hp[1] ?? '', hp[2] ? Number(hp[2]) : null, [url])
			}
		}
	}
}

/** The text after the first `server_name` that the regex `server_name\s+([^;]+);`
 *  would capture (only its trimmed words are used), found without the regex's retry
 *  from every later `server_name` when no `;` follows. null when it does not match. */
function firstServerName(body: string): string | null {
	const KW = 'server_name'
	let from = 0
	let end = -1 // the first `;` at or after the current occurrence, found once per stretch
	for (;;) {
		const at = body.indexOf(KW, from)
		if (at === -1) return null
		const after = at + KW.length
		if (end < after) end = body.indexOf(';', after)
		if (end === -1) return null
		// `\s+` then at least one `[^;]`: whitespace right after, and two or more chars
		if (/\s/.test(body[after] ?? '') && end - after >= 2) return body.slice(after, end)
		from = after
	}
}

/** The `set $v <value>; ... proxy_pass <scheme>$v;` inlining, linear: the same result
 *  as the regex `<setRe>[\s\S]*?<ppRe for the same $v>` replaced globally (each set,
 *  leftmost first, joins the first later proxy_pass of its variable, and the text
 *  between them is replaced), with the proxy_pass positions listed once instead of a
 *  lazy scan to the end from every set. `ppRe` captures the scheme (may be empty) and
 *  the variable. */
function inlineSet(
	body: string,
	setRe: RegExp,
	ppRe: RegExp,
	build: (value: string, scheme: string) => string,
): string {
	const pps = new Map<string, Array<{ at: number; end: number; scheme: string }>>()
	for (const m of body.matchAll(ppRe)) {
		const list = pps.get(m[2] ?? '') ?? []
		list.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, scheme: m[1] ?? '' })
		pps.set(m[2] ?? '', list)
	}
	if (pps.size === 0) return body
	const next = new Map<string, number>() // per variable: index of the first proxy_pass not yet passed
	let out = ''
	let pos = 0
	for (const m of body.matchAll(setRe)) {
		const at = m.index ?? 0
		if (at < pos) continue
		const list = pps.get(m[1] ?? '')
		if (!list) continue
		const setEnd = at + m[0].length
		let j = next.get(m[1] ?? '') ?? 0
		while (j < list.length && (list[j] as { at: number }).at < setEnd) j++
		next.set(m[1] ?? '', j)
		const pp = list[j]
		if (!pp) continue
		out += body.slice(pos, at) + build(m[2] ?? '', pp.scheme)
		pos = pp.end
	}
	return pos === 0 ? body : out + body.slice(pos)
}

function findMatchingClose(s: string): number {
	let depth = 1
	for (let i = 0; i < s.length; i++) {
		if (s[i] === '{') depth++
		else if (s[i] === '}') {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}

// Extract the host port from a docker ports string like "127.0.0.1:3006->3000/tcp, ..."
export function extractHostPorts(portsStr: string): number[] {
	if (!portsStr) return []
	const out = new Set<number>()
	for (const m of portsStr.matchAll(/:(\d+)->/g)) {
		out.add(Number(m[1]))
	}
	return [...out]
}

// Per-container extras we need for URL matching: network mode, PORT env (for host-network),
// compose service name (for container-DNS-based nginx upstreams), Traefik hostnames
// (for Traefik-routed apps that don't go through nginx).
export interface ContainerExtras {
	networkMode: string
	envPort: number | null
	composeService: string | null
	traefikHosts: string[]
}

/** Pure: parse the `docker inspect` lines of getContainerHostNetInfo. A line that
 *  does not have exactly four tab-separated fields with valid JSON is skipped. */
export function parseHostNetInfo(stdout: string): Map<string, ContainerExtras> {
	const result = new Map<string, ContainerExtras>()
	for (const line of stdout.split('\n')) {
		const parts = line.split('\t')
		if (parts.length !== 4) continue
		const [rawName = '', mode = '', envJson = '', labelsJson = ''] = parts
		const name = rawName.replace(/^\//, '')
		if (!SAFE_NAME.test(name)) continue
		let env: unknown
		let labels: unknown
		try {
			env = JSON.parse(envJson)
			labels = JSON.parse(labelsJson)
		} catch {
			continue
		}
		let envPort: number | null = null
		if (Array.isArray(env)) {
			for (const e of env) {
				const m = typeof e === 'string' ? /^PORT=(\d+)$/.exec(e) : null
				if (m) envPort = Number(m[1])
			}
		}
		const labelMap =
			labels && typeof labels === 'object' && !Array.isArray(labels) ? (labels as Record<string, unknown>) : {}
		// Traefik Host(`x.com`) values from any *.rule label (several per rule allowed).
		const traefikHosts: string[] = []
		for (const [k, v] of Object.entries(labelMap)) {
			if (typeof v !== 'string' || !/^traefik\.http\.routers\..+\.rule$/.test(k)) continue
			for (const m of v.matchAll(/Host\(`([^`]+)`\)/g)) if (m[1]) traefikHosts.push(m[1])
		}
		const svc = labelMap['com.docker.compose.service']
		result.set(name, {
			networkMode: mode,
			envPort,
			composeService: typeof svc === 'string' && svc ? svc : null,
			traefikHosts,
		})
	}
	return result
}

export async function getContainerHostNetInfo(
	server: ServerConfig,
	names: string[],
): Promise<Map<string, ContainerExtras>> {
	const result = new Map<string, ContainerExtras>()
	const safe = names.filter((n) => SAFE_NAME.test(n))
	if (safe.length === 0) return result
	const args = safe.map((n) => shq(n)).join(' ')
	// one line per container: name, network mode, then the env and the labels
	// as JSON (`{{json}}` escapes newlines and tabs), so an env value or a label cannot
	// start a forged record on a line of its own.
	// The separator is a Go template string ({{"\t"}}), so the tab never depends on how
	// the JS string or a shell passes an escape along (docker inspect does not expand \t).
	const cmd = `docker inspect ${args} --format '{{.Name}}{{"\\t"}}{{.HostConfig.NetworkMode}}{{"\\t"}}{{json .Config.Env}}{{"\\t"}}{{json .Config.Labels}}'`
	try {
		const { stdout } = await runCommand(server, cmd, 8000)
		const asked = new Set(safe)
		for (const [name, extras] of parseHostNetInfo(stdout)) if (asked.has(name)) result.set(name, extras)
	} catch {
		// non-fatal
	}
	return result
}

export async function listContainers(server: ServerConfig): Promise<ContainerInfo[]> {
	const fmt = '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.Ports}}\t{{.CreatedAt}}'
	const { stdout } = await runCommand(server, `docker ps -a --format '${fmt}'`)
	return stdout
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [name, image, status, state, ports, createdAt] = line.split('\t')
			return { name, image, status, state, ports, createdAt }
		})
}

export interface ContainerDetail {
	name: string
	image: string
	state: string
	status: string
	startedAt: string
	createdAt: string
	restartPolicy: string
	restartCount: number
	ports: string[]
	env: { key: string; value: string }[]
	mounts: { source: string; destination: string }[]
	compose: {
		project: string | null
		service: string | null
		workingDir: string | null
		configFile: string | null
		configFiles: string[]
	}
}

export async function inspectContainer(
	server: ServerConfig,
	name: string,
): Promise<ContainerDetail> {
	assertSafeName(name)
	const { stdout, code, stderr } = await runCommand(server, `docker inspect -- ${name}`)
	if (code !== 0) throw new DockerCommandError(stderr || `docker inspect failed for ${name}`)
	const parsed = JSON.parse(stdout) as Array<{
		Name: string
		Config: { Image: string; Env: string[]; Labels: Record<string, string> }
		State: { Status: string; StartedAt: string; Restarting: boolean }
		Created: string
		HostConfig: { RestartPolicy: { Name: string } }
		RestartCount: number
		NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> }
		Mounts: Array<{ Source: string; Destination: string }>
	}>
	const c = parsed[0]
	if (!c) throw new Error('container not found')

	const labels = c.Config.Labels ?? {}
	// Powder's per-deploy temp overrides are recorded in this label by `up`
	// and deleted right after; they are not part of the app's compose.
	const configFiles = (labels['com.docker.compose.project.config_files'] ?? '')
		.split(',')
		.map((f) => f.trim())
		.filter((f) => f && !isPowderTempComposeFile(f))
		.join(',')
	const compose = {
		project: labels['com.docker.compose.project'] ?? null,
		service: labels['com.docker.compose.service'] ?? null,
		workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
		configFile: configFiles ? (configFiles.split(',')[0] ?? null) : null,
		// EVERY -f file compose was started with (base + overrides). Deploys and
		// rollbacks must pass all of them — the first alone silently drops the
		// override file's settings on the next recreate.
		configFiles: configFiles ? configFiles.split(',').map((f) => f.trim()).filter(Boolean) : [],
	}

	const ports: string[] = []
	for (const [key, val] of Object.entries(c.NetworkSettings?.Ports ?? {})) {
		if (!val) continue
		for (const b of val) {
			ports.push(`${b.HostIp}:${b.HostPort} → ${key}`)
		}
	}

	const env = (c.Config.Env ?? []).map((entry) => {
		const idx = entry.indexOf('=')
		return idx === -1
			? { key: entry, value: '' }
			: { key: entry.slice(0, idx), value: entry.slice(idx + 1) }
	})

	return {
		name: c.Name.replace(/^\//, ''),
		image: c.Config.Image,
		state: c.State.Status,
		status: c.State.Status + (c.State.Restarting ? ' (restarting)' : ''),
		startedAt: c.State.StartedAt,
		createdAt: c.Created,
		restartPolicy: c.HostConfig?.RestartPolicy?.Name ?? 'no',
		restartCount: c.RestartCount ?? 0,
		ports,
		env,
		mounts: (c.Mounts ?? []).map((m) => ({ source: m.Source, destination: m.Destination })),
		compose,
	}
}
