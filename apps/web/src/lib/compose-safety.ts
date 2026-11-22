// ONE compose safety authority.
//
// Every compose file powder runs as root goes through composeViolations():
//   - at /new and on every powder-written override (compose-guard.ts), on the
//     YAML powder renders, parsed with YAML merge keys (`<<: *a`) applied;
//   - at deploy time (deploy/compose-check.ts), on the RESOLVED config
//     (`docker compose config --format json`: merges, includes, extends and
//     env interpolation already expanded), with a hash tripwire in the deploy
//     script so the config cannot change after the check (git sync, a repo
//     file feeding the compose) without the deploy being refused.
//
// It is an ALLOW-LIST: a service key that is not listed below is refused, so a
// new compose feature (use_api_socket, provider, type: image volumes, ...) is
// closed until someone decides it is safe. Every finding has a stable `code`;
// an operator can exempt one app from named codes (POWDER_COMPOSE_GUARD_EXEMPT,
// see exemptCodesFor) for the few infra stacks that need them, never the repo.
//
// Pure: no I/O. Inputs come from the caller.

import { posix } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { envLoopbackViolations } from './compose-env-loopback'
import { type ServerImageFacts, imageOwnershipRefusal, ownedImageRepos } from './image-ownership'

/** The compose project name compose derives from an app name: lowercase, only
 *  [a-z0-9_-] kept, leading `_` / `-` dropped (compose-go NormalizeProjectName). The app
 *  name (app_repos container_name) may hold `.` or uppercase; its project cannot. */
export function composeProjectNameFor(app: string): string {
	return app
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '')
		.replace(/^[_-]+/, '')
}

export interface ComposeGuardContext {
	/** powder app name (= container_name of the app service, = /opt/apps/<name>). */
	appName: string
	/** The compose project dir (dir of the first compose file). Default /opt/apps/<appName>. */
	projectDir?: string
	/** Paths a bind mount must never expose (compose files, env files, the deploy key).
	 *  A bind source that is one of them or an ancestor of one is refused. */
	protectedPaths?: string[]
	/** Hostnames this app may route on Traefik (default host + live verified
	 *  domains). null/undefined = do not check Host() (no Traefik on the server). */
	routeHosts?: string[] | null
	/** container names on the server that belong to OTHER compose projects. */
	foreignContainers?: string[]
	/** per shared network, the DNS names OTHER projects' containers
	 *  answer on it (container names and compose service names). Unset = fall
	 *  back to foreignContainers for every shared network. */
	foreignNamesByNetwork?: Record<string, string[]>
	/** image refs run by containers of OTHER compose projects. */
	foreignImages?: string[]
	/** image refs of OTHER compose projects' containers in ANY state (a stopped
	 *  app's image is still its image). A service that builds may not tag one of them. */
	foreignImagesAnyState?: string[]
	/** image refs OTHER compose projects BUILT on this server, any container state:
	 *  the image of another registered app's (or preview's) main container (a container
	 *  named after that app), and any image whose `com.docker.compose.project` label names
	 *  another project (compose built it). A public base image several apps run (a
	 *  pgvector or postgres DB) is in neither. Compared by repository (tag and digest
	 *  dropped): every tag of that repo is that app's code. */
	foreignBuiltImages?: string[]
	/** host ports OTHER compose projects' containers publish on the server, any
	 *  state (HostConfig.PortBindings; hand-started containers and powder's bridges, which
	 *  have no compose project, never count). */
	foreignPorts?: Array<{ hostIp: string; port: number; protocol: string; owner: string }>
	/** the other powder apps on this server (app_repos container names). A
	 *  service without a build section may not run an image named after one of them
	 *  (`<other>:<tag>`, `<other>-<x>:<tag>`): that is the other app's LOCAL image
	 *  (its code, its baked secrets), present even when its container is stopped. */
	otherApps?: string[]
	/** container names that belong to THIS compose project on the server now. */
	ownProjectContainers?: string[]
	/** compose-default image names (`<project>-<service>`) of OTHER compose
	 *  projects' containers on the server, any state. */
	foreignProjectImages?: string[]
	/** env_file / label_file paths of the compose being checked. composeViolations
	 *  fills this from every service (callers need not): a bind source that is a directory
	 *  above one of them is refused, because a container writing there could replace the
	 *  file with a symlink to another app's env file, which the next `compose up` (root)
	 *  reads. Binding the file itself is allowed (its mount point cannot be replaced). */
	envFilePaths?: string[]
	/** migration folders powder-migrate reads (migrationDirPaths): a WRITABLE
	 *  bind at or above one is a `bind` finding, a read-only one passes. */
	migrationPaths?: string[]
	/** Extra env files the app may read (preview override file). */
	extraEnvFiles?: string[]
	/** Codes the operator exempted for this app. */
	exempt?: readonly string[]
	/** value-scoped exemptions (code -> exact values or prefixes ending in `/` or
	 *  `*`), from the object form of POWDER_COMPOSE_GUARD_EXEMPT. Match only violations
	 *  that carry a value (network_mode, pid, ipc: the mode; bind: the absolute source). */
	exemptValues?: Readonly<Record<string, readonly string[]>>
	/** false: input is a raw file (extends/include not expanded yet), refuse those keys. */
	resolved?: boolean
	/** services the `--no-interpolate` config has and the resolved one lacks
	 *  (deployGuardContext). The rules never saw them; each is a `profiles` finding. */
	unresolvedServices?: readonly string[]
	/** powder's own service / container names (selfDeployNames, from process.env
	 *  when unset). No app may use either as a service key or container_name. */
	selfNames?: { service: string | null; container: string }
	/** docker volume name -> its `device` driver option, for the volumes on the server
	 *  that have one (the compose check probe). An `external` volume whose server copy has a
	 *  device is refused: its driver options are not in the config, so no rule saw them. */
	serverVolumeDevices?: Readonly<Record<string, string>>
	/** part (c) of the writable set (writableFoldersOf): for every container of
	 *  every compose project on the server, in any state, its writable bind sources and the
	 *  absolute `device` of every named volume it mounts writable (deployGuardContext, from
	 *  the compose check probe). Undefined: the probe did not report container mounts. */
	serverWritable?: readonly string[]
	/** the whole writable set; composeViolations fills it (callers need not). */
	writableFolders?: readonly string[]
	/** registry hosts root is logged in to on the server (the `auths` / `credHelpers`
	 *  key names of root's docker config.json, never the credentials; Docker Hub left
	 *  out). Undefined (the probe could not read them): `ghcr.io`, the common registry
	 *  login (fail closed). */
	registryLoginHosts?: readonly string[]
	/** the `/opt/apps/<x>.env` files that exist on the server (basenames, links
	 *  included), from the compose check probe. Undefined (the probe did not report them):
	 *  every such file counts as existing. */
	serverEnvFiles?: readonly string[]
	/** names that own things on the server besides the registered apps: every
	 *  compose project of a container (any state), the compose project label of every
	 *  volume, and every /opt/apps folder that holds a compose file. They join
	 *  ctx.otherApps in the longest-owner rule of ownByPrefix (never this app's own name or
	 *  project). */
	serverOwners?: readonly string[]
	/** docker volume name -> its `com.docker.compose.project` label, for the
	 *  volumes on the server that have one. A volume of this compose that exists with another
	 *  project's label is refused. */
	serverVolumeProjects?: Readonly<Record<string, string>>
	/** powder's own env file (POWDER_ENV_FILE); from process.env when undefined. */
	powderEnvFile?: string | null
	/** who built or runs each image repo on the server and which apps' Dockerfiles read
	 *  it (image-ownership.ts serverImageFacts). Undefined: only the Docker Hub namespace rule
	 *  of imageOwnershipRefusal runs. */
	serverImages?: ServerImageFacts
	/** run the `env_loopback` rule (compose-env-loopback.ts): a service off host
	 *  networking whose env points at a loopback address on a port it does not listen on.
	 *  The deploy sets it when the compose differs from the last successful deploy
	 *  (deploy/compose-check.ts); an unchanged config is not re-judged on it. */
	checkEnvLoopback?: boolean
	/** per service of this compose, the EXPOSE ports of the image its existing container
	 *  runs (deployGuardContext, from the compose check probe): its own ports for
	 *  env_loopback. Undefined: none known. */
	serviceImageExposed?: Readonly<Record<string, readonly number[]>>
	/** the network this app's own server's Traefik routes over (traefik-network.ts), when
	 *  it is not `web`. The compose powder renders for a new app there joins it
	 *  (compose-render.ts), so on that server, and only there, it counts as shared like
	 *  `web` (sharedNetworksFor). Never from the app's compose: the callers pass the
	 *  server's resolved value (the new-app flow, the deploy's guard). */
	traefikNetwork?: string | null
}

/** the login hosts a check assumes: the probed list, else ghcr.io. */
function loginHostsOf(ctx: Pick<ComposeGuardContext, 'registryLoginHosts'>): string[] {
	return ctx.registryLoginHosts ? [...ctx.registryLoginHosts] : ['ghcr.io']
}

/** the registry host of an image ref (lowercase), or '' for Docker Hub. */
function registryHostOf(ref: string): string {
	const repo = imageRepo(ref).toLowerCase()
	const i = repo.indexOf('/')
	if (i < 0) return ''
	const first = repo.slice(0, i)
	return first.includes('.') || first.includes(':') || first === 'localhost' ? first : ''
}

/** a ref on a registry root is logged in to (a private repo root's login can
 *  pull) is this app's only when its last path segment is the app name. An
 *  image this compose builds does NOT count (the app picks that name: building
 *  `ghcr.io/<org>/<other>` must not license pulling it). Returns the host when it is NOT
 *  this app's, else null. */
function loginRegistryForeign(ref: string, appName: string, loginHosts: readonly string[]): string | null {
	const host = registryHostOf(ref)
	if (!host || !loginHosts.includes(host)) return null
	const repo = imageRepo(ref).toLowerCase()
	const last = repo.split('/').pop() ?? repo
	if (last === appName.toLowerCase()) return null
	return host
}

export interface ComposeViolation {
	code: string
	service?: string
	message: string
	/** what a value-scoped exemption matches (mode or absolute bind source). */
	value?: string
}

/** Container names that belong to powder or the server itself. */
export const RESERVED_CONTAINER_NAMES = [
	'powder',
	'powder-worker',
	'postgres',
	'powder-postgres',
	'traefik',
]

/** Shared external networks an app may join by default. Anything else must be the
 *  app's own, or named in POWDER_SHARED_NETWORKS. */
export const SHARED_NETWORKS = ['web', 'internal', 'infra']

/** The shared networks for this install: SHARED_NETWORKS plus the operator's
 *  POWDER_SHARED_NETWORKS (comma-separated docker network names, e.g. a stack network
 *  several apps on one server already share). Invalid names are ignored. */
export function sharedNetworks(env: Record<string, string | undefined> = process.env): string[] {
	const extra = (env.POWDER_SHARED_NETWORKS ?? '')
		.split(',')
		.map((n) => n.trim())
		.filter((n) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n))
	return [...new Set([...SHARED_NETWORKS, ...extra])]
}

/** The shared networks for one check: sharedNetworks() plus the server's own Traefik
 *  network (ctx.traefikNetwork, a valid name only). Not a global widening: another
 *  server's apps get it only when their own Traefik routes over it. */
export function sharedNetworksFor(ctx: Pick<ComposeGuardContext, 'traefikNetwork'>): string[] {
	const base = sharedNetworks()
	const t = ctx.traefikNetwork
	return t && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(t) && !base.includes(t) ? [...base, t] : base
}

/** logging drivers that keep the logs on the server. */
const LOCAL_LOG_DRIVERS = ['json-file', 'local', 'journald', 'none']

const DENY = Symbol('deny')
type KeyRule = 'ok' | typeof DENY | ((v: unknown, s: SvcCtx) => void)

interface SvcCtx {
	svc: string
	ctx: Required<Pick<ComposeGuardContext, 'appName'>> & ComposeGuardContext
	project: string
	services: Set<string>
	containerNames: Set<string>
	out: ComposeViolation[]
}

function add(s: SvcCtx, code: string, message: string, value?: string) {
	s.out.push({ code, service: s.svc, message: `service ${s.svc}: ${message}`, ...(value !== undefined ? { value } : {}) })
}

function appRoots(ctx: ComposeGuardContext): string[] {
	const roots = [`/opt/apps/${ctx.appName}`]
	if (ctx.projectDir) roots.push(posix.normalize(ctx.projectDir))
	return [...new Set(roots)]
}

/** Absolute, normalized path; relative paths are resolved against the project dir. */
function absPath(p: string, ctx: ComposeGuardContext): string | null {
	if (p.startsWith('~')) return null
	const base = ctx.projectDir ?? `/opt/apps/${ctx.appName}`
	return posix.resolve(base, p)
}

function under(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`)
}

function insideApp(p: string, ctx: ComposeGuardContext): boolean {
	if (p.split('/').includes('..')) return false
	const a = absPath(p, ctx)
	return !!a && appRoots(ctx).some((r) => under(a, r))
}

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null
}

function asList(v: unknown): unknown[] {
	if (v === undefined || v === null) return []
	return Array.isArray(v) ? v : [v]
}

/** Labels as [key, value] pairs from list or map form. */
function labelPairs(v: unknown): Array<[string, string]> {
	if (Array.isArray(v)) {
		return v.map((l) => {
			const s = String(l)
			const i = s.indexOf('=')
			return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
		})
	}
	if (v && typeof v === 'object')
		return Object.entries(v).map(([k, val]) => [k, val === null ? '' : String(val)])
	return []
}

const RUNTIME_MARKER_LABELS = new Set([
	'powder.bridge',
	'powder.release',
	'powder.candidate',
	'powder.candidate.app',
	'powder.testgate',
])

/** Router rule: a disjunction of Host() terms, optionally ANDed with anything
 *  that has no `||` or `!` (AND only narrows). Returns the hosts, or null. */
export function routerRuleHosts(rule: string): string[] | null {
	const m = rule.match(
		/^\s*(\(?\s*Host\([^)]*\)(?:\s*\|\|\s*Host\([^)]*\))*\s*\)?)\s*(?:&&\s*([^|!]*))?$/,
	)
	if (!m) return null
	if (m[2] !== undefined && m[2].trim() === '') return null
	const hosts: string[] = []
	for (const term of (m[1] ?? '').matchAll(/Host\(([^)]*)\)/g)) {
		for (const arg of (term[1] ?? '').split(',')) {
			const h = arg.trim().match(/^`([^`]*)`$/)
			if (!h) return null
			hosts.push((h[1] ?? '').toLowerCase())
		}
	}
	return hosts.length ? hosts : null
}

