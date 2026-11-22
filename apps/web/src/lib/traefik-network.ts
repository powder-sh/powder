// The one authority for "which Docker network does this server's Traefik route
// over". No ssh and no db here (an in-process cache of the last answers, read by
// the deploy's compose guard); traefik-network-run.ts reads the running traefik
// container. The server check (server-bootstrap.ts) and bin/server-bootstrap.sh
// use the same order.
//
// Order: the --providers.docker.network flag in the container's Entrypoint, Cmd
// or Args; else providers.docker.network in its mounted static config file
// (traefik.yml, .yaml or .toml, found by traefikConfigHostPath, the same lookup the
// file provider check uses). Those two are the operator's declaration, and only
// they move powder off `web` (routingNetwork): new apps, previews, snapshots and the
// rollback bridge join a declared network, and the compose guard accepts it for that
// server's apps. Anything powder starts on a network other than `web` also carries
// the traefik.docker.network label, so Traefik picks that network whatever else the
// container is on.
//
// Neither set: the network the container is attached to is only reported (source
// `attached`), never used. Attachment is no declaration: Traefik may be attached by
// hand to one app's compose network, and routing every app over it would let them
// all reach that app's database. Attached to several: `web` when it is one of them,
// else the first by name, leaving out Docker's built-in bridge/host/none, networks
// created `--internal` (no way out to the internet) and networks of another compose
// project than Traefik's own. Powder then keeps using `web`, and the server check
// requires `web` and says how to declare the other network. Nothing found, or no
// Traefik yet: `web`, the network powder's own Traefik install creates and runs on.
import { parse as parseYaml } from 'yaml'

/** What powder uses when nothing else is known: its own Traefik runs on `web`. */
export const DEFAULT_TRAEFIK_NETWORK = 'web'

// Docker's own rule for a network name (the same one compose-safety.ts applies to
// POWDER_SHARED_NETWORKS). Such a name has no shell metacharacter and cannot start
// with a dash, so a validated name is safe as a bare shell word.
const NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/** True for a valid Docker network name. Every value this module returns passed it. */
export function isDockerNetworkName(s: unknown): s is string {
	return typeof s === 'string' && NETWORK_NAME_RE.test(s)
}

/** The name, or throws: for code that puts it into a compose file or a command. */
export function assertDockerNetworkName(s: string): string {
	if (!isDockerNetworkName(s)) throw new Error(`invalid docker network name: ${JSON.stringify(s).slice(0, 80)}`)
	return s
}

// Docker's built-in networks: never a Traefik routing network for an app.
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none'])

export type TraefikNetworkSource = 'flag' | 'config' | 'attached' | 'default'

export interface TraefikNetwork {
	/** The network, a valid Docker network name. */
	name: string
	source: TraefikNetworkSource
	/** Networks the traefik container is attached to; null = no container or unknown. */
	attached: string[] | null
	/** Where the name came from, in words, for the check and the logs. */
	why: string
}

export interface DockerNetworkInfo {
	name: string
	internal: boolean
	/** its com.docker.compose.project label, null when none */
	project?: string | null
}

/** Sources that are the operator's declaration (the flag or the config file). */
export function isDeclaredSource(source: TraefikNetworkSource | string | null | undefined): boolean {
	return source === 'flag' || source === 'config'
}

/** The network powder routes over: the declared one, else `web`. */
export function routingNetwork(t: Pick<TraefikNetwork, 'name' | 'source'>): string {
	return isDeclaredSource(t.source) && isDockerNetworkName(t.name) ? t.name : DEFAULT_TRAEFIK_NETWORK
}

interface InspectMount {
	Source?: string
	Destination?: string
}
export interface InspectJson {
	Args?: string[]
	Config?: { Cmd?: string[] | null; Entrypoint?: string[] | null; Labels?: Record<string, string> | null }
	Mounts?: InspectMount[]
	NetworkSettings?: { Networks?: Record<string, unknown> | null }
}

// Host path behind a container path, via the mounts (null if not mounted).
export function hostPathOf(mounts: InspectMount[], containerPath: string): string | null {
	let best: InspectMount | null = null
	for (const m of mounts) {
		const d = (m.Destination ?? '').replace(/\/+$/, '')
		if (!d || !m.Source) continue
		if (containerPath === d || containerPath.startsWith(`${d}/`)) {
			if (!best || d.length > (best.Destination ?? '').length) best = m
		}
	}
	if (!best) return null
	const d = (best.Destination ?? '').replace(/\/+$/, '')
	return `${(best.Source ?? '').replace(/\/+$/, '')}${containerPath.slice(d.length)}`
}

