// Rule `env_loopback` (compose-safety.ts runs it when ComposeGuardContext.checkEnvLoopback
// is set: at deploy time, when the compose differs from the last successful deploy).
//
// A service that is not on host networking has its own network namespace: inside the
// container 127.0.0.1 / localhost / ::1 is the container itself, not the server. An env
// value (env_file contents as compose inlines them, or `environment:`) that tells the
// app to CONNECT to a loopback address on a port the service does not listen on itself
// cannot reach anything. Example: an app moved from `network_mode: host` to bridge ports
// with DATABASE_URL=postgres://...@127.0.0.1:5433/app, where 5433 is the port its db
// container publishes on the server: inside the bridge container nothing listens there,
// so the app loses its database.
//
// Only connection targets are judged, so browser-facing and allow-list values never trip:
//   - a URL with a backend scheme (postgres, mysql, redis, amqp, mongodb, nats, kafka,
//     clickhouse, memcached, sqlserver, mssql, cockroachdb; also with a driver suffix such
//     as postgresql+asyncpg), in any variable;
//   - an http(s) URL only in a variable named *_URL, *_URI, *_HOST, *_ADDR, *_ADDRESS or
//     *_ENDPOINT whose name has no word part ORIGIN(S), CORS, CSP, ALLOWED, TRUSTED,
//     PUBLIC, REDIRECT(S), CALLBACK(S) or SITE(S) and does not end in BASE_URL,
//     NEXTAUTH_URL or AUTH_URL (whole `_` parts: DATABASE_URL is not BASE_URL);
//   - a bare `host:port` only in a variable named *_HOST(S), *_ADDR or *_ADDRESS (same
//     name exclusions).
// Not a finding: host networking or `container:` mode (a namespace powder cannot see);
// any service in a `network_mode: service:<x>` group of two or more (a sidecar there
// answers on loopback, and powder does not know its ports); the service's own ports
// (PORT, its container ports and `expose`, the EXPOSE ports of the image its running
// container has, a Traefik loadbalancer.server.port label, a loopback port its
// healthcheck probes); variables whose name holds LISTEN or BIND; `0.0.0.0` outside a URL
// (a listen address); loopback words without a port. Only the variable name and the
// host:port are reported, never the value. Pure.

import type { ComposeViolation } from './compose-safety'

const LOOP = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)`
/** `scheme://[userinfo@]<loopback>:<port>`; the userinfo runs to the LAST `@` before the
 *  host, so a password holding `@` does not hide it. */
const URL_RE = new RegExp(String.raw`([a-z][a-z0-9+.-]*)://(?:[^\s/]*@)?(${LOOP}):(\d{1,5})(?!\d)`, 'gi')
/** a bare `<loopback>:<port>` at the start of the value or after a separator (a host list) */
const BARE_RE = new RegExp(String.raw`(?:^|[\s,;])(${LOOP}):(\d{1,5})(?![\d.:])`, 'gi')
const LISTEN_NAME = /LISTEN|BIND/i
/** schemes that are always a backend connection */
const BACKEND_SCHEMES = new Set([
	'postgres', 'postgresql', 'mysql', 'mariadb', 'redis', 'rediss', 'amqp', 'amqps', 'mongodb', 'mongodb+srv',
	'nats', 'kafka', 'clickhouse', 'memcached', 'sqlserver', 'mssql', 'cockroachdb',
])

/** a backend scheme, also with a driver suffix (`postgresql+asyncpg`, `mysql+pymysql`,
 *  `redis+sentinel`, `mongodb+srv`) */
function isBackendScheme(scheme: string): boolean {
	return BACKEND_SCHEMES.has(scheme) || BACKEND_SCHEMES.has(scheme.split('+')[0] ?? '')
}
const HTTP_TARGET_NAME = /_(URL|URI|HOST|ADDR|ADDRESS|ENDPOINT)$/i
const BARE_TARGET_NAME = /(^|_)(HOST|HOSTS|ADDR|ADDRESS)$/i
/** browser-facing and allow-list names, matched on whole `_`-separated word parts (so
 *  DATABASE_URL is not BASE_URL and DEPOSITE_HOST is not SITE) */
const NOT_TARGET_NAME =
	/(^|_)(ORIGINS?|CORS|CSP|ALLOWED|TRUSTED|PUBLIC|REDIRECTS?|CALLBACKS?|SITES?)(_|$)|(^|_)(BASE_URL|NEXTAUTH_URL|AUTH_URL)$/i

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface LoopbackTarget {
	host: string
	port: number
	/** the URL scheme (lowercase), or null for a bare host:port */
	scheme: string | null
}

/** every loopback address with a port in a value (host lowercase). */
export function loopbackTargets(value: string): LoopbackTarget[] {
	const out: LoopbackTarget[] = []
	URL_RE.lastIndex = 0
	for (const m of value.matchAll(URL_RE)) {
		const port = Number(m[3])
		if (port > 0 && port <= 65535) out.push({ host: (m[2] ?? '').toLowerCase(), port, scheme: (m[1] ?? '').toLowerCase() })
	}
	BARE_RE.lastIndex = 0
	for (const m of value.matchAll(BARE_RE)) {
		const port = Number(m[2])
		if (port > 0 && port <= 65535) out.push({ host: (m[1] ?? '').toLowerCase(), port, scheme: null })
	}
	return out
}