/** `name` is the app's own by prefix: the app name itself, or `<app><sep>...`,
 *  unless a LONGER registered app on the server also names it (`shop-api-x` belongs to
 *  the app `shop-api`, not to `shop`), the rule checkSiblingImage uses for images. */
export function ownByPrefix(
	name: string,
	ctx: Pick<ComposeGuardContext, 'appName' | 'otherApps' | 'serverOwners'>,
	seps: readonly string[],
	caseInsensitive = false,
): boolean {
	const norm = (x: string) => (caseInsensitive ? x.toLowerCase() : x)
	const n = norm(name)
	const app = norm(ctx.appName)
	const named = (p: string) => n === p || seps.some((sep) => n.startsWith(`${p}${sep}`))
	if (!named(app)) return false
	// the server's other owners (compose projects, volume project labels, app
	// folders) count like registered apps.
	return ![...(ctx.otherApps ?? []), ...(ctx.serverOwners ?? [])]
		.map(norm)
		.some((o) => o.length > app.length && o !== app && named(o))
}

/** separators that make a name `<app><sep>...` a name of that app. */
const OWNER_SEPS = ['-', '_', '.'] as const

/** the registered app (this app or one of ctx.otherApps, preview container
 *  names included) that owns `name`: the LONGEST registered name that equals it or
 *  prefixes it with `-`, `_` or `.`. undefined when no registered name does. */
export function registeredOwnerOf(
	name: string,
	ctx: Pick<ComposeGuardContext, 'appName' | 'otherApps'>,
): string | undefined {
	let best: string | undefined
	for (const o of [ctx.appName, ...(ctx.otherApps ?? [])]) {
		if (!o) continue
		if (name !== o && !OWNER_SEPS.some((sep) => name.startsWith(`${o}${sep}`))) continue
		if (!best || o.length > best.length) best = o
	}
	return best
}

/** the one authority for "may this app's compose read /opt/apps/<owner>.env".
 *  Yes when owner is the app name; or own-prefixed (`<app>-x`, `<app>_x`, `<app>.db`)
 *  and no longer registered app (or other owner on the server) owns it; or a
 *  container_name of this compose that no OTHER registered app or preview owns (a sidecar
 *  such as `renderer` whose name no app claims). A container name is the compose's to
 *  choose, so `shop.preview` in app evil's compose does not make /opt/apps/shop.preview.env
 *  evil's. The container_name path holds only when that container already belongs
 *  to THIS app's compose project (any state), or the file does not exist on the server yet
 *  (ctx.serverEnvFiles; unknown = exists): a leftover `/opt/apps/<x>.env` of a removed app
 *  or a copied file is not claimed by naming a container `<x>`. */
export function envFileOwnerAllowed(
	owner: string,
	ctx: Pick<ComposeGuardContext, 'appName' | 'otherApps' | 'serverOwners' | 'ownProjectContainers' | 'serverEnvFiles'>,
	containerNames: ReadonlySet<string>,
): boolean {
	if (owner === ctx.appName) return true
	if (ownByPrefix(owner, ctx, OWNER_SEPS)) return true
	if (!containerNames.has(owner)) return false
	const reg = registeredOwnerOf(owner, ctx)
	if (reg !== undefined && reg !== ctx.appName) return false
	if ((ctx.ownProjectContainers ?? []).includes(owner)) return true
	return ctx.serverEnvFiles !== undefined && !ctx.serverEnvFiles.includes(`${owner}.env`)
}

/** env / label files no app may read, whatever the rules above say: powder's own
 *  env file (POWDER_ENV_FILE), `/opt/apps/powder*.env` and anything under
 *  `/opt/apps/powder/`. */
export function powderEnvFileHit(abs: string, powderEnvFile: string | null | undefined): boolean {
	const a = posix.normalize(abs)
	if (powderEnvFile && posix.isAbsolute(powderEnvFile) && a === posix.normalize(powderEnvFile)) return true
	if (/^\/opt\/apps\/powder[^/]*\.env$/.test(a)) return true
	return under(a, '/opt/apps/powder')
}

/** The app owns a Traefik object name: the app name, or `<app>-...` (not when a
 *  longer registered app name also prefixes it). Never the compose `name:`. */
function ownTraefikName(n: string, s: SvcCtx): boolean {
	return ownByPrefix(n, s.ctx, ['-'], true)
}

/** Traefik merges same-named routers, services, middlewares and serversTransports
 *  across every container it watches, so a label naming another app's object
 *  (`traefik.http.routers.<other>.rule=...`) rewrites that app's route. Every
 *  object an app defines must carry its own name, and the names a router (or a
 *  chain middleware) references must be its own too. Providers: none, @docker or
 *  @file (own names only); `service=...@internal` is traefik_internal. */
function checkTraefikNames(key: string, val: string, s: SvcCtx, where: string) {
	const m = key.match(
		/^traefik\.(?:http|tcp|udp)\.(?:routers|services|middlewares|serverstransports)\.([^.]+)(?:\.|$)/i,
	)
	const objName = m?.[1]
	if (!objName) return
	if (!ownTraefikName(objName, s))
		add(
			s,
			'traefik_name',
			`${where} "${key}": Traefik object "${objName}" is not this app's (name it ${s.ctx.appName} or ${s.ctx.appName}-<name>; Traefik merges same-named objects across apps)`,
		)
	// every key ending in `.service` / `.services` names a Traefik service
	// (a router's, a middleware's `errors.service`, ...), not only the router one.
	const ref = key.match(
		/\.(?:(service|services)|routers\.[^.]+\.middlewares|middlewares\.[^.]+\.chain\.middlewares)$/i,
	)
	if (!ref) return
	const isService = ref[1]?.toLowerCase() === 'service'
	for (const item of val.split(',')) {
		const v = item.trim()
		if (!v) continue
		const at = v.lastIndexOf('@')
		const name = at === -1 ? v : v.slice(0, at)
		const provider = at === -1 ? '' : v.slice(at + 1).toLowerCase()
		if (provider === 'internal' && isService) continue // traefik_internal
		if (provider !== '' && provider !== 'docker' && provider !== 'file')
			add(
				s,
				'traefik_name',
				`${where} "${key}": "${v}" uses the ${provider} provider (only own names, @docker or @file)`,
			)
		else if (!ownTraefikName(name, s))
			add(
				s,
				'traefik_name',
				`${where} "${key}": "${v}" is not this app's (a router may only use ${s.ctx.appName} or ${s.ctx.appName}-<name> objects)`,
			)
	}
}

function checkLabels(v: unknown, s: SvcCtx, where = 'label') {
	for (const [k, val] of labelPairs(v)) {
		const key = k.trim()
		if (/^com\.docker\.compose\./i.test(key))
			add(
				s,
				'compose_label',
				`${where} "${key}" is reserved for docker compose (it would move the container into another project)`,
			)
		if (RUNTIME_MARKER_LABELS.has(key))
			add(s, 'powder_label', `${where} "${key}" is a powder runtime marker`)
		if (/^traefik\./i.test(key)) {
			if (/^traefik\.(tcp|udp)\./i.test(key))
				add(s, 'traefik_tcp', `${where} "${key}": tcp/udp routers are not allowed`)
			// a service URL / address sends the route to any host and port
			// (another app's container, the dashboard, a metadata endpoint), not to
			// this container.
			if (/^traefik\.(?:http|tcp|udp)\.services\.[^.]+\.loadbalancer\..*\.(?:url|address)$/i.test(key))
				add(
					s,
					'traefik_url',
					`${where} "${key}": a Traefik service URL or address is not allowed (the route must go to this container)`,
				)
			// a forwardAuth middleware makes Traefik call its address (any host,
			// powder's dashboard included) for every request of the route, with the
			// request's headers.
			if (/^traefik\.http\.middlewares\.[^.]+\.forwardauth\./i.test(key))
				add(
					s,
					'traefik_url',
					`${where} "${key}": a Traefik forwardAuth middleware is not allowed (it sends each request to another address)`,
				)
			if (/\.service$/i.test(key) && /@internal\s*$/i.test(val))
				add(s, 'traefik_internal', `${where} "${key}" points at a Traefik internal service`)
			checkTraefikNames(key, val, s, where)
			if (/^traefik\.http\.routers\.[^.]+\.rule$/i.test(key) && s.ctx.routeHosts) {
				const hosts = routerRuleHosts(val)
				const allowed = new Set(s.ctx.routeHosts.map((h) => h.toLowerCase()))
				if (!hosts)
					add(
						s,
						'traefik_host',
						`${where} "${key}": the rule must be Host(\`<domain>\`) terms of this app's verified domains, got "${val.slice(0, 120)}"`,
					)
				else
					for (const h of hosts)
						if (!allowed.has(h))
							add(
								s,
								'traefik_host',
								`${where} "${key}": Host(\`${h}\`) is not one of this app's verified domains`,
							)
			}
			// a router's tls.domains main / sans make Traefik request (ACME) or serve a
			// certificate for those names, routed or not: only the app's own hosts.
			if (/^traefik\.http\.routers\.[^.]+\.tls\.domains\[\d+\]\.(?:main|sans)$/i.test(key) && s.ctx.routeHosts) {
				const allowed = new Set(s.ctx.routeHosts.map((h) => h.toLowerCase()))
				for (const d of val.split(',').map((x) => x.trim().toLowerCase()))
					if (!allowed.has(d))
						add(
							s,
							'traefik_host',
							`${where} "${key}": TLS domain "${d.slice(0, 120)}" is not one of this app's verified domains`,
						)
			}
		}
	}
}

/** the folders infra/powder-migrate reads *.sql from (relative to the source
 *  root: `<workdir>/src` when it exists, else `<workdir>`), in its order. Keep in sync
 *  with the candidate loop there. */
const MIGRATION_CANDIDATE_DIRS = [
	'src/drizzle',
	'drizzle',
	'migrations',
	'src/migrations',
	'supabase/migrations',
	'db/migrations',
] as const

/** protected paths for every migration candidate dir under both possible
 *  source roots. A WRITABLE bind at or above one is a high `bind` finding (a container
 *  could swap a migration powder feeds to the app DB as root); `:ro` passes. */
export function migrationDirPaths(workingDir: string): string[] {
	const w = workingDir.replace(/\/+$/, '')
	return [...new Set([`${w}/src`, w].flatMap((root) => MIGRATION_CANDIDATE_DIRS.map((d) => `${root}/${d}`)))]
}

/** Every problem with a host path a container mounts: outside the app (unless
 *  `ownSiblings` and it is an `/opt/apps/<app>-*` folder this app owns by the
 *  longest-registered-name rule), the app dir itself, a folder above a protected path
 *  (compose files, the deploy key, the rendered env file) or above an env file. */