export function flagValue(argv: string[], name: string): string | null | undefined {
	// undefined = flag absent; null = flag present without a value
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? ''
		const bare = a.replace(/^--?/, '')
		if (bare === name) {
			const next = argv[i + 1]
			return next !== undefined && !next.startsWith('-') ? next : null
		}
		if (bare.startsWith(`${name}=`)) return bare.slice(name.length + 1)
	}
	return undefined
}

/** The traefik container's command line: Entrypoint, Cmd and Args, in that order. */
export function traefikArgv(inspect: InspectJson): string[] {
	return [...(inspect.Config?.Entrypoint ?? []), ...(inspect.Config?.Cmd ?? []), ...(inspect.Args ?? [])]
}

// Where Traefik looks for its static config file inside the container when no
// --configFile is given (the /etc/traefik ones; Traefik's own lookup order).
const TRAEFIK_CONFIG_DEFAULTS = ['/etc/traefik/traefik.yml', '/etc/traefik/traefik.yaml', '/etc/traefik/traefik.toml']

/** Host path of the traefik container's static config file, or null when none is
 *  mounted: the --configFile flag's file, else a mounted /etc/traefik/traefik.yml,
 *  .yaml or .toml (a file mounted at that exact path first, else a mounted
 *  /etc/traefik folder read as traefik.yml). The one place that finds it: the file
 *  provider check and the Traefik network resolver (traefik-network.ts) both read
 *  the file this names. */
export function traefikConfigHostPath(inspect: InspectJson): string | null {
	const mounts = inspect.Mounts ?? []
	const argv = traefikArgv(inspect)
	const cfgFlag = flagValue(argv, 'configFile') ?? flagValue(argv, 'configfile')
	if (typeof cfgFlag === 'string') return hostPathOf(mounts, cfgFlag)
	for (const p of TRAEFIK_CONFIG_DEFAULTS) {
		const exact = mounts.find((m) => (m.Destination ?? '').replace(/\/+$/, '') === p && m.Source)
		if (exact) return hostPathOf([exact], p)
	}
	return hostPathOf(mounts, TRAEFIK_CONFIG_DEFAULTS[0] ?? '/etc/traefik/traefik.yml')
}

/** Pure: the `providers.docker.network` a Traefik static config file sets, or null
 *  (not set, or the file does not parse). `path` picks the format: a .toml file is
 *  read for that one key only, anything else as YAML (merge keys `<<` applied).
 *  Keys are matched case-insensitively: Traefik reads its file configuration through
 *  its paerser library, which matches keys to fields without regard to case (the
 *  same reason `exposedbydefault` and `exposedByDefault` both work); not confirmed
 *  against the paerser source here, so the match is case-insensitive either way. The
 *  caller validates the name. */
export function dockerNetworkFromConfig(text: string, path: string): string | null {
	if (/\.toml$/i.test(path)) return tomlDockerNetwork(text)
	let doc: unknown
	try {
		doc = parseYaml(text, { merge: true, maxAliasCount: 100 })
	} catch {
		return null
	}
	const n = getCi(getCi(getCi(doc, 'providers'), 'docker'), 'network')
	return typeof n === 'string' && n !== '' ? n : null
}

// A mapping's value under `key`, case-insensitively (an exact match first).
function getCi(obj: unknown, key: string): unknown {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
	const rec = obj as Record<string, unknown>
	if (key in rec) return rec[key]
	const k = Object.keys(rec).find((x) => x.toLowerCase() === key)
	return k === undefined ? undefined : rec[k]
}

// One TOML key segment: bare, "basic" or 'literal'.
const TOML_SEG = String.raw`(?:[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*')`
const TOML_KEY = String.raw`${TOML_SEG}(?:\s*\.\s*${TOML_SEG})*`
const TOML_TABLE_RE = new RegExp(String.raw`^\[\s*(${TOML_KEY})\s*\]$`)
const TOML_KV_RE = new RegExp(String.raw`^(${TOML_KEY})\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$`)