/** whether a variable / target pair is a connection target this rule judges. */
export function isConnectionTarget(name: string, t: LoopbackTarget): boolean {
	if (LISTEN_NAME.test(name)) return false
	if (t.scheme !== null && isBackendScheme(t.scheme)) return true
	if (NOT_TARGET_NAME.test(name)) return false
	if (t.scheme === 'http' || t.scheme === 'https') return HTTP_TARGET_NAME.test(name)
	if (t.scheme === null) return t.host !== '0.0.0.0' && BARE_TARGET_NAME.test(name)
	return false
}

/** `environment` as name -> value (map or `K=V` list); unset names are left out. */
export function envEntries(env: unknown): Array<[string, string]> {
	if (Array.isArray(env))
		return env
			.filter((e): e is string => typeof e === 'string' && e.includes('='))
			.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])
	if (isObj(env))
		return Object.entries(env)
			.filter(([, v]) => v !== null && v !== undefined)
			.map(([k, v]) => [k, String(v)])
	return []
}

/** container-side ports of a `ports` / `expose` entry (`3000`, `8080:80`, `127.0.0.1:1:2/tcp`,
 *  `3000-3002`, or the long form's `target`). */
function containerPorts(entry: unknown): number[] {
	if (isObj(entry)) return containerPorts(entry.target)
	if (typeof entry !== 'string' && typeof entry !== 'number') return []
	const s = String(entry).split('/')[0] ?? ''
	const last = s.split(':').pop() ?? ''
	const r = last.match(/^(\d{1,5})(?:-(\d{1,5}))?$/)
	if (!r) return []
	const a = Number(r[1])
	const b = r[2] ? Number(r[2]) : a
	if (b < a || b - a > 1000) return [a]
	return Array.from({ length: b - a + 1 }, (_, i) => a + i)
}

/** the ports a service listens on itself (see the header). */
function ownPorts(def: Record<string, unknown>, imageExposed: readonly number[]): Set<number> {
	const out = new Set<number>(imageExposed)
	for (const k of ['ports', 'expose'] as const) {
		const v = def[k]
		for (const e of Array.isArray(v) ? v : []) for (const p of containerPorts(e)) out.add(p)
	}
	for (const [k, v] of envEntries(def.environment)) if (k === 'PORT' && /^\d{1,5}$/.test(v.trim())) out.add(Number(v.trim()))
	// the port a Traefik label sends traffic to, and what its own healthcheck probes
	for (const [k, v] of envEntries(def.labels))
		if (/\.loadbalancer\.server\.port$/i.test(k) && /^\d{1,5}$/.test(v.trim())) out.add(Number(v.trim()))
	const hc = isObj(def.healthcheck) ? def.healthcheck.test : undefined
	const hcText = Array.isArray(hc) ? hc.map(String).join(' ') : typeof hc === 'string' ? hc : ''
	for (const m of hcText.matchAll(/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0):(\d{1,5})/gi)) out.add(Number(m[1]))
	return out
}

/** the service whose namespace a service runs in (`network_mode: service:<x>` followed),
 *  or null when it is host networking, `container:` mode, or a loop. */
function namespaceRoot(name: string, services: Record<string, unknown>): string | null {
	let cur = name
	for (let i = 0; i < 10; i++) {
		const def = services[cur]
		const nm = isObj(def) && typeof def.network_mode === 'string' ? def.network_mode : ''
		if (nm === 'host' || nm.startsWith('container:')) return null
		if (!nm.startsWith('service:')) return cur
		cur = nm.slice(8)
		if (!(cur in services)) return null
	}
	return null
}

/** Pure: one `env_loopback` finding per service and variable. `value` is the variable
 *  name (a value-scoped exemption names it: {"env_loopback": ["DATABASE_URL"]}).
 *  `imageExposed`: per service, the EXPOSE ports of the image its running container has
 *  (the compose check probe); a service without an entry has none known. */
export function envLoopbackViolations(
	services: Record<string, unknown>,
	imageExposed: Readonly<Record<string, readonly number[]>> = {},
): ComposeViolation[] {
	const out: ComposeViolation[] = []
	const roots = new Map<string, string | null>()
	const groupSize = new Map<string, number>()
	for (const name of Object.keys(services)) {
		const root = namespaceRoot(name, services)
		roots.set(name, root)
		if (root !== null) groupSize.set(root, (groupSize.get(root) ?? 0) + 1)
	}
	for (const [name, def] of Object.entries(services)) {
		const root = roots.get(name) ?? null
		// a shared namespace: a sidecar's ports answer on loopback too
		if (root === null || !isObj(def) || (groupSize.get(root) ?? 0) > 1) continue
		const own = ownPorts(def, imageExposed[name] ?? [])
		for (const [k, v] of envEntries(def.environment)) {
			const hit = loopbackTargets(v).find((t) => !own.has(t.port) && isConnectionTarget(k, t))
			if (!hit) continue
			out.push({
				code: 'env_loopback',
				service: name,
				value: k,
				message: `service ${name}: env ${k} points at ${hit.host}:${hit.port} but the service is not on host networking, so it cannot reach the host there (inside the container ${hit.host} is the container itself). Point it at the target's service name (for example db:5432) or keep network_mode: host`,
			})
		}
	}
	return out
}