function bindSourceProblems(
	src: string,
	ctx: ComposeGuardContext,
	what: string,
	ownSiblings = false,
	/** a read-only bind cannot plant git config, so .git paths only count for rw. */
	readOnly = false,
): string[] {
	const out: string[] = []
	let a: string
	if (insideApp(src, ctx)) {
		a = absPath(src, ctx) as string
		if (appRoots(ctx).includes(a))
			return [
				`${what} "${src}" is the app directory itself (it holds the compose file and the deploy key); mount a subdirectory`,
			]
	} else {
		const n = src.split('/').includes('..') ? null : absPath(src, ctx)
		const top = n?.match(/^\/opt\/apps\/([^/]+)(?:\/|$)/)?.[1]
		const others = ctx.otherApps ?? []
		const sibling =
			ownSiblings &&
			!!top &&
			top.length > ctx.appName.length + 1 &&
			!top.endsWith('.env') &&
			!others.some((o) => o === top || `${o}.env` === top) &&
			ownByPrefix(top, ctx, ['-'])
		if (!sibling || !n)
			return [
				`${what} "${src}" is outside ${appRoots(ctx).join(' or ')}${ownSiblings ? ` and /opt/apps/${ctx.appName}-* (folders of this app only, never another registered app's)` : ''}`,
			]
		a = n
	}
	const migrationDirs = new Set(ctx.migrationPaths ?? [])
	for (const p of [...(ctx.protectedPaths ?? []), ...migrationDirs]) {
		if (readOnly && (p.endsWith('/.git') || migrationDirs.has(p))) continue
		if (under(posix.normalize(p), a))
			out.push(
				p.endsWith('/.git')
					? `${what} "${src}" would expose ${p}: a container that can write the checkout's git metadata can plant config that powder's git runs as root (bind a subfolder such as ./src/public, or copy the code into the image)`
					: migrationDirs.has(p)
						? `${what} "${src}" is a writable bind at or above the migrations folder ${p}: powder-migrate feeds its *.sql to the app database on every deploy (mount it :ro)`
						: `${what} "${src}" would expose ${p}`,
			)
		// a WRITABLE bind of anything INSIDE git metadata (hooks, modules, info,
		// objects) is the same finding: a container could write what powder's git reads.
		else if (p.endsWith('/.git') && under(a, posix.normalize(p)))
			out.push(
				`${what} "${src}" is inside ${p}: a container that can write the checkout's git metadata can plant files that powder's git reads as root (mount it :ro, or bind a folder outside .git)`,
			)
	}
	for (const p of ctx.envFilePaths ?? []) {
		const n = posix.normalize(p)
		if (n !== a && under(n, a))
			out.push(
				`${what} "${src}" contains the env file ${p}: a container could replace it with a link to another app's secrets (keep env files outside bind-mounted folders, or bind the file itself)`,
			)
	}
	return out
}

function checkBindSource(src: string, s: SvcCtx, what: string, readOnly = false) {
	const abs = absPath(src, s.ctx)
	for (const m of bindSourceProblems(src, s.ctx, what, false, readOnly))
		add(s, 'bind', m, abs ? posix.normalize(abs) : src)
}

function checkVolumes(v: unknown, s: SvcCtx) {
	for (const vol of asList(v)) {
		if (typeof vol === 'string') {
			const parts = vol.split(':')
			const src = parts.length > 1 ? (parts[0] ?? '') : ''
			if (src === '') continue // anonymous volume
			if (src.startsWith('/') || src.startsWith('.') || src.startsWith('~'))
				checkBindSource(src, s, 'bind mount', (parts[2] ?? '').split(',').includes('ro'))
			continue
		}
		if (!vol || typeof vol !== 'object') {
			add(s, 'volume', 'unreadable volume entry')
			continue
		}
		const o = vol as { type?: string; source?: unknown; read_only?: unknown }
		const type = o.type ?? 'volume'
		if (type === 'bind') {
			const src = str(o.source)
			if (!src) add(s, 'bind', 'bind mount without a source')
			else checkBindSource(src, s, 'bind mount', o.read_only === true || o.read_only === 'true')
		} else if (type !== 'volume' && type !== 'tmpfs') {
			add(s, 'volume', `volume type "${type}" is not allowed`)
		}
	}
}

function checkEnvFiles(v: unknown, s: SvcCtx, key: string) {
	for (const e of asList(v)) {
		const p = typeof e === 'string' ? e : str((e as { path?: unknown })?.path)
		if (!p) {
			add(s, 'env_file', `unreadable ${key} entry`)
			continue
		}
		if (p.includes('$')) {
			add(
				s,
				'env_file',
				`${key} "${p}" is built from a variable; powder cannot check where it points, write the path literally`,
			)
			continue
		}
		// powder's own env files, before any other rule
		const pa = absPath(p, s.ctx)
		if (pa && powderEnvFileHit(pa, s.ctx.powderEnvFile === undefined ? process.env.POWDER_ENV_FILE : s.ctx.powderEnvFile)) {
			add(s, 'env_file', `${key} "${p}" is powder's own env file`)
			continue
		}
		// never in a folder a container can write (the writable set, the twin of
		// the on-server env file guard): a process there could swap the file for a link to
		// another app's env file right before compose (root) reads it.
		const wHit = pa ? (s.ctx.writableFolders ?? []).find((w) => under(posix.dirname(posix.normalize(pa)), w)) : undefined
		if (wHit) {
			add(
				s,
				'env_file',
				`${key} "${p}" sits in ${wHit}, a folder a container can write (a writable bind, or a named volume bound to that folder, of this compose or of a container of any compose project on the server in any state): a process there could swap the file for a link to another app's env file right before compose reads it. Mount that folder read-only, or keep the env file outside it (e.g. /opt/apps/${s.ctx.appName}.env)`,
			)
			continue
		}
		if (insideApp(p, s.ctx)) {
			// Inside the app dir is fine unless it is the deploy key.
			if (absPath(p, s.ctx)?.endsWith('/.deploy-key'))
				add(s, 'env_file', `${key} "${p}" is the deploy key`)
			continue
		}
		const a = absPath(p, s.ctx)
		const extra = (s.ctx.extraEnvFiles ?? []).map((f) => posix.normalize(f))
		if (a && extra.includes(a)) continue
		const m = a?.match(/^\/opt\/apps\/([A-Za-z0-9._-]+)\.env$/)
		const owner = m?.[1]
		if (owner && envFileOwnerAllowed(owner, s.ctx, s.containerNames)) continue
		add(
			s,
			'env_file',
			`${key} "${p}" is not this app's env file (allowed: a file under the app directory, /opt/apps/${s.ctx.appName}.env, /opt/apps/${s.ctx.appName}-*.env / _* / .*, or /opt/apps/<container>.env for a container_name of this compose that no other app or preview owns)`,
		)
	}
}

/** Canonical image ref, so `docker.io/library/postgres:16`, `index.docker.io/postgres:16`
 *  and `postgres:16` compare equal: strip the Docker Hub registry and `library/`, add
 *  `:latest` when there is no tag (a digest-only ref keeps no tag). */
export function normImage(ref: string): string {
	let r = ref.trim()
	let digest = ''
	const at = r.indexOf('@')
	if (at !== -1) {
		digest = r.slice(at)
		r = r.slice(0, at)
	}
	const parts = r.split('/')
	if (
		parts.length > 1 &&
		/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)$/i.test(parts[0] ?? '')
	)
		parts.shift()
	if (parts.length > 1 && parts[0] === 'library') parts.shift()
	let out = parts.join('/')
	if (!digest && !(parts[parts.length - 1] ?? '').includes(':')) out = `${out}:latest`
	return `${out}${digest}`
}

/** True when a canonical ref names an official Docker Hub image (no namespace), the
 *  kind other apps and the test gate run (`node:22-alpine`, `postgres:16`). */
function imageRepo(ref: string): string {
	const name = normImage(ref).split('@')[0] ?? ''
	return name.replace(/:[^/:]*$/, '')
}

function libraryLooking(ref: string): boolean {
	return !imageRepo(ref).includes('/')
}

/** The image name starts with the app name (`myapp`, `myapp-web`). */
function appPrefixed(ref: string, s: SvcCtx): boolean {
	const repo = imageRepo(ref)
	const p = s.ctx.appName
	return repo === p || (repo.startsWith(p) && /[-_.]/.test(repo[p.length] ?? ''))
}

/** a service that BUILDS an image must not name it like an official
 *  image (`node:22-alpine`, `postgres:16`): the local tag would shadow the real one
 *  for every other app and for the test gate. Own code (image_name), WARN by default
 *  at deploy like every rule, refused with POWDER_COMPOSE_GUARD=enforce. */
function checkBuiltImageName(ref: string, s: SvcCtx, what: string): boolean {
	// a local `docker/dockerfile:1` (or any docker/ or moby/ image) is used
	// as the BuildKit frontend or helper of every later build on the server, powder's
	// own included; a local `powder` / `powder-worker` tag is what powder runs.
	const repo = imageRepo(ref).toLowerCase()
	if (
		repo.startsWith('docker/') ||
		repo.startsWith('moby/') ||
		((RESERVED_CONTAINER_NAMES.includes(repo) ||
			repo.startsWith('powder-') ||
			repo.startsWith('powder_')) &&
			// the app name only: the compose project name is the repo's to choose
			repo !== s.ctx.appName.toLowerCase() &&
			!repo.startsWith(`${s.ctx.appName.toLowerCase()}-`))
	) {
		add(
			s,
			'image_name',
			`${what} "${ref}" is built here but is named like a Docker / BuildKit image or a powder image; name it after the app (${s.ctx.appName}-<name>)`,
		)
		return false
	}
	if (libraryLooking(ref) && !appPrefixed(ref, s)) {
		add(
			s,
			'image_name',
			`${what} "${ref}" is built here but looks like an official Docker Hub image; name it after the app (${s.ctx.appName}-<name>)`,
		)
		return false
	}
	return true
}

/** a service that does NOT build may still run another app's locally built
 *  image (`victim:latest`, `victim-web:deploy-12`) and with it that app's code and
 *  build-time secrets. Refused when the image is named after another powder app on
 *  the server (exactly, or `<other>-...` / `<other>_...` when it is not also named
 *  after this app). Also refused (code `image`), digest pin or not: an image
 *  another project built on the server (ctx.foreignBuiltImages, by repository), and a ref
 *  whose full repo or last path segment is exactly another app's name. Otherwise a
 *  digest pin (`@sha256:`) passes. */
function checkSiblingImage(ref: string, s: SvcCtx) {
	const r = ref.trim()
	// A bare image ID (`sha256:<id>` or its hex) names a LOCAL image whose owner
	// cannot be told from the ref: refused.
	if (/^sha256:[0-9a-f]+$/i.test(r) || /^[0-9a-f]{12,64}$/i.test(r)) {
		add(
			s,
			'image_foreign',
			`image "${ref}" is a local image ID; use a named image this app builds, or a registry image pinned by digest (image@sha256:...)`,
		)
		return
	}
	const digestPinned = /@sha256:[0-9a-f]{64}$/i.test(r)
	const repo = imageRepo(ref).toLowerCase()
	if (!digestPinned) {
		const own = [s.ctx.appName.toLowerCase()]
		const others = (s.ctx.otherApps ?? [])
			.map((n) => n.toLowerCase())
			.filter((n) => n && !own.includes(n))
		// The image is another project's compose-default build name (`<project>-<service>`).
		const projectImage = (s.ctx.foreignProjectImages ?? []).find((n) => n.toLowerCase() === repo)
		// Longest app name the image is named after (exactly, or `<name>-` / `<name>_`):
		// an image `api-v2-web` belongs to the app `api-v2`, not to `api`.
		const named = [...own.map((n) => ({ n, mine: true })), ...others.map((n) => ({ n, mine: false }))]
			.filter(({ n }) => repo === n || repo.startsWith(`${n}-`) || repo.startsWith(`${n}_`))
			.sort((a, b) => b.n.length - a.n.length)[0]
		const owner = projectImage ?? (named && !named.mine ? named.n : undefined)
		if (owner) {
			add(
				s,
				'image_foreign',
				`image "${ref}" is named after ${projectImage ? 'the compose project image' : 'the app'} ${owner} on this server (its locally built image); build your own image, or use a registry image pinned by digest (image@sha256:...)`,
			)
			return
		}
	}
	// an image another project built on this server (another app's main image, or
	// one compose built for another project), compared by repository so pull_policy,
	// another tag or a digest pin cannot reach it either. A public base image several
	// apps run (a pgvector DB) is not in that list.
	const builtRepos = new Set((s.ctx.foreignBuiltImages ?? []).map((i) => imageRepo(i).toLowerCase()))
	if (builtRepos.has(repo)) {
		add(
			s,
			'image',
			`image "${ref}" is an image another app on this server built (its code and build-time secrets); build your own image, or use a registry image no other app on this server builds`,
		)
		return
	}
	// the exact owner rule of built images (builtImageOwner: the full repo or its
	// last path segment is another registered app's name, `ghcr.io/<org>/<other>`), for
	// digest pins too. The app's own name (`ghcr.io/<org>/<app>`) passes.
	const exactOwner = builtImageOwner(ref, s)
	if (exactOwner) {
		add(
			s,
			'image',
			`image "${ref}" is named after the app ${exactOwner} on this server (its image); build your own image, or use a registry image named after nobody on this server`,
		)
		return
	}
	// compose pulls as root, with root's registry logins. On a registry root is
	// logged in to, a private repo of another project (built on another server, so no rule
	// above knows it) would be pulled with those credentials: only the app's own repo
	// (last path segment = the app name) passes, also when a service here builds that name.
	const loginHost = loginRegistryForeign(ref, s.ctx.appName, loginHostsOf(s.ctx))
	if (loginHost)
		add(
			s,
			'image',
			`image "${ref}" is on ${loginHost}, a registry root is logged in to on this server, and is not this app's (its last path segment is not "${s.ctx.appName.toLowerCase()}"; a name a service here builds does not count); root's login would pull another project's private image. Use ${loginHost}/<org>/${s.ctx.appName.toLowerCase()}, or a public image`,
		)
}

/** pull policies that never pull a service that has a build section (compose
 *  builds it when the image is missing, or always for `build`). Any other policy
 *  (always, daily, weekly, refresh, every_<d>) makes compose PULL the service's `image:`
 *  as root, with root's registry logins, and run it: checkSiblingImage (the login rule)
 *  runs only for services without a build. */
const BUILD_SAFE_PULL_POLICIES: ReadonlySet<string> = new Set(['missing', 'if_not_present', 'never', 'build'])

function checkBuildPullPolicy(v: unknown, s: SvcCtx): void {
	if (v === undefined || v === null) return
	const p = typeof v === 'string' ? v.trim() : JSON.stringify(v)
	if (p === '' || BUILD_SAFE_PULL_POLICIES.has(p)) return
	add(
		s,
		'pull_policy',
		`pull_policy "${p}" on a service with a build section is not allowed: compose would pull its image (with root's registry logins) instead of building it. Remove pull_policy, or use missing, never or build`,
		p,
	)
}

/** what the Dockerfile image check (build-cache.ts, on the server) compares every
 *  FROM / COPY --from / RUN --mount from= image ref against: the SAME inputs
 *  checkSiblingImage uses for a service's image. `foreign`: canonical repos (imageRepo,
 *  lowercase) of images other projects built on the server (foreignBuiltImages) and other
 *  projects' compose-default build names (foreignProjectImages); `others`: the other
 *  registered apps and previews (lowercase); `self`: the app. Only names made of
 *  `[a-z0-9._/:-]` are kept (they go into shell words). */
export interface DockerfileImageAuthority {
	self: string
	foreign: string[]
	others: string[]
	/** registry hosts root is logged in to (loginHostsOf). The build server adds its
	 *  own (dockerfileAuthorityShell reads root's docker config there too). */
	loginHosts?: string[]
	/** the canonical repos this compose builds that the app OWNS (ownedBuildRepos).
	 *  The on-server check (DFR_OWNED) exempts a ref as "own" only when its repo is in this
	 *  list AND the server's build list names it (DFR_OWN). Undefined: no config was given
	 *  (the server's build list alone decides, the older rule). */
	owned?: string[]
}