function tomlKeyPath(key: string): string {
	const segs = key.match(new RegExp(TOML_SEG, 'g')) ?? []
	return segs.map((x) => x.replace(/^["']|["']$/g, '').toLowerCase()).join('.')
}

// Only the one key: `network` under [providers.docker], `docker.network` under
// [providers], or the full dotted key at the top. Basic strings ("...") with escapes,
// literal strings ('...'); a line it cannot read is passed over.
function tomlDockerNetwork(text: string): string | null {
	let table = ''
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\s+#[^"']*$/, '').replace(/^#.*$/, '').trim()
		if (!line) continue
		if (line.startsWith('[[')) {
			table = '\u0000' // an array of tables: never the providers table
			continue
		}
		const head = TOML_TABLE_RE.exec(line)
		if (head) {
			table = tomlKeyPath(head[1] ?? '')
			continue
		}
		const kv = TOML_KV_RE.exec(line)
		if (!kv) continue
		const key = `${table ? `${table}.` : ''}${tomlKeyPath(kv[1] ?? '')}`
		if (key !== 'providers.docker.network') continue
		if (kv[3] !== undefined) return kv[3]
		const basic = kv[2] ?? ''
		// a backslash escape could only make an invalid network name: refuse it
		return basic.includes('\\') ? null : basic
	}
	return null
}

// The last answer per server, in-process (like the server check result). The run
// module fills it; the deploy's compose guard reads it without SSH.
/** A resolved answer is reused for this long before the container is read again. */
export const TRAEFIK_NETWORK_TTL_MS = 10 * 60 * 1000

const g = globalThis as { __powderTraefikNetworkCache?: Map<string, { at: number; value: TraefikNetwork }> }
function cache(): Map<string, { at: number; value: TraefikNetwork }> {
	if (!g.__powderTraefikNetworkCache) g.__powderTraefikNetworkCache = new Map()
	return g.__powderTraefikNetworkCache
}

/** The cached answer while fresh, else null. No SSH. */
export function cachedTraefikNetwork(serverId: string, now = Date.now()): TraefikNetwork | null {
	const hit = cache().get(serverId)
	return hit && now - hit.at <= TRAEFIK_NETWORK_TTL_MS ? hit.value : null
}

/** Store an answer in the in-process cache (traefik-network-run.ts does, after it
 *  read the container or the server check did). */
export function cacheTraefikNetwork(serverId: string, value: TraefikNetwork, now = Date.now()): void {
	cache().set(serverId, { at: now, value })
}

/** Without SSH: the routing network (routingNetwork) of the cached answer, else of the
 *  stored one, else `web`. What the deploy's compose guard uses (the deploy itself
 *  must not add an SSH round trip). Only a declared network (flag or config) widens
 *  the guard; an attached one never does. */
export function knownTraefikNetwork(server: {
	id: string
	proxy?: string | null
	traefikNetwork?: string | null
	traefikNetworkSource?: string | null
}): string {
	if (server.proxy !== 'traefik') return DEFAULT_TRAEFIK_NETWORK
	const hit = cachedTraefikNetwork(server.id)
	if (hit) return routingNetwork(hit)
	return isDeclaredSource(server.traefikNetworkSource) && isDockerNetworkName(server.traefikNetwork)
		? server.traefikNetwork
		: DEFAULT_TRAEFIK_NETWORK
}

/** `docker network ls --format '{{.Name}}:{{.Internal}}:{{.Label "com.docker.compose.project"}}'`
 *  output (newline or space separated; neither a network name nor a compose project
 *  name holds a colon) to name, internal and project; invalid names are dropped. */
export function parseDockerNetworks(text: string): DockerNetworkInfo[] {
	const out: DockerNetworkInfo[] = []
	for (const tok of text.split(/\s+/)) {
		const [name, internal, project] = tok.split(':')
		if (!isDockerNetworkName(name)) continue
		out.push({ name, internal: internal === 'true', project: project ? project : null })
	}
	return out
}

/** The traefik container's own compose project (its label), or null. */
export function traefikProject(inspect: InspectJson | null): string | null {
	const p = inspect?.Config?.Labels?.['com.docker.compose.project']
	return typeof p === 'string' && p !== '' ? p : null
}

/** Networks the container is attached to, from its inspect JSON (null = not in it). */
export function attachedNetworks(inspect: InspectJson | null): string[] | null {
	const nets = inspect?.NetworkSettings?.Networks
	if (!nets || typeof nets !== 'object') return null
	return Object.keys(nets).filter(isDockerNetworkName)
}

/** The attached-network fallback (no flag, no config setting): see the header. */
export function pickAttachedNetwork(
	attached: readonly string[],
	networks: readonly DockerNetworkInfo[] | null,
	ownProject: string | null = null,
): string | null {
	const internal = new Set((networks ?? []).filter((n) => n.internal).map((n) => n.name))
	// a network another compose project created belongs to that project (an app's own)
	const foreign = new Set(
		(networks ?? []).filter((n) => n.project && n.project !== ownProject).map((n) => n.name),
	)
	const candidates = attached.filter(
		(n) => isDockerNetworkName(n) && !BUILTIN_NETWORKS.has(n) && !internal.has(n) && !foreign.has(n),
	)
	if (candidates.includes(DEFAULT_TRAEFIK_NETWORK)) return DEFAULT_TRAEFIK_NETWORK
	return [...candidates].sort()[0] ?? null
}

/** The --providers.docker.network flag of the container, when it is a valid name. */
export function traefikNetworkFlag(inspect: InspectJson | null): string | null {
	const flag = inspect ? flagValue(traefikArgv(inspect), 'providers.docker.network') : undefined
	return isDockerNetworkName(flag) ? flag : null
}

/** Pure: the network Traefik routes over, from what the server reported. */
export function traefikNetworkFrom(input: {
	/** a container named traefik exists (running or stopped) */
	traefik: boolean
	inspect: InspectJson | null
	/** the static config file's content and its host path (traefikConfigHostPath),
	 *  null when there is none or it could not be read */
	config?: { text: string; path: string } | null
	/** `docker network ls` (parseDockerNetworks); null = unknown */
	networks?: readonly DockerNetworkInfo[] | null
	/** attached networks when the inspect JSON lacks them */
	attached?: readonly string[] | null
	/** Traefik's compose project when the inspect JSON lacks its labels */
	project?: string | null
}): TraefikNetwork {
	const def = (why: string, attached: string[] | null = null): TraefikNetwork => ({
		name: DEFAULT_TRAEFIK_NETWORK,
		source: 'default',
		attached,
		why,
	})
	if (!input.traefik) return def('no traefik container yet: the one powder starts runs on web')
	const attached = attachedNetworks(input.inspect) ?? (input.attached ? [...input.attached] : null)
	const flag = traefikNetworkFlag(input.inspect)
	if (flag) {
		return { name: flag, source: 'flag', attached, why: `its --providers.docker.network=${flag} flag` }
	}
	const fromConfig = input.config ? dockerNetworkFromConfig(input.config.text, input.config.path) : null
	if (isDockerNetworkName(fromConfig)) {
		return {
			name: fromConfig,
			source: 'config',
			attached,
			why: `providers.docker.network in ${input.config?.path ?? 'its config file'}`,
		}
	}
	const own = traefikProject(input.inspect) ?? input.project ?? null
	const picked = attached ? pickAttachedNetwork(attached, input.networks ?? null, own) : null
	if (picked) {
		return {
			name: picked,
			source: 'attached',
			attached,
			why:
				picked === DEFAULT_TRAEFIK_NETWORK
					? 'no providers.docker.network is set; traefik is attached to web'
					: `no providers.docker.network is set; traefik is attached to ${picked}, which powder does not route over until it is declared`,
		}
	}
	return def('nothing in the traefik container names a network: powder uses web', attached)
}

// The file provider's one user: domain redirects (domain-redirects.ts applyToTraefik
// writes a file only for these rows). Kept here, free of db and ssh, so the server
// check and the server row helpers can ask without loading the redirect code.
/** Pure: does this domain_redirects row need Traefik's file provider? A www mode
 *  other than none, or a non-empty custom redirect list (applyToTraefik writes a
 *  file for exactly these; a row with neither renders nothing). Unparseable custom
 *  JSON counts as in use (the cautious side). */
export function redirectRowInUse(row: { wwwMode: string; customRedirectsJson: string }): boolean {
	if (row.wwwMode !== 'none') return true
	try {
		const list = JSON.parse(row.customRedirectsJson || '[]') as unknown
		return !Array.isArray(list) || list.length > 0
	} catch {
		return true
	}
}