export function dockerfileImageAuthority(ctx: ComposeGuardContext, config?: unknown): DockerfileImageAuthority {
	const ok = (x: string) => /^[a-z0-9._/:-]+$/.test(x)
	const self = ctx.appName.toLowerCase()
	const foreign = [
		...(ctx.foreignBuiltImages ?? []).map((i) => imageRepo(i).toLowerCase()),
		...(ctx.foreignProjectImages ?? []).map((i) => imageRepo(i).toLowerCase()),
	]
	const others = (ctx.otherApps ?? []).map((n) => n.toLowerCase()).filter((n) => n && n !== self)
	return {
		self: ok(self) ? self : '',
		foreign: [...new Set(foreign.filter(ok))],
		others: [...new Set(others.filter(ok))],
		loginHosts: [...new Set(loginHostsOf(ctx).map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.:-]+$/.test(h)))],
		...(config !== undefined ? { owned: ownedBuildRepos(config, ctx).filter(ok) } : {}),
	}
}

/** the reason a Dockerfile image ref is another app's image on this server, or null.
 *  The same rules as a service image (checkSiblingImage): a local image ID; a repo another
 *  project built or a compose-default build name of another project (any tag or digest);
 *  a repo whose full name or last path segment IS another app's name (any pin); without
 *  a digest pin also `<other>-<x>` / `<other>_<x>`, where the longest matching app name
 *  (this app included) decides. Stage names never reach this (the Dockerfile parser drops
 *  them). Mirrored in shell by DFR_FOREIGN_AWK (build-cache.ts); a test keeps them equal. */
export function dockerfileImageForeign(ref: string, a: DockerfileImageAuthority): string | null {
	const r = ref.trim().toLowerCase()
	if (/^sha256:[0-9a-f]+$/.test(r) || /^[0-9a-f]{12,64}$/.test(r)) return 'a local image ID'
	// a private registry root is logged in to: only the app's own repo (last
	// path segment = the app). The shell runs this branch for this app's own
	// built images too (dfr_own exempts only the local-image rules). Checked before
	// the local-image rules, so a ref that is both (another app's name on ghcr.io) gets
	// the every-mode refusal, not a warn-mode WARN.
	const host = loginRegistryForeign(r, a.self, a.loginHosts ?? [])
	if (host) return `an image on ${host}, where root is logged in, not named after this app`
	const digest = /@sha256:[0-9a-f]+$/.test(r)
	const repo = imageRepo(r).toLowerCase()
	const last = repo.split('/').pop() ?? repo
	if (a.foreign.includes(repo)) return 'an image another project built on this server'
	const exact = a.others.find((o) => o === repo || o === last)
	if (exact) return `named after the app ${exact} on this server`
	if (!digest) {
		const best = [{ n: a.self, mine: true }, ...a.others.map((n) => ({ n, mine: false }))]
			.filter(({ n }) => n && (repo === n || repo.startsWith(`${n}-`) || repo.startsWith(`${n}_`)))
			.sort((x, y) => y.n.length - x.n.length)[0]
		if (best && !best.mine) return `named after the app ${best.n} on this server`
	}
	return null
}

/** the registered app a built image name belongs to: an app whose name IS the
 *  full repo or its last path segment (`victim`, `ghcr.io/acme/victim`,
 *  `registry:5000/victim`), or another project's compose-default build name. Exact only:
 *  images often share a prefix with another app's name (`<app>-<thing>`) without
 *  being that app's image, so a prefix is never an owner here (the image another app's
 *  containers actually use is caught by the foreign-ref check). Undefined when no other
 *  app owns the name. */
function builtImageOwner(ref: string, s: SvcCtx): string | undefined {
	const repo = imageRepo(ref).toLowerCase()
	const last = repo.split('/').pop() ?? repo
	const own = s.ctx.appName.toLowerCase()
	const names = new Set([repo, last])
	const other = (s.ctx.otherApps ?? [])
		.map((n) => n.toLowerCase())
		.find((n) => n && n !== own && names.has(n))
	if (other) return other
	return (s.ctx.foreignProjectImages ?? []).find((n) => names.has(n.toLowerCase()))
}

/** a name a service BUILDS (image: next to build:, build.tags) is written to the
 *  server's local image store, so it must not take a name another app runs (any container
 *  state), one named after another registered app, or powder's `:deploy-*` rollback
 *  tags. Code `image` (high: WARN on an unchanged compose, refused on a change). */
function checkBuiltImageOwner(ref: string, s: SvcCtx, what: string): boolean {
	const n = normImage(ref)
	const tag = (n.split('@')[0] ?? '').match(/:([^/:]+)$/)?.[1] ?? ''
	if (/^deploy-/i.test(tag)) {
		add(s, 'image', `${what} "${ref}" uses a :deploy-* tag; those are powder's rollback images, a build must not overwrite one`)
		return false
	}
	const foreign = new Set([...(s.ctx.foreignImages ?? []), ...(s.ctx.foreignImagesAnyState ?? [])].map(normImage))
	if (foreign.has(n)) {
		add(s, 'image', `${what} "${ref}" is the image of another app on this server`)
		return false
	}
	const owner = builtImageOwner(ref, s)
	if (owner) {
		add(
			s,
			'image',
			`${what} "${ref}" is the name of the app ${owner} on this server (its image); a build here would replace that app's local image. Name it after this app or anything no other app uses`,
		)
		return false
	}
	return true
}

/** the image ownership authority (image-ownership.ts) for a name this compose
 *  BUILDS: another project built or runs that repo, another app's Dockerfile on the server
 *  reads it, or it is a Docker Hub namespace name not named after this app. Code
 *  `image_owner`, high, never exemptable. True when the name passes. */
function checkBuiltImageOwnership(ref: string, s: SvcCtx, what: string): boolean {
	const why = imageOwnershipRefusal(ref, { appName: s.ctx.appName, project: s.project }, s.ctx.serverImages)
	if (!why) return true
	add(
		s,
		'image_owner',
		`${what} "${ref}" cannot be built here: ${why}. A build writes that name into the server's shared image store; name the image after this app (${s.ctx.appName}-<name>, or <registry>/<org>/${s.ctx.appName.toLowerCase()})`,
	)
	return false
}

/** the names this compose builds (a build service's `image:` or its compose
 *  default `<project>-<service>`, and its build.tags), as written. */
function builtImageRefs(config: unknown, appName: string): string[] {
	const doc = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>
	const project = str(doc.name) ?? composeProjectNameFor(appName)
	const services = (doc.services && typeof doc.services === 'object' ? doc.services : {}) as Record<string, unknown>
	const out: string[] = []
	for (const [svc, raw] of Object.entries(services)) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
		const def = raw as Record<string, unknown>
		if (def.build === undefined) continue
		out.push(str(def.image) ?? `${project}-${svc}`)
		const b = def.build
		if (b && typeof b === 'object' && !Array.isArray(b))
			for (const t of asList((b as Record<string, unknown>).tags)) if (typeof t === 'string') out.push(t)
	}
	return out
}

/** the canonical repos of the names this compose builds that the app OWNS on the
 *  server (ownedImageRepos). The on-server Dockerfile check exempts only these (DFR_OWNED). */
export function ownedBuildRepos(config: unknown, ctx: ComposeGuardContext): string[] {
	return ownedImageRepos(builtImageRefs(config, ctx.appName), { appName: ctx.appName, project: composeProjectNameFor(ctx.appName) }, ctx.serverImages)
}

// build paths reach the deploy script (preflight, cache rewrite) as data, so
// they are held to a path-safe charset; the deploy script refuses the same set on the
// server (script.ts "preflight build-context").
const BUILD_PATH_SAFE = /^[A-Za-z0-9._/-]+$/
function checkBuildPathChars(what: string, p: string, s: SvcCtx) {
	if (!BUILD_PATH_SAFE.test(p))
		add(
			s,
			'build',
			`${what} "${p}" contains a character outside [A-Za-z0-9._/-]; rename the directory/file to use only letters, digits, '.', '_', '-' and '/'`,
		)
}

function checkBuild(v: unknown, s: SvcCtx) {
	if (typeof v === 'string') {
		if (!insideApp(v, s.ctx)) add(s, 'build', `build context "${v}" is outside the app directory`)
		else checkBuildPathChars('build context', v, s)
		return
	}
	if (!v || typeof v !== 'object') return add(s, 'build', 'unreadable build section')
	const b = v as Record<string, unknown>
	const allowed = new Set([
		'context',
		'dockerfile',
		'dockerfile_inline',
		'args',
		'target',
		'labels',
		'shm_size',
		'extra_hosts',
		'cache_from',
		'cache_to',
		'no_cache',
		'pull',
		'platforms',
		'secrets',
		'additional_contexts',
		'network',
		'tags',
		'ulimits',
	])
	// no build extension keys either (`x-bake` feeds `docker buildx bake`, and
	// an `x-*` key is never needed by `docker compose build`).
	for (const k of Object.keys(b)) {
		if (!allowed.has(k)) add(s, 'build', `build.${k} is not allowed`)
	}
	const ctxPath = str(b.context) ?? '.'
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ctxPath) || ctxPath.startsWith('git@'))
		add(s, 'build', `build.context "${ctxPath}" must be a directory of the app, not a URL`)
	else if (!insideApp(ctxPath, s.ctx))
		add(s, 'build', `build.context "${ctxPath}" is outside the app directory`)
	else checkBuildPathChars('build.context', ctxPath, s)
	// a relative dockerfile is read from the context dir by powder's rewrite
	// (as root) and by the build; `../` must not climb out of the app.
	const df = str(b.dockerfile)
	if (df) {
		const full = df.startsWith('/') ? df : posix.join(ctxPath, df)
		if (df.split('/').includes('..') || !insideApp(full, s.ctx))
			add(s, 'build', `build.dockerfile "${df}" is outside the app directory`)
		else checkBuildPathChars('build.dockerfile', df, s)
	}
	if (
		b.network !== undefined &&
		b.network !== null &&
		b.network !== 'default' &&
		b.network !== 'none'
	)
		add(s, 'build', `build.network "${String(b.network)}" is not allowed`)
	checkLabels(b.labels, s, 'build label')
	// BUILDKIT_SYNTAX selects the BuildKit frontend like `# syntax=`; a custom
	// frontend gets the whole context and need not honour .dockerignore.
	const argKeys = Array.isArray(b.args)
		? b.args.map((a) => String(a).split('=')[0] ?? '')
		: Object.keys((b.args as Record<string, unknown>) ?? {})
	// a value for BuildKit's automatic platform ARGs makes a FROM resolve another
	// variant than the one powder inspected. Never exemptable.
	for (const k of argKeys)
		if (/^(BUILD|TARGET)(PLATFORM|OS|ARCH|VARIANT|OSVERSION)$/i.test(k.trim()))
			add(s, 'platform', `build.args ${k.trim()} is not allowed (powder checks the base image variant of this server's platform)`, `build.args.${k.trim()}`)
	if (argKeys.some((k) => k.trim().toUpperCase() === 'BUILDKIT_SYNTAX'))
		add(s, 'build', 'build.args BUILDKIT_SYNTAX is not allowed (it selects a custom BuildKit frontend); use # syntax=docker/dockerfile:<version> in the Dockerfile')
	for (const [name, val] of Object.entries(
		(b.additional_contexts as Record<string, unknown>) ?? {},
	)) {
		const p = String(val)
		if (/^service:/.test(p) && s.services.has(p.slice(8))) continue
		if (/^[a-z][a-z0-9+.-]*:/i.test(p) || !insideApp(p, s.ctx))
			add(s, 'build', `build.additional_contexts.${name} "${p}" must be a directory of the app`)
		else checkBuildPathChars(`build.additional_contexts.${name}`, p, s)
	}
	// no build cache import or export at all. A cache_to (any type) is exported
	// as root with root's registry logins (type=registry pushes to any repo they reach),
	// and a cache_from reads layers from a registry with them.
	for (const c of asList(b.cache_to))
		add(s, 'build', `build.cache_to "${String(c)}" is not allowed (the build would export its cache as root, with root's registry logins)`)
	for (const c of asList(b.cache_from))
		add(s, 'build', `build.cache_from "${String(c)}" is not allowed (the build would import a cache as root, with root's registry logins)`)
	// build.platforms builds other variants of the base images than the one
	// powder inspected; build.pull re-resolves every FROM from its registry after the
	// check. Both never exemptable.
	if (asList(b.platforms).length > 0)
		add(s, 'platform', `build.platforms is not allowed (powder checks the base image variant of this server's platform only)`, 'build.platforms')
	if (b.pull !== undefined && b.pull !== null && b.pull !== false && b.pull !== 'false')
		add(s, 'build_pull', `build.pull is not allowed (it re-resolves every FROM from its registry after powder checked it; POWDER_BUILD_PULL decides pulls)`, 'build.pull')
	// a local build cache (`type=local`, any case, or any entry with a `src=` /
	// `dest=` key in any case: buildx lower-cases keys) reads and writes a host path as
	// root. Refused outright (also by the rule above).
	for (const c of [...asList(b.cache_from), ...asList(b.cache_to)]) {
		if (typeof c !== 'string') {
			add(s, 'build', 'a build cache entry is not a string')
			continue
		}
		if (localCacheEntry(c)) add(s, 'build', `build cache "${c}" is a local cache (type=local / src= / dest=); local build caches are not allowed`)
	}
	checkUlimits(b.ulimits, s, 'build.ulimits')
	for (const t of asList(b.tags)) {
		if (typeof t !== 'string') continue
		if (checkBuiltImageOwner(t, s, 'build.tags')) {
			checkBuiltImageName(t, s, 'build.tags')
			// also when image_name fired (that code is exemptable, this one is not)
			checkBuiltImageOwnership(t, s, 'build.tags')
		}
	}
}

/** a buildx cache spec that names a local (host path) cache: `type=local` in
 *  any case, or any `src=` / `dest=` key in any case. Quotes and blanks are dropped
 *  first (buildx reads the entry as CSV). Pure; COMPOSE_JSON_MOUNTS_AWK has the same rule. */
export function localCacheEntry(entry: string): boolean {
	const t = entry.toLowerCase().replace(/["'\s]/g, '')
	return /(^|,)type=local(,|$)/.test(t) || /(^|,)(src|dest)=/.test(t)
}

/** lifecycle hooks (`post_start`, `pre_stop`) run as `docker exec` in the
 *  container. `privileged: true` there hands the hook every capability the service
 *  itself may not have; the other keys are allow-listed like a service's (the hook
 *  `user` gets the same rule as the service `user`: any user inside the container). */
const HOOK_KEYS = new Set(['command', 'user', 'privileged', 'working_dir', 'environment'])
function checkHooks(v: unknown, s: SvcCtx, key: string) {
	for (const h of asList(v)) {
		if (!h || typeof h !== 'object' || Array.isArray(h)) {
			add(s, 'unknown_key', `${key} entry is not a mapping`)
			continue
		}
		for (const [k, val] of Object.entries(h as Record<string, unknown>)) {
			if (k === 'privileged') {
				// Any value docker could read as true (true, 1, "yes", "on"): only an
				// explicit false-like value passes.
				if (!(val === false || val === null || /^(false|0|no|off|)$/i.test(String(val).trim())))
					add(s, 'privileged', `${key} hook "privileged" is not allowed`)
			} else if (k === 'user') {
				if (typeof val !== 'string' && typeof val !== 'number')
					add(s, 'unknown_key', `${key} hook user must be a string`)
			} else if (!HOOK_KEYS.has(k) && !k.startsWith('x-'))
				add(s, 'unknown_key', `${key} hook "${k}" is not on powder's compose allow-list`)
		}
	}
}

/** host ports no app may publish (ssh, http, https of the server). */
const RESERVED_HOST_PORTS: readonly number[] = [22, 80, 443]

/** one published host port range of a service, from the long form (resolved
 *  config: `{ host_ip, published, target, protocol }`) or the short form
 *  (`[ip:]host:container[/proto]`, `[::1]:host:container`). null: no host port (only a
 *  container port: docker picks a free one). 'bad': unreadable. */
export function publishedPorts(
	p: unknown,
): { hostIp: string; from: number; to: number; protocol: string } | null | 'bad' {
	const range = (v: string): [number, number] | null => {
		const m = v.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/)
		if (!m) return null
		const a = Number(m[1])
		const b = m[2] === undefined ? a : Number(m[2])
		return a >= 0 && b >= a && b <= 65535 ? [a, b] : null
	}
	if (typeof p === 'number') return null
	if (p && typeof p === 'object' && !Array.isArray(p)) {
		const o = p as { host_ip?: unknown; published?: unknown; protocol?: unknown }
		if (o.published === undefined || o.published === null || o.published === '') return null
		const r = range(String(o.published))
		if (!r) return 'bad'
		return {
			hostIp: o.host_ip === undefined || o.host_ip === null ? '' : String(o.host_ip),
			from: r[0],
			to: r[1],
			protocol: o.protocol ? String(o.protocol).toLowerCase() : 'tcp',
		}
	}
	if (typeof p !== 'string') return 'bad'
	let rest = p.trim()
	let protocol = 'tcp'
	const slash = rest.lastIndexOf('/')
	if (slash !== -1) {
		protocol = rest.slice(slash + 1).toLowerCase()
		rest = rest.slice(0, slash)
	}
	let hostIp = ''
	const v6 = rest.match(/^\[([^\]]*)\]:(.*)$/)
	if (v6) {
		hostIp = v6[1] ?? ''
		rest = v6[2] ?? ''
	}
	const parts = rest.split(':')
	if (parts.length === 1) return range(parts[0] ?? '') ? null : 'bad'
	if (parts.length === 3 && !v6) hostIp = parts.shift() ?? ''
	if (parts.length !== 2) return 'bad'
	if (parts[0] === '') return null
	const r = range(parts[0] ?? '')
	if (!r) return 'bad'
	return { hostIp, from: r[0], to: r[1], protocol }
}

function wildcardIp(ip: string): boolean {
	return ip === '' || ip === '0.0.0.0' || ip === '::' || ip === '[::]'
}

/** a published host port in RESERVED_HOST_PORTS, or one (same protocol, same
 *  host_ip or either bound to every address) another compose project's container on
 *  the server publishes in any state. */
function checkPorts(v: unknown, s: SvcCtx) {
	for (const p of asList(v)) {
		const pp = publishedPorts(p)
		if (pp === null) continue
		if (pp === 'bad') {
			add(s, 'ports', `ports entry ${JSON.stringify(p)} is not readable`)
			continue
		}
		const reserved = RESERVED_HOST_PORTS.find((r) => r >= pp.from && r <= pp.to)
		if (reserved !== undefined) {
			add(s, 'ports', `host port ${reserved} is reserved for the server (ssh, http, https); publish another port`)
			continue
		}
		const hit = (s.ctx.foreignPorts ?? []).find(
			(f) =>
				f.port >= pp.from &&
				f.port <= pp.to &&
				(f.protocol || 'tcp') === pp.protocol &&
				(wildcardIp(f.hostIp) || wildcardIp(pp.hostIp) || f.hostIp === pp.hostIp),
		)
		if (hit)
			add(
				s,
				'ports',
				`host port ${hit.port}/${pp.protocol} is published by ${hit.owner}, a container of another app on this server; publish another port`,
			)
	}
}

/** ulimits a container may set, each a finite non-negative value up to a cap
 *  (no `unlimited` / -1); rtprio, nice, rttime and the rest are refused. */
const ULIMIT_CAPS: Readonly<Record<string, number>> = {
	nofile: 1048576,
	nproc: 1048576,
	core: 1073741824,
	stack: 1073741824,
	memlock: 1073741824,
}

function checkUlimits(v: unknown, s: SvcCtx, where = 'ulimits') {
	if (v === undefined || v === null) return
	if (typeof v !== 'object' || Array.isArray(v)) return add(s, 'ulimits', `${where} is not a mapping`)
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		const cap = ULIMIT_CAPS[k]
		if (cap === undefined) {
			add(s, 'ulimits', `${where}.${k} is not allowed (only ${Object.keys(ULIMIT_CAPS).join(', ')})`)
			continue
		}
		const vals =
			val && typeof val === 'object' && !Array.isArray(val)
				? [(val as { soft?: unknown }).soft, (val as { hard?: unknown }).hard]
				: [val]
		for (const x of vals) {
			const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x.trim()) ? Number(x) : Number.NaN
			if (!Number.isInteger(n) || n < 0 || n > cap)
				add(s, 'ulimits', `${where}.${k} ${JSON.stringify(x)} must be a whole number from 0 to ${cap} (no unlimited)`)
		}
	}
}

/** pids_limit / deploy.resources.limits.pids <= 0 means no limit (a fork bomb
 *  takes the server). */
function checkPidsLimit(v: unknown, s: SvcCtx, where: string) {
	if (v === undefined || v === null) return
	const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : Number.NaN
	if (!Number.isInteger(n) || n <= 0)
		add(s, 'pids_limit', `${where} ${JSON.stringify(v)} is not allowed (0 or less means unlimited); set a positive limit or leave it out`)
}

/** `scale` / `deploy.replicas` above a small number fill the server with copies
 *  of the container (memory, pids, ports). Ordinary apps need neither. */
export const MAX_SCALE = 10
function checkScale(v: unknown, s: SvcCtx, where: string) {
	if (v === undefined || v === null) return
	const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : Number.NaN
	if (!Number.isInteger(n) || n < 0 || n > MAX_SCALE)
		add(s, 'scale', `${where} ${JSON.stringify(v)} is not allowed (at most ${MAX_SCALE})`)
}

/** per-network keys of a service. Fixed addresses (ipv4_address, ipv6_address,
 *  link_local_ips, mac_address) and driver_opts let a container take an address other
 *  containers or the host route to; only these keys are allowed. */
const SERVICE_NETWORK_KEYS = new Set(['aliases', 'priority', 'gw_priority', 'interface_name'])
function checkServiceNetworks(v: unknown, s: SvcCtx) {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return
	for (const [net, cfg] of Object.entries(v as Record<string, unknown>)) {
		if (cfg === null || cfg === undefined) continue
		if (typeof cfg !== 'object' || Array.isArray(cfg)) {
			add(s, 'network_address', `networks.${net} is not a mapping`)
			continue
		}
		for (const k of Object.keys(cfg as Record<string, unknown>)) {
			if (k.startsWith('x-') || SERVICE_NETWORK_KEYS.has(k)) continue
			add(
				s,
				'network_address',
				`networks.${net}.${k} is not allowed (a fixed address or driver option on a network; only ${[...SERVICE_NETWORK_KEYS].join(', ')})`,
			)
		}
	}
}

/** a container_name that a registered app on this server owns: its name or
 *  `<name>-db`. Never this app's own name or `<app>-db`, and never a container that
 *  runs in this compose project right now (sibling services registered as their own
 *  apps, a shared stack). */
/** a container name, hostname, service key or network alias. Anything else
 *  (a newline, `;`, `=`, `,`) could frame the line-based probes powder parses, or
 *  another container, and a normal compose has no use for one. High, on any network. */
const SAFE_DNS_NAME = /^[A-Za-z0-9._-]+$/

/** docker DNS answers names case-insensitively, so every taken / reserved /
 *  other-app name comparison (container_name, service keys, aliases) lowercases both
 *  sides. */
function lcName(x: string): string {
	return x.toLowerCase()
}

/** `n` (any case) is in `list` (any case). */
function nameIn(list: readonly string[], n: string): boolean {
	const l = lcName(n)
	return list.some((x) => lcName(x) === l)
}

/** a powder name (RESERVED_CONTAINER_NAMES) in any case that is not the app's own. */
function reservedName(n: string, ctx: ComposeGuardContext): boolean {
	return nameIn(RESERVED_CONTAINER_NAMES, n) && lcName(n) !== lcName(ctx.appName)
}

/** the name fields of the context, lowercased (for otherAppName). */
function lowerNameCtx(ctx: ComposeGuardContext): ComposeGuardContext {
	return {
		...ctx,
		appName: lcName(ctx.appName),
		otherApps: (ctx.otherApps ?? []).map(lcName),
		ownProjectContainers: (ctx.ownProjectContainers ?? []).map(lcName),
	}
}

function otherAppName(n: string, ctx: ComposeGuardContext): boolean {
	if (n === ctx.appName || n === `${ctx.appName}-db`) return false
	if ((ctx.ownProjectContainers ?? []).includes(n)) return false
	if ((ctx.otherApps ?? []).some((o) => o === n || `${o}-db` === n)) return true
	// `<other>.<x>` / `<other>_<x>` names that other app (the longest registered
	// name decides, so `shop-api_x` stays app shop-api's). `<other>-<x>` stays free:
	// sidecars of a shared stack use it, and the env_file rule decides ownership there.
	const reg = registeredOwnerOf(n, ctx)
	return !!reg && reg !== ctx.appName && (n[reg.length] === '.' || n[reg.length] === '_')
}

const SERVICE_KEYS: Record<string, KeyRule> = {
	image: 'ok', // checked below together with build
	build: checkBuild,
	container_name: (v, s) => {
		const n = String(v)
		if (!SAFE_DNS_NAME.test(n))
			add(s, 'container_name', `container_name "${n}" may only contain letters, digits, ".", "_" and "-"`)
		else if (reservedName(n, s.ctx))
			add(s, 'container_name', `container_name "${n}" is reserved for powder`)
		else if (nameIn(s.ctx.foreignContainers ?? [], n))
			add(s, 'container_name', `container_name "${n}" is already used by another app on this server`)
		else if (otherAppName(lcName(n), lowerNameCtx(s.ctx)))
			add(
				s,
				'container_name',
				`container_name "${n}" is the name of another powder app or preview on this server (or its -db, <app>.<x>, <app>_<x>), even when that container does not run right now`,
			)
	},
	restart: 'ok',
	env_file: (v, s) => checkEnvFiles(v, s, 'env_file'),
	label_file: (v, s) => checkEnvFiles(v, s, 'label_file'),
	environment: 'ok',
	ports: checkPorts,
	expose: 'ok',
	labels: (v, s) => checkLabels(v, s),
	// OCI annotations reach the runtime (crun / runc read some, e.g.
	// run.oci.keep_original_groups); ordinary apps need none.
	annotations: DENY,
	// names checked against the top-level networks; aliases are checked per network in
	// checkAliases (against the names other projects answer on that network);
	// no fixed address or driver option per network
	networks: checkServiceNetworks,
	network_mode: (v, s) => {
		const m = String(v)
		if (m === 'none' || m === 'bridge' || m === 'default') return
		if (m.startsWith('service:') && s.services.has(m.slice(8))) return
		add(
			s,
			'network_mode',
			`network_mode "${m}" is not allowed (host, container:<x> and services outside this app share another network namespace)`,
			m,
		)
	},
	depends_on: 'ok',
	healthcheck: 'ok',
	command: 'ok',
	entrypoint: 'ok',
	working_dir: 'ok',
	user: 'ok',
	volumes: checkVolumes,
	volumes_from: (v, s) => {
		for (const e of asList(v)) {
			const n = String(e).split(':')[0] ?? ''
			if (String(e).startsWith('container:') || !s.services.has(n))
				add(s, 'volumes_from', `volumes_from "${String(e)}" is outside this app`)
		}
	},
	tmpfs: 'ok',
	mem_limit: 'ok',
	mem_reservation: 'ok',
	memswap_limit: 'ok',
	mem_swappiness: 'ok',
	cpus: 'ok',
	cpu_count: 'ok',
	cpu_percent: 'ok',
	cpu_shares: 'ok',
	cpu_quota: 'ok',
	cpu_period: 'ok',
	cpuset: 'ok',
	pids_limit: (v, s) => checkPidsLimit(v, s, 'pids_limit'),
	deploy: (v, s) => {
		const d = v as {
			resources?: { reservations?: { devices?: unknown }; limits?: { pids?: unknown } }
			labels?: unknown
		} | null
		if (d?.resources?.reservations?.devices)
			add(s, 'devices', 'deploy.resources.reservations.devices is not allowed')
		checkPidsLimit(d?.resources?.limits?.pids, s, 'deploy.resources.limits.pids')
		checkScale((d as { replicas?: unknown } | null)?.replicas, s, 'deploy.replicas')
		checkLabels(d?.labels, s, 'deploy label')
	},
	// a logging driver ships every line the app prints (secrets included) to its
	// target; syslog / gelf / fluentd / splunk / awslogs and plugins can send it to any
	// host. Local drivers only, and no option that names a remote endpoint.
	logging: (v, s) => {
		if (v === null || v === undefined) return
		if (typeof v !== 'object' || Array.isArray(v)) return add(s, 'logging', 'unreadable logging section')
		const l = v as { driver?: unknown; options?: unknown }
		const driver = l.driver === undefined || l.driver === null ? '' : String(l.driver)
		if (driver !== '' && !LOCAL_LOG_DRIVERS.includes(driver))
			add(s, 'logging', `logging.driver "${driver}" is not allowed (only ${LOCAL_LOG_DRIVERS.join(', ')})`)
		if (l.options && typeof l.options === 'object')
			for (const k of Object.keys(l.options as Record<string, unknown>))
				if (/-(address|url|host)$/i.test(k))
					add(s, 'logging', `logging.options.${k} names a remote log endpoint`)
	},
	stop_grace_period: 'ok',
	stop_signal: 'ok',
	init: 'ok',
	shm_size: 'ok',
	ulimits: (v, s) => checkUlimits(v, s),
	sysctls: 'ok',
	tty: 'ok',
	stdin_open: 'ok',
	hostname: (v, s) => {
		if (!SAFE_DNS_NAME.test(String(v)))
			add(s, 'hostname', `hostname "${String(v)}" may only contain letters, digits, ".", "_" and "-"`)
	},
	domainname: 'ok',
	extra_hosts: 'ok',
	dns: 'ok',
	dns_search: 'ok',
	dns_opt: 'ok',
	// a fixed MAC lets a container take another one's place on a bridge
	mac_address: (_v, s) => add(s, 'network_address', '"mac_address" is not allowed'),
	read_only: 'ok',
	cap_drop: 'ok',
	secrets: 'ok', // sources checked at top level
	configs: 'ok',
	// a service with an inactive profile is missing from `docker compose config`
	// (the input of every rule here) while `up --no-deps <service>` still starts it by
	// name. powder probes with `--profile '*'` now, and ordinary apps do not use profiles.
	profiles: (_v, s) =>
		add(s, 'profiles', '"profiles" is not allowed (a service behind a profile is left out of the resolved config but starts when named)'),
	// a platform other than the server's makes the build resolve another variant
	// of a base image (or the run pull one) than the one powder inspected. Never
	// exemptable.
	platform: (v, s) => {
		if (v !== undefined && v !== null)
			add(s, 'platform', `platform "${String(v)}" is not allowed (powder checks the image variant of this server's platform only)`, String(v))
	},
	pull_policy: 'ok',
	scale: (v, s) => checkScale(v, s, 'scale'),
	// a negative score makes the kernel kill other apps (or powder) first
	oom_score_adj: (v, s) => {
		const n = Number(v)
		if (v !== null && v !== undefined && (!Number.isFinite(n) || n < 0))
			add(s, 'oom', `oom_score_adj ${JSON.stringify(v)} is not allowed (only 0 or more)`)
	},
	oom_kill_disable: (v, s) => {
		if (v === true || /^(true|1|yes|on)$/i.test(String(v ?? '').trim()))
			add(s, 'oom', 'oom_kill_disable is not allowed')
	},
	group_add: 'ok',
	develop: 'ok',
	attach: 'ok',
	post_start: (v, s) => checkHooks(v, s, 'post_start'),
	pre_stop: (v, s) => checkHooks(v, s, 'pre_stop'),
	links: 'ok',
	ipc: (v, s) => {
		const m = String(v)
		if (m === '' || m === 'private' || m === 'shareable' || m === 'none') return
		if (m.startsWith('service:') && s.services.has(m.slice(8))) return
		add(s, 'ipc', `ipc "${m}" is not allowed`, m)
	},
	pid: (v, s) => {
		if (v === null || v === '') return
		add(s, 'pid', `pid "${String(v)}" is not allowed`, String(v))
	},
	uts: (v, s) => {
		if (v === null || v === '') return
		add(s, 'uts', `uts "${String(v)}" is not allowed`)
	},
	security_opt: (v, s) => {
		for (const o of asList(v)) {
			if (!/^no-new-privileges([:=]true)?$/.test(String(o)))
				add(
					s,
					'security_opt',
					`security_opt "${String(o)}" is not allowed (only no-new-privileges)`,
				)
		}
	},
	privileged: (v, s) => {
		if (v) add(s, 'privileged', '"privileged" is not allowed')
	},
	cap_add: DENY,
	devices: DENY,
	device_cgroup_rules: DENY,
	userns_mode: DENY,
	cgroup: DENY,
	cgroup_parent: DENY,
	external_links: DENY,
	gpus: DENY,
	runtime: DENY,
	isolation: DENY,
	storage_opt: DENY,
	blkio_config: DENY,
	credential_spec: DENY,
	use_api_socket: DENY,
	provider: DENY,
	extends: DENY, // only present in a raw file; the resolved config has none
}

function checkTopLevelNamed(
	kind: 'network' | 'volume',
	defs: unknown,
	project: string,
	ctx: ComposeGuardContext,
	out: ComposeViolation[],
) {
	if (!defs || typeof defs !== 'object') return
	for (const [key, raw] of Object.entries(defs as Record<string, unknown>)) {
		const d = (raw ?? {}) as {
			name?: unknown
			external?: unknown
			driver?: unknown
			driver_opts?: Record<string, unknown>
		}
		const external = d.external === true || (typeof d.external === 'object' && d.external !== null)
		const name = str(d.name) ?? (external ? key : `${project}_${key}`)
		// ownership keys on the app name, never on the compose `name:`. A
		// longer registered app name that also prefixes it wins.
		// compose writes default names with the normalised project name (`foo.com` ->
		// `foocom_data`), which is derived from the app name, never from the repo.
		const projectCtx = {
			appName: composeProjectNameFor(ctx.appName),
			otherApps: (ctx.otherApps ?? []).map(composeProjectNameFor),
			serverOwners: (ctx.serverOwners ?? []).map(composeProjectNameFor),
		}
		const own =
			ownByPrefix(name, ctx, ['-', '_']) ||
			(projectCtx.appName !== '' && ownByPrefix(name, projectCtx, ['_']))
		if (kind === 'network') {
			if (!own && !sharedNetworksFor(ctx).includes(name))
				out.push({
					code: 'network',
					message: `network "${key}" (${name}) is not this app's own network or a shared one (${sharedNetworksFor(ctx).join(', ')})`,
				})
		} else if (!own) {
			out.push({
				code: 'volume_name',
				message: `volume "${key}" (${name}) belongs to another project`,
			})
		} else {
			// a volume that already exists on the server with another compose project's
			// label is that project's data, whatever its name says.
			const lp = ctx.serverVolumeProjects?.[name]
			if (lp && lp !== composeProjectNameFor(ctx.appName))
				out.push({
					code: 'volume_name',
					message: `volume "${key}" (${name}) exists on this server and belongs to the compose project "${lp}"`,
				})
		}
		if (kind === 'volume') checkVolumeDriver(key, d, ctx, out)
		else checkNetworkDriver(key, d, out)
		// an external volume's options live only on the server. One that binds a host
		// folder (a `device` option) mounts whatever that folder is when a container starts.
		const dev = kind === 'volume' && external ? ctx.serverVolumeDevices?.[name] : undefined
		if (dev !== undefined)
			out.push({
				code: 'volume_driver',
				message: `external volume "${key}" (${name}) has the driver option device=${dev} on this server: an external volume that binds a host folder is not allowed (use a bind mount of a folder of this app instead)`,
			})
	}
}

/** a named volume's driver options can mount any host folder (`type: none,
 *  o: bind, device: /`, overlay with `lowerdir=/`, a relative device without `driver:
 *  local`). Allow-list: the driver is unset or `local`, and driver_opts is absent, a
 *  tmpfs (`type: tmpfs, device: tmpfs`, `o` without paths) or a bind of a folder of
 *  this app (`type: none`, `o` bind or rbind plus ro / rw, an absolute `device` inside
 *  the app dir or under /opt/apps/<app>-*). The on-server bind guard walks that device
 *  for symlinks (deploy/fragments.ts bindLinkGuardShell). Ordinary apps set no driver_opts. */
function checkVolumeDriver(
	key: string,
	d: { driver?: unknown; driver_opts?: Record<string, unknown> },
	ctx: ComposeGuardContext,
	out: ComposeViolation[],
) {
	const bad = (why: string) =>
		out.push({ code: 'volume_driver', message: `volume "${key}": ${why}` })
	if (d.driver !== undefined && d.driver !== null && d.driver !== 'local') {
		bad(`driver "${String(d.driver)}" is not allowed (only the local driver)`)
		return
	}
	const opts = d.driver_opts
	if (opts === undefined || opts === null) return
	if (typeof opts !== 'object' || Array.isArray(opts)) return bad('unreadable driver_opts')
	const keys = Object.keys(opts)
	if (keys.length === 0) return
	const extra = keys.filter((k) => k !== 'type' && k !== 'device' && k !== 'o')
	if (extra.length) return bad(`driver_opts.${extra[0]} is not allowed (only type, device and o)`)
	const type = String(opts.type ?? '')
	const device = opts.device === undefined || opts.device === null ? '' : String(opts.device)
	const o = opts.o === undefined || opts.o === null ? '' : String(opts.o)
	const tokens = o === '' ? [] : o.split(',').map((t) => t.trim())
	if (tokens.some((t) => t.includes('=') && t.slice(t.indexOf('=') + 1).includes('/')))
		return bad(`driver_opts.o "${o}" names a path (lowerdir, upperdir, workdir and similar are not allowed)`)
	if (type === 'tmpfs') {
		if (device !== 'tmpfs') return bad('a tmpfs volume must have device: tmpfs')
		if (tokens.some((t) => !/^[A-Za-z0-9_]+(=[A-Za-z0-9_.:+-]*)?$/.test(t)))
			return bad(`driver_opts.o "${o}" is not a plain tmpfs option list`)
		return
	}
	if (type === 'none') {
		if (!tokens.some((t) => t === 'bind' || t === 'rbind') || tokens.some((t) => !['bind', 'rbind', 'ro', 'rw'].includes(t)))
			return bad(`driver_opts.o "${o}" must be bind or rbind (plus ro or rw) for type none`)
		if (!device.startsWith('/') || device.split('/').includes('..') || device.split('/').includes('.'))
			return bad(`driver_opts.device "${device}" must be an absolute path without . or ..`)
		// The same rules as a service bind source (app dir itself, protected paths, env
		// files), plus this app's own /opt/apps/<app>-* folders (longest registered name).
		for (const m of bindSourceProblems(posix.normalize(device), ctx, `volume "${key}" driver_opts.device`, true))
			out.push({ code: 'bind', message: m, value: posix.normalize(device) })
		return
	}
	bad(`driver_opts type "${type}" is not allowed (only tmpfs, or none with o: bind)`)
}

/** a network driver other than bridge (macvlan, ipvlan, overlay, host) or any
 *  driver_opts puts the app on another layer-2 segment or reconfigures the bridge. */
function checkNetworkDriver(
	key: string,
	d: { driver?: unknown; driver_opts?: Record<string, unknown>; ipam?: unknown; enable_ipv6?: unknown },
	out: ComposeViolation[],
) {
	// a network with its own subnet / gateway (ipam config) can claim an address
	// range the host routes elsewhere (a resolver, a metadata or tailnet address), and
	// IPv6 adds routes of its own. Only `ipam: { driver: default }` with no config passes.
	const ipam = d.ipam
	if (ipam !== undefined && ipam !== null) {
		const i = ipam as { driver?: unknown; config?: unknown; options?: unknown }
		const extra =
			typeof ipam !== 'object' || Array.isArray(ipam)
				? ['(not a mapping)']
				: Object.keys(i).filter((k) => !k.startsWith('x-') && k !== 'driver' && k !== 'config')
		const configs = asList(i.config).filter((c) => !(c && typeof c === 'object' && Object.keys(c).length === 0))
		if (
			extra.length ||
			(i.driver !== undefined && i.driver !== null && i.driver !== 'default') ||
			configs.length
		)
			out.push({
				code: 'network_address',
				message: `network "${key}": ipam ${extra.length ? extra.join(', ') : 'config'} is not allowed (no own subnet, gateway, ip_range or aux_addresses; only ipam.driver: default)`,
			})
	}
	if (d.enable_ipv6 === true || /^(true|1|yes|on)$/i.test(String(d.enable_ipv6 ?? '').trim()))
		out.push({ code: 'network_address', message: `network "${key}": enable_ipv6 is not allowed` })
	if (d.driver !== undefined && d.driver !== null && d.driver !== 'bridge')
		out.push({
			code: 'network_driver',
			message: `network "${key}": driver "${String(d.driver)}" is not allowed (only bridge)`,
		})
	const opts = d.driver_opts
	if (opts && typeof opts === 'object' && Object.keys(opts).length > 0)
		out.push({ code: 'network_driver', message: `network "${key}": driver_opts are not allowed` })
}

/** The real network name a service-level network key refers to. */
function networkRealName(key: string, defs: unknown, project: string): string {
	const d = ((defs as Record<string, unknown> | undefined)?.[key] ?? {}) as {
		name?: unknown
		external?: unknown
	}
	const external = d.external === true || (typeof d.external === 'object' && d.external !== null)
	return str(d.name) ?? (external ? key : `${project}_${key}`)
}

/** a network declared `external` (created outside this project). */
function externalNetwork(key: string, defs: unknown): boolean {
	const d = ((defs as Record<string, unknown> | undefined)?.[key] ?? {}) as { external?: unknown }
	return d.external === true || (typeof d.external === 'object' && d.external !== null)
}

/** on a shared network (sharedNetworks) or an external one, a name is taken in
 *  ANY container state when another registered app or preview owns it (its name,
 *  `<other>-db`, `<other>.<x>`, `<other>_<x>`: otherAppName) or a container of another
 *  project has it as its container name: a stopped app comes back and its peers would
 *  resolve the alias first. Compared case-insensitively (docker DNS is). Other
 *  projects' compose service keys and aliases are NOT in this list (several projects
 *  with a `db` service on one external network is a common shape, not a hijack);
 *  on shared networks the running-based check covers them. */
function takenRegardlessOfState(n: string, ctx: ComposeGuardContext): boolean {
	const name = lcName(n)
	return otherAppName(name, lowerNameCtx(ctx)) || nameIn(ctx.foreignContainers ?? [], name)
}

const ANY_STATE_TAKEN =
	'is the name of another app or preview on this server, its -db, or the container name of another project (in any state)'

/** compose makes every service KEY a DNS alias on each network the
 *  service joins. On a shared network that alias must not be a powder name or a
 *  name another project's containers answer there (DNS hijack, like an alias).
 *  any network this project does not create, and the any-state names too. */
function checkServiceKeys(
	services: Record<string, unknown>,
	defs: unknown,
	project: string,
	ctx: ComposeGuardContext,
	out: ComposeViolation[],
) {
	for (const [svc, raw] of Object.entries(services)) {
		if (!SAFE_DNS_NAME.test(svc))
			out.push({
				code: 'service_key',
				service: svc,
				message: `service "${svc}": a service name may only contain letters, digits, ".", "_" and "-"`,
			})
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
		const def = raw as { networks?: unknown; network_mode?: unknown }
		if (def.network_mode !== undefined && def.network_mode !== null) continue
		const keys =
			def.networks === undefined || def.networks === null
				? ['default']
				: Array.isArray(def.networks)
					? def.networks.map(String)
					: typeof def.networks === 'object'
						? Object.keys(def.networks as object)
						: []
		checkAliases(svc, def.networks, defs, project, ctx, out)
		for (const key of keys) {
			const net = networkRealName(key, defs, project)
			const shared = sharedNetworksFor(ctx).includes(net)
			// an external network gets the any-state name check only
			if (!shared) {
				if (externalNetwork(key, defs) && takenRegardlessOfState(svc, ctx))
					out.push({
						code: 'service_key',
						service: svc,
						message: `service ${svc}: the service name is a DNS alias on the external network ${net} and "${svc}" ${ANY_STATE_TAKEN}; rename the service`,
					})
				continue
			}
			const taken = ctx.foreignNamesByNetwork
				? (ctx.foreignNamesByNetwork[net] ?? [])
				: (ctx.foreignContainers ?? [])
			if (reservedName(svc, ctx))
				out.push({
					code: 'service_key',
					service: svc,
					message: `service ${svc}: the service name is a DNS alias on the shared network ${net} and "${svc}" is reserved for powder; rename the service`,
				})
			else if (nameIn(taken, svc))
				out.push({
					code: 'service_key',
					service: svc,
					message: `service ${svc}: the service name is a DNS alias on the shared network ${net} and another app already answers "${svc}" there; rename the service`,
				})
			else if (takenRegardlessOfState(svc, ctx))
				out.push({
					code: 'service_key',
					service: svc,
					message: `service ${svc}: the service name is a DNS alias on the shared network ${net} and "${svc}" ${ANY_STATE_TAKEN}; rename the service`,
				})
		}
	}
}

/** a network alias answers DNS on its network like a container name. Refused
 *  when it is a powder name on a shared network, or a name another compose project's
 *  running container answers on that same network (its container name, compose service
 *  name or one of its aliases; deploy/compose-check.ts probes them).
 *  on a network this project does not create (shared or external), also every
 *  name of a registered app or preview (otherAppName) and every container name of
 *  another project, in any state. This project's own
 *  containers never count, so an alias on the app's own network, or one only this app
 *  answers on a shared network, passes. Without the per-network probe it falls back to
 *  the other projects' container names, on shared networks only. */
function checkAliases(
	svc: string,
	networks: unknown,
	defs: unknown,
	project: string,
	ctx: ComposeGuardContext,
	out: ComposeViolation[],
) {
	if (!networks || typeof networks !== 'object' || Array.isArray(networks)) return
	for (const [key, cfg] of Object.entries(networks as Record<string, unknown>)) {
		const net = networkRealName(key, defs, project)
		const shared = sharedNetworksFor(ctx).includes(net)
		// shared or external networks get the any-state name check
		const anyState = shared || externalNetwork(key, defs)
		const taken = ctx.foreignNamesByNetwork
			? (ctx.foreignNamesByNetwork[net] ?? [])
			: shared
				? (ctx.foreignContainers ?? [])
				: []
		for (const a of asList((cfg as { aliases?: unknown } | null)?.aliases)) {
			const n = String(a)
			if (!SAFE_DNS_NAME.test(n))
				out.push({
					code: 'network_alias',
					service: svc,
					message: `service ${svc}: network ${net}: alias "${n}" may only contain letters, digits, ".", "_" and "-"`,
				})
			else if (shared && reservedName(n, ctx))
				out.push({
					code: 'network_alias',
					service: svc,
					message: `service ${svc}: network ${net}: alias "${n}" is reserved for powder on a shared network`,
				})
			else if (nameIn(taken, n))
				out.push({
					code: 'network_alias',
					service: svc,
					message: `service ${svc}: network ${net}: alias "${n}" is a name another app already answers on that network`,
				})
			else if (anyState && takenRegardlessOfState(n, ctx))
				out.push({
					code: 'network_alias',
					service: svc,
					message: `service ${svc}: network ${net}: alias "${n}" ${ANY_STATE_TAKEN}`,
				})
		}
	}
}

function checkTopLevelFiles(
	kind: 'secret' | 'config',
	defs: unknown,
	ctx: ComposeGuardContext,
	out: ComposeViolation[],
) {
	if (!defs || typeof defs !== 'object') return
	// inside the app dir, the protected paths still count (the compose files,
	// .deploy-key, git metadata, an env file powder renders): the file, or a folder it
	// names, at or above / inside one of them. The app's own env files stay readable
	// (a build secret of the app's env, the `/opt/apps/<app>.build-env` shape).
	const ownEnv = new Set(
		[`/opt/apps/${ctx.appName}.env`, ...(ctx.envFilePaths ?? [])].map((x) => posix.normalize(x)),
	)
	const prot = (ctx.protectedPaths ?? []).map((x) => posix.normalize(x)).filter((x) => !ownEnv.has(x))
	for (const [key, raw] of Object.entries(defs as Record<string, unknown>)) {
		const f = str((raw as { file?: unknown } | null)?.file)
		if (!f) continue
		if (!insideApp(f, ctx)) {
			out.push({ code: kind, message: `${kind} "${key}" reads "${f}", outside the app directory` })
			continue
		}
		const a = posix.normalize(absPath(f, ctx) as string)
		const hit = prot.find((x) => under(x, a) || under(a, x))
		if (hit)
			out.push({ code: kind, message: `${kind} "${key}" reads "${f}", which is or holds the protected path ${hit} (compose files, .deploy-key, git metadata)` })
	}
}

const TOP_KEYS = new Set([
	'name',
	'version',
	'services',
	'networks',
	'volumes',
	'secrets',
	'configs',
])

/** the names powder's own deploy runs under: the compose service
 *  (POWDER_SELF_SERVICE, unset = no in-app self-deploy) and the container
 *  (POWDER_SELF_CONTAINER, default `powder`). */
export function selfDeployNames(env: Record<string, string | undefined> = process.env): { service: string | null; container: string } {
	const ok = (v: string | undefined) => (v && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v.trim()) ? v.trim() : null)
	return { service: ok(env.POWDER_SELF_SERVICE), container: ok(env.POWDER_SELF_CONTAINER) ?? 'powder' }
}

/** Every violation in a compose config (resolved JSON object, or a parsed raw file). */
/** every service's env_file and label_file path, absolute (relative ones resolved
 *  against the project dir). Entries built from a variable are skipped (the env_file
 *  rule refuses them). */
function envFilePathsOf(services: Record<string, unknown>, ctx: ComposeGuardContext): string[] {
	const out: string[] = []
	for (const def of Object.values(services)) {
		if (!def || typeof def !== 'object' || Array.isArray(def)) continue
		for (const k of ['env_file', 'label_file']) {
			for (const e of asList((def as Record<string, unknown>)[k])) {
				const p = typeof e === 'string' ? e : str((e as { path?: unknown } | null)?.path)
				if (!p || p.includes('$')) continue
				const a = absPath(p, ctx)
				if (a) out.push(a)
			}
		}
	}
	return out
}

/** the TypeScript twin of the on-server writable set (`pw_wset`,
 *  writableSetFnShell in deploy/fragments.ts): every folder a container can write, as
 *  absolute normalised paths (lexical: no link is resolved here, the on-server guard
 *  resolves them), sorted and unique. The union of
 *   (a) the config's writable service binds (`:ro` / `read_only` ones are left out);
 *   (b) the config's named volume `driver_opts.device` values that are absolute paths;
 *   (c) ctx.serverWritable: every compose project's containers on the server, any state
 *       (writable bind sources and the devices of the named volumes they mount writable);
 *   (d) the server copy's `device` (ctx.serverVolumeDevices) of every named volume the config
 *       declares (its docker name: `name:`, else `<project>_<key>`, an external one's key).
 *  A path built from a variable is skipped, as on the server. */
export function writableFoldersOf(config: unknown, ctx: ComposeGuardContext): string[] {
	const out = new Set<string>()
	const addPath = (p: string | null | undefined) => {
		if (!p || p.includes('$') || !p.startsWith('/')) return
		out.add(posix.normalize(p))
	}
	const doc = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
	const services = doc.services && typeof doc.services === 'object' && !Array.isArray(doc.services) ? (doc.services as Record<string, unknown>) : {}
	for (const def of Object.values(services)) {
		if (!def || typeof def !== 'object' || Array.isArray(def)) continue
		for (const vol of asList((def as Record<string, unknown>).volumes)) {
			if (typeof vol === 'string') {
				const parts = vol.split(':')
				const src = parts.length > 1 ? (parts[0] ?? '') : ''
				if (!(src.startsWith('/') || src.startsWith('.'))) continue
				if ((parts[2] ?? '').split(',').includes('ro')) continue
				addPath(src.includes('$') ? null : absPath(src, ctx))
				continue
			}
			const o = vol as { type?: unknown; source?: unknown; read_only?: unknown } | null
			if (!o || o.type !== 'bind' || o.read_only === true || o.read_only === 'true') continue
			const src = str(o.source)
			addPath(src && !src.includes('$') ? absPath(src, ctx) : null)
		}
	}
	const project = str(doc.name) ?? composeProjectNameFor(ctx.appName)
	const vols = doc.volumes && typeof doc.volumes === 'object' && !Array.isArray(doc.volumes) ? (doc.volumes as Record<string, unknown>) : {}
	for (const [key, raw] of Object.entries(vols)) {
		const v = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; external?: unknown; driver_opts?: unknown }
		const dev = (v.driver_opts as { device?: unknown } | null | undefined)?.device
		addPath(typeof dev === 'string' ? dev : null)
		const ext = v.external === true || v.external === 'true'
		const name = str(v.name) ?? (ext ? key : `${project}_${key}`)
		addPath(ctx.serverVolumeDevices?.[name])
	}
	for (const p of ctx.serverWritable ?? []) addPath(p)
	return [...out].sort()
}

export function composeViolations(config: unknown, ctxIn: ComposeGuardContext): ComposeViolation[] {
	const ctx = { ...ctxIn }
	const out: ComposeViolation[] = []
	if (!config || typeof config !== 'object' || Array.isArray(config))
		return [{ code: 'shape', message: 'compose is not a mapping' }]
	const doc = config as Record<string, unknown>
	for (const k of Object.keys(doc)) {
		if (k.startsWith('x-')) continue
		if (k === 'include')
			out.push({
				code: 'include',
				message: '"include" is only allowed in the resolved config (docker compose config)',
			})
		else if (!TOP_KEYS.has(k))
			out.push({ code: 'top_key', message: `top-level "${k}" is not allowed` })
	}
	const services = doc.services as Record<string, unknown> | undefined
	if (!services || typeof services !== 'object' || Array.isArray(services))
		return [...out, { code: 'shape', message: 'compose has no services' }]
	// The project compose really uses (default volume / network names). It never
	// grants ownership (every rule keys on ctx.appName), and it must be the app name: the
	// deploy refuses any other in every mode (compose-check.ts, bindLinkGuardShell).
	const project = str(doc.name) ?? composeProjectNameFor(ctx.appName)
	if (project !== composeProjectNameFor(ctx.appName))
		out.push({
			code: 'project_name',
			message: `the compose project name "${project}" is not the app name "${ctx.appName}" (remove the name: key or set it to the app name)`,
		})
	// a service compose left out of the resolved config (an inactive profile)
	// still starts by name with `up --no-deps <service>`.
	for (const svc of ctx.unresolvedServices ?? [])
		out.push({
			code: 'profiles',
			service: svc,
			message: `service ${svc}: in the uninterpolated compose config but missing from the resolved one (a profile hides it from the safety rules, while "up <service>" still starts it)`,
		})
	const names = new Set(Object.keys(services))
	const containerNames = new Set<string>()
	for (const def of Object.values(services)) {
		const cn = str((def as { container_name?: unknown } | null)?.container_name)
		if (cn) containerNames.add(cn)
	}
	ctx.envFilePaths = [...new Set([...(ctx.envFilePaths ?? []), ...envFilePathsOf(services, ctx)])]
	ctx.writableFolders = writableFoldersOf(doc, ctx)
	// powder's own service and container names, on any network: an app's
	// compose may not look like powder's own deploy (that one runs unguarded).
	const self = ctx.selfNames ?? selfDeployNames()
	const selfSet = new Set([self.service, self.container].filter((n): n is string => !!n).map((n) => n.toLowerCase()))
	for (const [svc, raw] of Object.entries(services)) {
		const s: SvcCtx = { svc, ctx, project, services: names, containerNames, out }
		if (selfSet.has(svc.toLowerCase())) add(s, 'service_key', `the service key "${svc}" is powder's own service or container name (POWDER_SELF_SERVICE / POWDER_SELF_CONTAINER)`)
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			add(s, 'shape', 'is not a mapping')
			continue
		}
		const def = raw as Record<string, unknown>
		const cnSelf = str(def.container_name)
		if (cnSelf && selfSet.has(cnSelf.toLowerCase()) && !RESERVED_CONTAINER_NAMES.includes(cnSelf.toLowerCase()))
			add(s, 'container_name', `container_name "${cnSelf}" is powder's own service or container name (POWDER_SELF_SERVICE / POWDER_SELF_CONTAINER)`)
		for (const [k, v] of Object.entries(def)) {
			if (k.startsWith('x-')) continue
			const rule = SERVICE_KEYS[k]
			if (rule === undefined) add(s, 'unknown_key', `"${k}" is not on powder's compose allow-list`)
			else if (rule === DENY) add(s, k, `"${k}" is not allowed`)
			else if (typeof rule === 'function') rule(v, s)
		}
		const img = str(def.image)
		if (img && def.build === undefined) checkSiblingImage(img, s)
		if (img && def.build !== undefined) {
			if (checkBuiltImageOwner(img, s, 'image built here:')) {
				checkBuiltImageName(img, s, 'image')
				// also when image_name fired (that code is exemptable, this one is not)
				checkBuiltImageOwnership(img, s, 'image built here:')
			}
		}
		// the compose default name a build without `image:` writes
		if (!img && def.build !== undefined) checkBuiltImageOwnership(`${project}-${svc}`, s, 'the compose default image')
		if (def.build !== undefined) checkBuildPullPolicy(def.pull_policy, s)
	}
	checkWritableBindsInsideBuild(services, ctx, out)
	if (ctx.checkEnvLoopback) out.push(...envLoopbackViolations(services, ctx.serviceImageExposed))
	checkServiceKeys(services, doc.networks, project, ctx, out)
	checkTopLevelNamed('network', doc.networks, project, ctx, out)
	checkTopLevelNamed('volume', doc.volumes, project, ctx, out)
	checkTopLevelFiles('secret', doc.secrets, ctx, out)
	checkTopLevelFiles('config', doc.configs, ctx, out)
	return out.filter((v) => !exemptionApplies(v, ctx, names, containerNames))
}

/** a WRITABLE bind whose source is strictly inside a build context or an
 *  additional context of this compose (code `build_bind`, never exemptable). BuildKit
 *  reads the context by path after powder's checks; a process in that container could
 *  swap a folder inside it for a link and put host files into the next image. A
 *  read-only bind passes. The on-server bind guard (deploy/fragments.ts bindLinkGuardShell)
 *  refuses the same for the binds of every container on the server, any state. */
function checkWritableBindsInsideBuild(services: Record<string, unknown>, ctx: ComposeGuardContext, out: ComposeViolation[]) {
	const paths: Array<[string, string]> = []
	const local = (p: string) => !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('git@') && !p.startsWith('~')
	for (const [svc, raw] of Object.entries(services)) {
		const b = (raw as { build?: unknown } | null)?.build
		if (b === undefined || b === null) continue
		const bo = typeof b === 'string' ? { context: b } : (b as Record<string, unknown>)
		const c = str(bo.context) ?? '.'
		if (local(c)) paths.push([svc, absPath(c, ctx) ?? ''])
		for (const v of Object.values((bo.additional_contexts as Record<string, unknown>) ?? {})) {
			const p = String(v)
			if (local(p)) paths.push([svc, absPath(p, ctx) ?? ''])
		}
	}
	const app = appRoots(ctx)
	// 2: the src/ layout (a build path at or under <app dir>/src; the on-server guard
	// decides by <app dir>/src/.git): no build path may then be the app dir itself, which
	// holds powder's runtime files and no .dockerignore of powder's.
	const srcLayout = paths.some(([, p]) => app.some((r) => under(p, `${r}/src`)))
	if (srcLayout)
		for (const [svc, p] of paths)
			if (app.includes(p))
				out.push({
					code: 'build_bind',
					service: svc,
					message: `service ${svc}: the build path ${p} is the app dir itself, but the checkout is in src/ (the app dir holds .deploy-key, the compose and data dirs). Build from ./src`,
					value: p,
				})
	const ctxs = paths.map(([, p]) => p).filter((r) => r !== '')
	if (ctxs.length === 0) return
	for (const [svc, raw] of Object.entries(services)) {
		const vols = (raw as { volumes?: unknown } | null)?.volumes
		for (const vol of asList(vols)) {
			let src: string | null = null
			let ro = false
			if (typeof vol === 'string') {
				const parts = vol.split(':')
				if (parts.length < 2) continue
				src = parts[0] ?? ''
				if (!(src.startsWith('/') || src.startsWith('.'))) continue
				ro = (parts[2] ?? '').split(',').includes('ro')
			} else if (vol && typeof vol === 'object') {
				const o = vol as { type?: string; source?: unknown; read_only?: unknown }
				if (o.type !== 'bind') continue
				src = str(o.source)
				ro = o.read_only === true || o.read_only === 'true'
			}
			if (!src || ro) continue
			const a = absPath(src, ctx)
			if (!a) continue
			// The /new layout's DB data dirs right in a context that is the app dir itself:
			// powder's .dockerignore there ends with pgdata/ and kvdata/ (protected, last).
			// Not in the src/ layout; the on-server guard also requires powder's .dockerignore there.
			const dataDir = (r: string) => !srcLayout && app.includes(r) && (a === `${r}/pgdata` || a === `${r}/kvdata`)
			const hit = ctxs.find((r) => a !== r && under(a, r) && !dataDir(r))
			if (hit)
				out.push({
					code: 'build_bind',
					service: svc,
					message: `service ${svc}: the writable bind ${src} is inside the build context ${hit}; the build reads the context after powder's checks and a container could swap a folder there for a link to host files. Mount it read-only (:ro) or move it out of the build context`,
					value: a,
				})
		}
	}
}

/** host paths no exemption opens, as a bind source or a volume device: the path
 *  itself, anything inside it, and any folder above it (`/`, `/var`, `/opt`). */
const NEVER_EXEMPT_PATHS = [
	'/etc', '/root', '/var/run', '/run', '/var/lib', '/var/spool', '/var/log', '/usr', '/bin', '/sbin', '/home',
	'/proc', '/sys', '/dev', '/boot', '/opt/apps',
]

/** true when a violation stays a violation whatever POWDER_COMPOSE_GUARD_EXEMPT
 *  says: network_mode / pid / ipc joining a container that is not this project's
 *  (a powder container, another project's, or one powder cannot place), and binds of the
 *  host root, system folders, the docker socket or another app's /opt/apps paths. */
export function neverExemptable(
	v: ComposeViolation,
	ctx: ComposeGuardContext,
	services: ReadonlySet<string> = new Set(),
	containerNames: ReadonlySet<string> = new Set(),
): boolean {
	// a hidden or profiled service is never exemptable (the rules may not have
	// seen it at all).
	if (v.code === 'profiles') return true
	// a pulling policy on a build service fetches a private image with root's login
	if (v.code === 'pull_policy') return true
	// another platform variant or a re-pull of the checked base images
	if (v.code === 'platform' || v.code === 'build_pull') return true
	// a build over another project's image, another app's base or a public name
	if (v.code === 'image_owner') return true
	// a writable bind inside a build context (the build would read what it swaps)
	if (v.code === 'build_bind') return true
	const val = v.value
	if (val === undefined) return false
	if (v.code === 'network_mode' || v.code === 'pid' || v.code === 'ipc') {
		if (val.startsWith('service:')) return !services.has(val.slice(8))
		if (!val.startsWith('container:')) return false
		const target = val.slice(10)
		const own = [...containerNames, ...(ctx.ownProjectContainers ?? [])]
		if (reservedName(target, ctx)) return true
		return !nameIn(own, target)
	}
	if (v.code === 'bind') {
		const p = posix.normalize(val)
		if (!p.startsWith('/')) return true
		if (p === '/' || /(^|\/)docker\.sock$/.test(p)) return true
		// /lib, /lib32, /lib64, /libx32 and anything inside
		if (/^\/lib(32|64|x32)?(\/|$)/.test(p)) return true
		// the app dir itself, and its compose files, .deploy-key, env target and
		// git metadata (protectedPaths), inside them or a folder above them. Other folders
		// of the app dir and /opt/apps/<app>-* stay exemptable.
		if (appRoots(ctx).some((r) => p === r)) return true
		for (const x of ctx.protectedPaths ?? []) {
			const n = posix.normalize(x)
			if (under(p, n) || under(n, p)) return true
		}
		for (const x of NEVER_EXEMPT_PATHS) {
			if (x === '/opt/apps') {
				if (p === x || under(x, p)) return true
				if (!under(p, x)) continue
				const seg = lcName(p.slice(x.length + 1).split('/')[0] ?? '')
				const lctx = lowerNameCtx(ctx)
				const owner = registeredOwnerOf(seg, { appName: lctx.appName, otherApps: [...(lctx.otherApps ?? []), ...RESERVED_CONTAINER_NAMES] })
				if (seg.startsWith('powder') || (owner !== undefined && owner !== lctx.appName)) return true
				continue
			}
			if (under(p, x) || under(x, p)) return true
		}
	}
	return false
}

/** value pattern match: exact, or a prefix when the pattern ends in `/` (the
 *  folder itself or anything inside it) or `*`. */
function exemptValueMatches(value: string, pattern: string): boolean {
	if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
	if (pattern.endsWith('/') && pattern.length > 1) return value === pattern.slice(0, -1) || value.startsWith(pattern)
	return value === pattern
}

function exemptionApplies(
	v: ComposeViolation,
	ctx: ComposeGuardContext,
	services: ReadonlySet<string>,
	containerNames: ReadonlySet<string>,
): boolean {
	const codes = ctx.exempt ?? []
	const patterns = ctx.exemptValues?.[v.code]
	if (!codes.includes(v.code) && !(patterns && v.value !== undefined && patterns.some((p) => exemptValueMatches(v.value as string, p))))
		return false
	return !neverExemptable(v, ctx, services, containerNames)
}

/** every rule code is HIGH severity (warn mode refuses it when the compose
 *  config changed, deploy/compose-check.ts: repoChanged, or a hash other than the
 *  last successful deploy's) unless it is on this list. A code added later is high
 *  by default. Only codes whose finding cannot reach the host, another app or
 *  powder belong here:
 *  - shape: the compose (or a service) is not a mapping. docker compose itself
 *    refuses such a file, so the deploy fails before anything runs.
 *  Everything else (unknown keys included: an unvetted compose key may hand over
 *  the host, as use_api_socket or device_cgroup_rules do) is high. */
export const LOW_SEVERITY_CODES: ReadonlySet<string> = new Set(['shape'])

export function isHighSeverity(v: ComposeViolation): boolean {
	return !LOW_SEVERITY_CODES.has(v.code)
}

/** First violation as a reason string, or null when the config is safe. */
export function checkComposeConfig(config: unknown, ctx: ComposeGuardContext): string | null {
	const v = composeViolations(config, ctx)
	const first = v[0]
	return first
		? `${first.message} [${first.code}]${v.length > 1 ? ` (+${v.length - 1} more)` : ''}`
		: null
}

/** Parse a raw compose YAML file with merge keys APPLIED (`<<: *anchor`), so a
 *  key hidden in an anchor is checked like any other. Throws on bad YAML. */
export function parseComposeYaml(text: string): unknown {
	return parseYaml(text, { merge: true, maxAliasCount: 100 })
}

/** Operator exemptions: POWDER_COMPOSE_GUARD_EXEMPT is JSON keyed by `<serverId>/<app>`
 *  (or a bare `<app>`, which matches that app name on every server and logs a warning).
 *  A value is either a list of codes (`["network_mode"]`: every value of the code) or
 * an object of code -> value patterns (`{"network_mode":["host"],
 *  "bind":["/srv/data/"]}`: only those values). Whatever the form, neverExemptable()
 *  findings stay. Bad JSON = no exemptions. */
export function exemptionFor(
	serverId: string | null,
	appName: string,
	raw = process.env.POWDER_COMPOSE_GUARD_EXEMPT,
): { codes: string[]; values: Record<string, string[]>; warnings: string[] } {
	const codes = new Set<string>()
	const values: Record<string, string[]> = {}
	const warnings: string[] = []
	if (!raw) return { codes: [], values, warnings }
	let m: Record<string, unknown>
	try {
		m = JSON.parse(raw) as Record<string, unknown>
		if (!m || typeof m !== 'object' || Array.isArray(m)) return { codes: [], values, warnings }
	} catch {
		return { codes: [], values, warnings }
	}
	const take = (k: string) => {
		const e = m[k]
		if (Array.isArray(e)) {
			for (const c of e) if (typeof c === 'string') codes.add(c)
		} else if (e && typeof e === 'object') {
			for (const [code, list] of Object.entries(e as Record<string, unknown>)) {
				if (!Array.isArray(list)) continue
				const pats = list.filter((x): x is string => typeof x === 'string' && x !== '')
				if (pats.length) values[code] = [...new Set([...(values[code] ?? []), ...pats])]
			}
		}
	}
	if (serverId && m[`${serverId}/${appName}`] !== undefined) take(`${serverId}/${appName}`)
	if (m[appName] !== undefined) {
		take(appName)
		warnings.push(
			`POWDER_COMPOSE_GUARD_EXEMPT uses the bare key "${appName}", which matches an app of that name on every server; write "${serverId ?? '<serverId>'}/${appName}"`,
		)
	}
	return { codes: [...codes], values, warnings }
}

/** The code list of exemptionFor (every value of each code). */
export function exemptCodesFor(
	serverId: string | null,
	appName: string,
	raw = process.env.POWDER_COMPOSE_GUARD_EXEMPT,
): string[] {
	return exemptionFor(serverId, appName, raw).codes
}
