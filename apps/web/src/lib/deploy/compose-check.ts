// Deploy-time compose safety check. The RULES live in
// compose-safety.ts (the one authority); this file only gathers the inputs on
// the server and pins them:
//
//   1. Before the deploy script runs, powder reads the resolved config
//      (`docker compose config --format json`) plus the uninterpolated one
//      (`--no-interpolate`, which still names the env_file paths the resolved
//      form inlines), the other containers on the server, and checks them.
//   2. It hands the script a sha256 of exactly those two outputs. The script
//      recomputes it after the git sync and again right before `compose up`,
//      and refuses on any difference (a repo file feeding the compose: tracked
//      .env, env_file or include under the checkout, a container that rewrote a
//      file it can reach). One retry: powder re-checks the new tree once.

import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { DOCKERFILE_REWRITE_AWK, REGISTRY_LOGIN_HOSTS_SHELL, SYNTAX_ALLOWED_ERE } from '../build-cache'
import { OVERRIDE_FILE } from '../compose-override'
import { serverImageFacts } from '../image-ownership'
import {
	type ComposeGuardContext,
	composeProjectNameFor,
	composeViolations,
	type DockerfileImageAuthority,
	dockerfileImageAuthority,
	exemptionFor,
	isHighSeverity,
	migrationDirPaths,
	normImage,
	RESERVED_CONTAINER_NAMES,
} from '../compose-safety'
import type { ServerConfig } from '../servers'
import { shq } from '../shell'
import { runCommand } from '../ssh/connection'
import { knownTraefikNetwork } from '../traefik-network'
import { ALL_PROFILES, composeConfigHashShell } from './compose-hash'
import { type ComposeView, composeViewDiff, composeViewOf } from './compose-diff'
import { onServerComposeGuardShell } from './fragments'

export {
	composeHashGuardShell,
} from './compose-hash'

/** The resolved config keeps no env_file / label_file paths (it inlines them); copy them
 *  from the uninterpolated config. A path that still holds `${...}` there is refused by
 *  the authority (an unresolvable path cannot be checked). A service only the
 *  uninterpolated config has (compose dropped it from the resolved one: an inactive
 *  profile) is copied in as it stands there, so every rule runs on it too; the context
 *  (unresolvedServicesOf) makes it a `profiles` finding on its own. */
export function mergeFilePaths(resolved: unknown, raw: unknown): unknown {
	const r = resolved as { services?: Record<string, Record<string, unknown>> } | null
	const n = raw as { services?: Record<string, Record<string, unknown>> } | null
	if (!r?.services || !n?.services) return resolved
	const services: Record<string, Record<string, unknown>> = {}
	for (const [name, svc] of Object.entries(r.services)) {
		const copy = { ...svc }
		for (const k of ['env_file', 'label_file']) {
			const v = n.services[name]?.[k]
			if (v !== undefined && copy[k] === undefined) copy[k] = v
		}
		services[name] = copy
	}
	for (const name of unresolvedServicesOf(resolved, raw)) {
		const svc = n.services[name]
		services[name] = svc && typeof svc === 'object' && !Array.isArray(svc) ? { ...svc } : (svc as Record<string, unknown>)
	}
	return { ...(resolved as object), services }
}

/** service keys of the `--no-interpolate` config that the resolved config lacks.
 *  Both come from the same `--profile '*'` probe, so a plain compose has none. */
export function unresolvedServicesOf(resolved: unknown, raw: unknown): string[] {
	const r = (resolved as { services?: unknown } | null)?.services
	const n = (raw as { services?: unknown } | null)?.services
	if (!n || typeof n !== 'object' || Array.isArray(n)) return []
	const have = r && typeof r === 'object' && !Array.isArray(r) ? new Set(Object.keys(r)) : new Set<string>()
	return Object.keys(n).filter((k) => !have.has(k))
}

export interface ComposeCheckInput {
	resolved: unknown
	raw: unknown
	hash: string
	/** name, image, compose project, state of every container on the server; the
	 *  compose service and the networks it is on when the probe reports them */
	containers: Array<{
		name: string
		image: string
		project: string
		state?: string
		service?: string
		networks?: string[]
	}>
	/** `docker compose config --format json` WITHOUT powder's override file (the
	 *  repo/app compose files and the project .env only): the input of the stored
	 *  structural hash. Undefined when the probe did not report it. */
	userResolved?: unknown
	/** the DNS aliases every RUNNING container answers on each of its networks
	 *  (`docker inspect` .NetworkSettings.Networks.<net>.Aliases). Undefined when the
	 *  probe did not report them. */
	aliases?: Array<{ name: string; project: string; networks: Record<string, string[]> }>
	/** every container in any state (`docker inspect`): name, compose
	 *  project, the image ref it was created from, its image ID, and its host port
	 *  bindings. Undefined when the probe did not report them. */
	details?: Array<{
		name: string
		project: string
		image: string
		imageId: string
		ports: Array<{ hostIp: string; port: number; protocol: string }>
		/** the container's mounts (`docker inspect` .Mounts); undefined when the
		 *  probe line had none (an older probe). */
		mounts?: Array<{ type: string; name: string; source: string; rw: boolean }>
	}>
	/** image ID -> the compose project its `com.docker.compose.project` label
	 *  names ('' when none). Undefined when the probe did not report it. */
	imageProjects?: Record<string, string>
	/** image ID -> the ports its config EXPOSEs (same section as imageProjects). */
	imageExposed?: Record<string, number[]>
	/** docker volume name -> its `device` driver option, for every volume on the
	 *  server that has one. Undefined when the probe did not report it. */
	volumeDevices?: Record<string, string>
	/** registry hosts root is logged in to on the server (REGISTRY_LOGIN_HOSTS_SHELL:
	 *  key names of root's docker config.json, never credentials). Undefined when the
	 *  probe did not report them (the rules then assume ghcr.io). */
	registryLoginHosts?: string[]
	/** the entries of /opt/apps (name -> kind: `f` a file or a link to one,
	 *  `d` a folder, `dc` a folder with a compose file at its top or in src/, `l` a dangling
	 *  link, `o` anything else). Undefined when the probe did not report it. */
	appsDir?: Record<string, string>
	/** docker volume name -> its `com.docker.compose.project` label (volumes with
	 *  one). Undefined when the probe did not report it. */
	volumeProjects?: Record<string, string>
	/** every local image (dangling ones too): the repos of its RepoTags and
	 *  RepoDigests and its `com.docker.compose.project` label ('' when none). Undefined
	 *  when the probe did not report it (or the section did not end with its marker). */
	localImages?: Array<{ repos: string[]; project: string }>
	/** every image ref a Dockerfile under /opt/apps reads (FROM, COPY --from, RUN
	 *  --mount from=), read with the deploy's own rewrite awk: the /opt/apps folder and
	 *  the ref. Undefined when the probe did not report it. */
	dockerfileRefs?: Array<{ app: string; ref: string }>
	/** the running containers that are a Docker-provider proxy (a traefik image, or
	 *  `providers.docker` in their args or env): Traefik routes from container labels
	 *  there, whatever servers.proxy says. Undefined when the probe did not report it. */
	dockerProxies?: string[]
}

/** the last line of the local image and Dockerfile ref sections when the listing
 *  ran to its end. Without it the section is unknown (not "nothing there"). */
export const IMAGE_LIST_OK = '__POWDER_IMAGE_LIST_OK__'
export const DOCKERFILE_REFS_OK = '__POWDER_DOCKERFILE_REFS_OK__'

/** one line per local image (any image, dangling ones too): its ID, its RepoTags,
 *  its RepoDigests (a dangling image keeps its repo there) and its config as JSON (the
 *  labels are read from it in TypeScript, as IMAGE_PROBE_FORMAT does). */
const IMAGE_LIST_PROBE_FORMAT = '{{.Id}}{{"\\t"}}{{json .RepoTags}}{{"\\t"}}{{json .RepoDigests}}{{"\\t"}}{{json .Config}}'

/** the shell of the local image section (ends with IMAGE_LIST_OK when docker
 *  answered). POSIX sh. */
export const IMAGE_LIST_PROBE = `__il=$(docker image ls -aq --no-trunc 2>/dev/null) && { printf '%s\\n' "$__il" | sort -u | xargs -r docker image inspect --format ${shq(IMAGE_LIST_PROBE_FORMAT)} 2>/dev/null; echo ${IMAGE_LIST_OK}; }`

/** the Dockerfiles of every folder under /opt/apps (depth 2 to 4 below /opt/apps,
 *  and depth 1 to 4 below each `<app>/src`; node_modules, .git and `*.removed*` skipped,
 *  symlinks never followed: `-type f`), each read by DOCKERFILE_REWRITE_AWK (the deploy's
 *  own parser: ARG scope, stages) into a scratch dir; one `<app folder>\t<ref>` line per
 *  IMG report line, then DOCKERFILE_REFS_OK. Read-only (the rewritten file goes to
 *  /dev/null). POSIX sh. */
export const DOCKERFILE_REFS_PROBE =
	[
		`__dt=$(mktemp -d /tmp/powder-dfrefs.XXXXXX) && { { find /opt/apps -mindepth 2 -maxdepth 4 \\( -name node_modules -o -name .git -o -name '*.removed*' \\) -prune -o -type f -print 2>/dev/null; `,
		`for __s in /opt/apps/*/src; do [ -d "$__s" ] && [ ! -L "$__s" ] && find "$__s" -mindepth 1 -maxdepth 4 \\( -name node_modules -o -name .git -o -name '*.removed*' \\) -prune -o -type f -print 2>/dev/null; done; } `,
		`| grep -E '/(Dockerfile[^/]*|[^/]*\\.[Dd]ockerfile)$' | grep -vE '\\.dockerignore$' | sort -u | while IFS= read -r __f; do `,
		`__a=\${__f#/opt/apps/}; __a=\${__a%%/*}; : > "$__dt/rp"; : > "$__dt/tf"; `,
		`DFR_NS=0123456789abcdef0123456789abcdef DFR_APP=probe DFR_TF="$__dt/tf" DFR_RP="$__dt/rp" DFR_ARGF= DFR_SYNTAX=${shq(SYNTAX_ALLOWED_ERE)} LC_ALL=C awk ${shq(DOCKERFILE_REWRITE_AWK)} "$__f" >/dev/null 2>&1; `,
		`sed -n 's/^IMG //p' "$__dt/rp" | while IFS= read -r __r; do printf '%s\\t%s\\n' "$__a" "$__r"; done; done; `,
		`rm -rf "$__dt"; echo ${DOCKERFILE_REFS_OK}; }`,
	].join('')

const IMAGE_REF_OK = /^[A-Za-z0-9._/:@-]+$/

/** the end marker of the Docker-provider proxy section. */
export const DOCKER_PROXY_OK = '__POWDER_DOCKER_PROXY_OK__'

/** the docker inspect format of DOCKER_PROXY_PROBE (tabs as `{{"\\t"}}`). */
const DOCKER_PROXY_PROBE_FORMAT =
	'{{.Name}}{{"\\t"}}{{.Config.Image}}{{"\\t"}}{{json .Args}}{{json .Config.Entrypoint}}{{json .Config.Cmd}}{{json .Config.Env}}'

/** one `<name>\t<image>\t<0|1>` line per running container, the flag 1 when its
 *  args, entrypoint, cmd or env name `providers.docker` (TRAEFIK_PROVIDERS_DOCKER*). The
 *  env is matched on the server and never leaves it. POSIX sh. */
export const DOCKER_PROXY_PROBE =
	`__dp=$(docker ps -q 2>/dev/null) && { printf '%s\\n' "$__dp" | xargs -r docker inspect --format ${shq(DOCKER_PROXY_PROBE_FORMAT)} 2>/dev/null ` +
	`| awk -F'\t' '{ d = (tolower($3) ~ /providers[._]docker/) ? 1 : 0; print $1 "\t" $2 "\t" d }'; echo ${DOCKER_PROXY_OK}; }`

const TRAEFIK_IMAGE_RE = /(?:^|\/)traefik(?::[^/@]*)?(?:@.*)?$/i

/** Pure: parse the DOCKER_PROXY_PROBE section into the names of the Docker-provider
 *  proxies. Undefined unless it ends with DOCKER_PROXY_OK. */
export function parseDockerProxyProbe(text: string): string[] | undefined {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
	if (lines[lines.length - 1] !== DOCKER_PROXY_OK) return undefined
	const out: string[] = []
	for (const l of lines.slice(0, -1)) {
		const [name = '', image = '', flag = ''] = l.split('\t')
		if (flag === '1' || TRAEFIK_IMAGE_RE.test(image)) out.push(name.replace(/^\//, ''))
	}
	return out
}

/** Pure: parse the IMAGE_LIST_PROBE section. Undefined unless it ends with IMAGE_LIST_OK. */
export function parseImageListProbe(text: string): NonNullable<ComposeCheckInput['localImages']> | undefined {
	const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')
	if (lines[lines.length - 1]?.trim() !== IMAGE_LIST_OK) return undefined
	const out: NonNullable<ComposeCheckInput['localImages']> = []
	for (const line of lines.slice(0, -1)) {
		const [, tags = 'null', digests = 'null', cfg = 'null'] = line.split('\t')
		const repos = new Set<string>()
		let project = ''
		try {
			for (const t of (JSON.parse(tags) as unknown[] | null) ?? []) if (typeof t === 'string' && IMAGE_REF_OK.test(t) && !t.startsWith('<none>')) repos.add(t)
			for (const d of (JSON.parse(digests) as unknown[] | null) ?? []) if (typeof d === 'string' && IMAGE_REF_OK.test(d) && !d.startsWith('<none>')) repos.add(d)
		} catch {
			// unreadable names: the image adds no repo
		}
		try {
			const c = JSON.parse(cfg) as { Labels?: Record<string, unknown> | null } | null
			const p = c?.Labels?.['com.docker.compose.project']
			project = typeof p === 'string' ? p : ''
		} catch {
			project = ''
		}
		if (repos.size) out.push({ repos: [...repos], project })
	}
	return out
}

/** Pure: parse the DOCKERFILE_REFS_PROBE section. Undefined unless it ends with its marker. */
export function parseDockerfileRefsProbe(text: string): NonNullable<ComposeCheckInput['dockerfileRefs']> | undefined {
	const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')
	if (lines[lines.length - 1]?.trim() !== DOCKERFILE_REFS_OK) return undefined
	const out: NonNullable<ComposeCheckInput['dockerfileRefs']> = []
	for (const line of lines.slice(0, -1)) {
		const [app = '', ref = ''] = line.split('\t')
		if (BOX_NAME_RE.test(app) && IMAGE_REF_OK.test(ref)) out.push({ app, ref })
	}
	return out
}

const BOX_NAME_RE = /^[A-Za-z0-9._-]+$/

/** the last line of the /opt/apps section when the listing ran to its end on a
 *  readable dir. Without it the section is unknown (every env file counts as existing). */
export const APPS_DIR_OK = '__POWDER_APPS_DIR_OK__'

/** one line per /opt/apps entry: name, a tab, its kind (ComposeCheckInput
 *  appsDir), then APPS_DIR_OK. POSIX sh. */
export const APPS_DIR_PROBE =
	'if [ -d /opt/apps ] && [ -r /opt/apps ] && [ -x /opt/apps ]; then for __e in /opt/apps/*; do [ -e "$__e" ] || [ -L "$__e" ] || continue; __n=${__e##*/}; ' +
	'if [ -d "$__e" ]; then __k=d; for __c in docker-compose.yml docker-compose.yaml compose.yml compose.yaml src/docker-compose.yml src/docker-compose.yaml src/compose.yml src/compose.yaml; do if [ -f "$__e/$__c" ]; then __k=dc; break; fi; done; ' +
	'elif [ -f "$__e" ]; then __k=f; elif [ -L "$__e" ]; then __k=l; else __k=o; fi; printf \'%s\\t%s\\n\' "$__n" "$__k"; done; echo ' + APPS_DIR_OK + '; fi'

/** one line per volume: its name, a tab, its compose project label. */
const VOLUME_PROJECT_PROBE_FORMAT = '{{.Name}}{{"\\t"}}{{index .Labels "com.docker.compose.project"}}'

const BOX_NAME = /^[A-Za-z0-9._-]+$/

/** Pure: parse the APPS_DIR_PROBE lines (names other than [A-Za-z0-9._-] are skipped).
 *  undefined (unknown) unless the section ends with APPS_DIR_OK: an empty or
 *  cut-off section must not read as "no env file exists". */
export function parseAppsDirProbe(text: string): Record<string, string> | undefined {
	const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')
	if (lines[lines.length - 1]?.trim() !== APPS_DIR_OK) return undefined
	const out: Record<string, string> = {}
	for (const line of lines.slice(0, -1)) {
		const [n = '', k = ''] = line.split('\t')
		if (BOX_NAME.test(n) && /^(f|d|dc|l|o)$/.test(k.trim())) out[n] = k.trim()
	}
	return out
}

/** Pure: parse the VOLUME_PROJECT_PROBE_FORMAT lines (volumes with a label only). */
export function parseVolumeProjectProbe(text: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of text.split('\n')) {
		const [n = '', p = ''] = line.split('\t')
		const proj = p.trim()
		if (BOX_NAME.test(n.trim()) && proj !== '' && proj !== '<no value>' && BOX_NAME.test(proj)) out[n.trim()] = proj
	}
	return out
}

/** parse the login hosts section (space separated host names). */
export function parseLoginHostsProbe(text: string): string[] {
	return [...new Set(text.trim().split(/\s+/).map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.:-]+$/.test(h)))]
}

/** one line per volume on the server: its name (docker allows only
 *  [A-Za-z0-9][A-Za-z0-9_.-]*), a tab, its driver options as JSON. */
const VOLUME_PROBE_FORMAT = '{{.Name}}{{"\\t"}}{{json .Options}}'

/** Pure: parse the VOLUME_PROBE_FORMAT lines into name -> device (volumes with a
 *  non-empty `device` option only). An unreadable line is skipped. */
export function parseVolumeProbe(text: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of text.split('\n')) {
		const tab = line.indexOf('\t')
		if (tab <= 0) continue
		try {
			const o = JSON.parse(line.slice(tab + 1)) as Record<string, unknown> | null
			const dev = o?.device
			if (typeof dev === 'string' && dev !== '') out[line.slice(0, tab).trim()] = dev
		} catch {
			// not JSON: skip
		}
	}
	return out
}

/** one line per container, any state. And its mounts as JSON (the
 *  writable set's part (c), serverWritableOf). */
const DETAIL_PROBE_FORMAT =
	'{{.Name}}{{"\\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\\t"}}{{.Config.Image}}{{"\\t"}}{{.Image}}{{"\\t"}}{{json .HostConfig.PortBindings}}{{"\\t"}}{{json .Mounts}}'

/** one line per image the containers use: ID, then its config as JSON (the
 *  labels are read from it in TypeScript: docker 29 reports image Config as a map, where
 *  a template `.Config.Labels` fails on an image without labels). */
const IMAGE_PROBE_FORMAT = '{{.Id}}{{"\\t"}}{{json .Config}}'

/** Pure: parse the DETAIL_PROBE_FORMAT lines. */
export function parseDetailProbe(text: string): NonNullable<ComposeCheckInput['details']> {
	const out: NonNullable<ComposeCheckInput['details']> = []
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		const [rawName = '', project = '', image = '', imageId = '', bindings = '', mountsText] = line.split('\t')
		const ports: Array<{ hostIp: string; port: number; protocol: string }> = []
		try {
			const pb = JSON.parse(bindings || 'null') as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null
			for (const [cport, list] of Object.entries(pb ?? {})) {
				const protocol = (cport.split('/')[1] ?? 'tcp').toLowerCase()
				for (const b of list ?? []) {
					const n = Number(b?.HostPort ?? '')
					if (b?.HostPort && Number.isInteger(n) && n > 0) ports.push({ hostIp: b.HostIp ?? '', port: n, protocol })
				}
			}
		} catch {
			// unreadable bindings: no ports for this container
		}
		const mounts = mountsText === undefined ? undefined : parseMounts(mountsText)
		out.push({ name: rawName.replace(/^\//, ''), project, image, imageId, ports, ...(mounts ? { mounts } : {}) })
	}
	return out
}

/** `{{json .Mounts}}` of one container. An unreadable list is an empty one. */
function parseMounts(text: string): Array<{ type: string; name: string; source: string; rw: boolean }> {
	try {
		const list = JSON.parse(text || 'null') as unknown
		if (!Array.isArray(list)) return []
		return list
			.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
			.map((m) => ({
				type: typeof m.Type === 'string' ? m.Type : '',
				name: typeof m.Name === 'string' ? m.Name : '',
				source: typeof m.Source === 'string' ? m.Source : '',
				rw: m.RW === true,
			}))
	} catch {
		return []
	}
}

/** part (c) of the writable set (compose-safety.ts writableFoldersOf, the twin of
 *  the on-server pw_wset): for every container of a compose project (any state), its
 *  writable bind sources and the absolute `device` of every named volume it mounts
 *  writable (the volume's server options, volumeDevices). Undefined when the probe reported
 *  no container mounts. */
export function serverWritableOf(input: Pick<ComposeCheckInput, 'details' | 'volumeDevices'>): string[] | undefined {
	if (!input.details?.some((c) => c.mounts !== undefined)) return undefined
	const out = new Set<string>()
	for (const c of input.details) {
		if (!c.project) continue
		for (const m of c.mounts ?? []) {
			if (!m.rw) continue
			const p = m.type === 'bind' ? m.source : m.type === 'volume' ? (input.volumeDevices?.[m.name] ?? '') : ''
			if (p.startsWith('/')) out.add(p)
		}
	}
	return [...out].sort()
}

/** Pure: parse the IMAGE_PROBE_FORMAT lines into image ID -> the ports its config
 *  EXPOSEs (`ExposedPorts` keys such as `3000/tcp`). Images with none are left out. */
export function parseImageExposeProbe(text: string): Record<string, number[]> {
	const out: Record<string, number[]> = {}
	for (const line of text.split('\n')) {
		const tab = line.indexOf('\t')
		if (tab <= 0) continue
		try {
			const cfg = JSON.parse(line.slice(tab + 1)) as { ExposedPorts?: Record<string, unknown> | null } | null
			const ports = Object.keys(cfg?.ExposedPorts ?? {})
				.map((k) => Number(k.split('/')[0]))
				.filter((n) => Number.isInteger(n) && n > 0 && n <= 65535)
			if (ports.length) out[line.slice(0, tab).trim()] = ports
		} catch {
			// unreadable config: no ports
		}
	}
	return out
}

/** Pure: parse the IMAGE_PROBE_FORMAT lines into image ID -> compose project label. */
export function parseImageProbe(text: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of text.split('\n')) {
		const tab = line.indexOf('\t')
		if (tab <= 0) continue
		const id = line.slice(0, tab).trim()
		let project = ''
		try {
			const cfg = JSON.parse(line.slice(tab + 1)) as { Labels?: Record<string, string> | null } | null
			project = cfg?.Labels?.['com.docker.compose.project'] ?? ''
		} catch {
			project = ''
		}
		out[id] = project
	}
	return out
}

/** one line per running container: name, compose project, then its networks.
 *  every field is printed as JSON (`{{json}}`), so an alias holding a newline,
 *  a tab, `;`, `=` or `,` stays inside its JSON string and cannot frame another line,
 *  another container or the section separator. */
export const ALIAS_PROBE_FORMAT =
	'{{json .Name}}{{"\\t"}}{{json (index .Config.Labels "com.docker.compose.project")}}{{"\\t"}}{{json .NetworkSettings.Networks}}'

/** Pure: parse the ALIAS_PROBE_FORMAT lines. A line that is not valid JSON is skipped
 *  (docker writes valid JSON; nothing in a value can break it). */
export function parseAliasProbe(text: string): NonNullable<ComposeCheckInput['aliases']> {
	const out: NonNullable<ComposeCheckInput['aliases']> = []
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		const [rawName = '', project = '', nets = ''] = line.split('\t')
		try {
			const name = JSON.parse(rawName) as unknown
			const proj = JSON.parse(project || '""') as unknown
			const n = JSON.parse(nets || 'null') as Record<string, { Aliases?: unknown } | null> | null
			if (typeof name !== 'string') continue
			const networks: Record<string, string[]> = {}
			for (const [net, v] of Object.entries(n ?? {})) {
				const list = Array.isArray(v?.Aliases) ? v.Aliases : []
				networks[net] = list.filter((a): a is string => typeof a === 'string' && a !== '')
			}
			out.push({ name: name.replace(/^\//, ''), project: typeof proj === 'string' ? proj : '', networks })
		} catch {
			// not JSON: skip the line
		}
	}
	return out
}

/** A fixed section separator of the probe (tests and fixtures). */
export const FIXED_PROBE_SEP = '__POWDER_CG_SEP__'

/** a separator no container can print: a random nonce per probe (like the
 *  crontab probe). */
export function probeSeparator(nonce: string = randomBytes(16).toString('hex')): string {
	return `__POWDER_CG_SEP_${nonce.replace(/[^0-9a-f]/g, '')}__`
}

/** Pure: split the probe output. `sep`: the separator token the probe printed. */
export function parseComposeProbe(stdout: string, sep: string = FIXED_PROBE_SEP): ComposeCheckInput | null {
	const parts = stdout.split(`\n${sep}\n`)
	if (parts.length < 4 || parts.length > 15) return null
	const [hash, resolvedText, rawText, ps, userText, aliasText, detailText, imageText, volumeText, loginText, appsText, volProjText, imageListText, dfRefsText, proxyText] = parts as [
		string,
		string,
		string,
		string,
		string?,
		string?,
		string?,
		string?,
		string?,
		string?,
		string?,
		string?,
		string?,
		string?,
		string?,
	]
	try {
		const localImages = imageListText !== undefined ? parseImageListProbe(imageListText) : undefined
		const dockerfileRefs = dfRefsText !== undefined ? parseDockerfileRefsProbe(dfRefsText) : undefined
		const dockerProxies = proxyText !== undefined ? parseDockerProxyProbe(proxyText) : undefined
		return {
			...(dockerProxies ? { dockerProxies } : {}),
			...(localImages ? { localImages } : {}),
			...(dockerfileRefs ? { dockerfileRefs } : {}),
			...(appsText !== undefined && parseAppsDirProbe(appsText) ? { appsDir: parseAppsDirProbe(appsText) } : {}),
			...(volProjText !== undefined ? { volumeProjects: parseVolumeProjectProbe(volProjText) } : {}),
			...(loginText !== undefined ? { registryLoginHosts: parseLoginHostsProbe(loginText) } : {}),
			...(volumeText !== undefined ? { volumeDevices: parseVolumeProbe(volumeText) } : {}),
			...(detailText !== undefined ? { details: parseDetailProbe(detailText) } : {}),
			...(imageText !== undefined ? { imageProjects: parseImageProbe(imageText), imageExposed: parseImageExposeProbe(imageText) } : {}),
			...(userText?.trim() ? { userResolved: JSON.parse(userText) } : {}),
			...(aliasText !== undefined ? { aliases: parseAliasProbe(aliasText) } : {}),
			hash: hash.trim(),
			resolved: JSON.parse(resolvedText),
			raw: rawText.trim() ? JSON.parse(rawText) : null,
			containers: ps
				.split('\n')
				.filter((l) => l.trim())
				.map((l) => {
					const [name = '', image = '', project = '', state = '', service, nets] = l.split('\t')
					return {
						name,
						image,
						project,
						state,
						...(service !== undefined ? { service } : {}),
						...(nets !== undefined ? { networks: nets.split(',').filter(Boolean) } : {}),
					}
				}),
		}
	} catch {
		return null
	}
}

/** the .git dirs of every checkout layout (src/ layout, workdir layout,
 *  the compose project dir when it differs). Pure. */
function gitMetadataPaths(workingDir: string, projectDir: string): string[] {
	const w = workingDir.replace(/\/+$/, '')
	return [...new Set([`${w}/src/.git`, `${w}/.git`, `${projectDir.replace(/\/+$/, '')}/.git`])]
}

/** Host rules are enforced on a server marked traefik (routeHosts) and on any server
 *  where the probe sees a Docker-provider proxy running (proxyRouteHosts), whatever
 *  servers.proxy says. Pure. */
export function effectiveRouteHosts(
	input: Pick<ComposeCheckInput, 'dockerProxies'>,
	p: { routeHosts: string[] | null; proxyRouteHosts?: string[] },
): string[] | null {
	if (p.routeHosts) return p.routeHosts
	if (p.proxyRouteHosts && input.dockerProxies && input.dockerProxies.length > 0) return p.proxyRouteHosts
	return null
}

/** Pure: the context the authority runs with at deploy time. */
export function deployGuardContext(
	input: ComposeCheckInput,
	p: {
		appName: string
		workingDir: string
		composeFiles: string[]
		serverId: string | null
		routeHosts: string[] | null
		/** the hosts this app may route when the server is not marked traefik
		 *  (routeHosts null) but the probe sees a Docker-provider proxy running. */
		proxyRouteHosts?: string[]
		extraEnvFiles?: string[]
		/** the other powder apps on this server (app_repos container names). */
		otherApps?: string[]
		/** where this deploy renders the app's env file (any path, also one inside
		 *  the app dir): no service may bind it. */
		envTarget?: string | null
		/** the network the server's Traefik routes over when it is not `web`
		 *  (traefik-network-run.ts knownTraefikNetwork): shared on this server. */
		traefikNetwork?: string | null
	},
): ComposeGuardContext {
	// the app's own containers are those of the project named after the app (the
	// deploy refuses any other project name, checkComposeForDeploy), never whatever the
	// compose `name:` says.
	const project = composeProjectNameFor(p.appName)
	const projectDir = posix.dirname(
		p.composeFiles.find((f) => posix.basename(f) !== OVERRIDE_FILE) ??
			`${p.workingDir}/docker-compose.yml`,
	)
	const foreign = input.containers.filter((c) => c.project !== project)
	return {
		appName: p.appName,
		...(p.traefikNetwork ? { traefikNetwork: p.traefikNetwork } : {}),
		projectDir,
		protectedPaths: [
			...p.composeFiles,
			`${p.workingDir}/.deploy-key`,
			`/opt/apps/${p.appName}.env`,
			...(p.envTarget ? [p.envTarget] : []),
			// the git metadata powder runs git on as root. A container that can
			// write it can plant repo config (hooks, fsmonitor, filter drivers) that the
			// next deploy's git would run; lib/git-harden.ts scrubs that config, this keeps
			// the container from racing the scrub. `./src/public` style binds stay allowed;
			// `./src`, `./.git` (and the app dir, refused above) are high findings.
			...gitMetadataPaths(p.workingDir, projectDir),
		],
		// the folders powder-migrate reads *.sql from; a writable bind over one
		// could swap a migration between its check and its read.
		migrationPaths: migrationDirPaths(p.workingDir),
		routeHosts: effectiveRouteHosts(input, p),
		foreignContainers: foreign.map((c) => c.name),
		ownProjectContainers: input.containers.filter((c) => c.project === project).map((c) => c.name),
		foreignNamesByNetwork: namesByNetwork(
			foreign,
			input.aliases?.filter((a) => a.project !== project),
		),
		// Only RUNNING containers of ANOTHER compose project define "another app's
		// image": an exited or stray `docker run app:latest` is not an owner.
		foreignImages: foreign
			.filter((c) => c.project !== '' && (c.state === undefined || c.state === 'running'))
			.map((c) => c.image)
			.filter(Boolean),
		// any state; only containers of a compose project (an app), not strays.
		foreignImagesAnyState: [...new Set(foreign.filter((c) => c.project !== '').map((c) => c.image).filter(Boolean))],
		...foreignBuiltAndPorts(input, project, p.otherApps ?? []),
		extraEnvFiles: p.extraEnvFiles,
		otherApps: p.otherApps,
		// Compose-default build names of other projects (`<project>-<service>`), any
		// state: the local image stays after its container stops.
		foreignProjectImages: [
			...new Set(
				foreign
					.filter((c) => c.project !== '' && c.service)
					.map((c) => `${c.project}-${c.service}`),
			),
		],
		...(input.volumeDevices ? { serverVolumeDevices: input.volumeDevices } : {}),
		...(serverWritableOf(input) ? { serverWritable: serverWritableOf(input) } : {}),
		...(input.registryLoginHosts ? { registryLoginHosts: input.registryLoginHosts } : {}),
		...serverOwnership(input, p.appName),
		// who built or runs each image repo on the server, and which apps' Dockerfiles
		// read it (image-ownership.ts, the one authority for "whose image is this").
		serverImages: serverImageFacts({
			containers: input.details ?? input.containers,
			localImages: input.localImages,
			dockerfileRefs: input.dockerfileRefs,
		}),
		...serviceImageExposedOf(input, project),
		exempt: exemptionFor(p.serverId, p.appName).codes,
		exemptValues: exemptionFor(p.serverId, p.appName).values,
		resolved: true,
		unresolvedServices: unresolvedServicesOf(input.resolved, input.raw),
	}
}

/** per compose service of this project, the EXPOSE ports of the image its existing
 *  container (any state) was created from. The new build is not there yet at check
 *  time; the running image is the best known answer. */
function serviceImageExposedOf(input: ComposeCheckInput, project: string): Pick<ComposeGuardContext, 'serviceImageExposed'> {
	if (!input.details || !input.imageExposed) return {}
	const out: Record<string, number[]> = {}
	for (const c of input.containers) {
		if (c.project !== project || !c.service) continue
		const id = input.details.find((d) => d.name === c.name)?.imageId
		const ports = id ? input.imageExposed[id] : undefined
		if (ports) out[c.service] = [...new Set([...(out[c.service] ?? []), ...ports])]
	}
	return { serviceImageExposed: out }
}

/** what the server says about ownership beyond the registered apps.
 *  serverEnvFiles: the /opt/apps/*.env entries (files and links); serverOwners: the compose
 *  project of every container (any state), every volume's project label and every
 *  /opt/apps folder with a compose file, minus this app's own name and project;
 *  serverVolumeProjects: the volume labels. Each only when the probe reported its source. */
export function serverOwnership(
	input: Pick<ComposeCheckInput, 'containers' | 'appsDir' | 'volumeProjects'>,
	appName: string,
): Pick<ComposeGuardContext, 'serverEnvFiles' | 'serverOwners' | 'serverVolumeProjects'> {
	const own = new Set([appName, appName.toLowerCase(), composeProjectNameFor(appName)])
	const owners = new Set<string>()
	for (const c of input.containers) if (c.project) owners.add(c.project)
	for (const p of Object.values(input.volumeProjects ?? {})) owners.add(p)
	for (const [n, k] of Object.entries(input.appsDir ?? {})) if (k === 'dc') owners.add(n)
	for (const o of own) owners.delete(o)
	return {
		serverOwners: [...owners].sort(),
		...(input.appsDir ? { serverEnvFiles: Object.entries(input.appsDir).filter(([n, k]) => n.endsWith('.env') && k !== 'd' && k !== 'dc').map(([n]) => n) } : {}),
		...(input.volumeProjects ? { serverVolumeProjects: input.volumeProjects } : {}),
	}
}

/** from the container details (any state):
 *  - foreignBuiltImages: the image refs of OTHER projects' containers named after a
 *    registered app or preview (that app's main image, its code), and of any container
 *    whose image carries a `com.docker.compose.project` label of another project (compose
 *    built it for that project). On the containerd image store (docker 29), locally
 *    built images DO have a RepoDigest and most carry no compose
 *    label, so neither alone tells a build from a pull; a shared public DB image (pgvector,
 *    postgres) is never another app's main image.
 *  - foreignPorts: host ports OTHER compose projects' containers bind (a container without
 *    a compose project, a hand-started one or powder's bridge, never counts).
 *  Both empty-undefined when the probe did not report details. */
function foreignBuiltAndPorts(
	input: ComposeCheckInput,
	project: string,
	otherApps: string[],
): Pick<ComposeGuardContext, 'foreignBuiltImages' | 'foreignPorts'> {
	if (!input.details) return {}
	const apps = new Set(otherApps)
	const imgProj = input.imageProjects ?? {}
	const built = new Set<string>()
	const ports: NonNullable<ComposeGuardContext['foreignPorts']> = []
	// per image repo, the OTHER compose projects that run it and whether one of
	// them pins it by registry digest. This app's own project never counts: it could
	// otherwise make another project's local image "public" by running it itself.
	const repoProjects = new Map<string, Set<string>>()
	const repoPinned = new Set<string>()
	for (const c of input.details) {
		if (!c.project || c.project === project || !c.image) continue
		const repo = imageRepo(normImage(c.image)).toLowerCase()
		const set = repoProjects.get(repo) ?? new Set<string>()
		set.add(c.project)
		repoProjects.set(repo, set)
		if (/@sha256:[0-9a-f]{64}$/i.test(c.image)) repoPinned.add(repo)
	}
	// a public registry image: another project pins its repo by registry digest,
	// or it is a Docker Hub image (no registry host) that two or more other compose
	// projects run (the shared DB images, alpine).
	const publicImage = (ref: string) => {
		if (/@sha256:[0-9a-f]{64}$/i.test(ref)) return true
		const repo = imageRepo(normImage(ref)).toLowerCase()
		if (repoPinned.has(repo)) return true
		const first = repo.split('/')[0] ?? ''
		const hub = !repo.includes('/') || !(first.includes('.') || first.includes(':') || first === 'localhost')
		return hub && (repoProjects.get(repo)?.size ?? 0) >= 2
	}
	for (const c of input.details) {
		const labelProject = imgProj[c.imageId] ?? ''
		const foreignProject = c.project !== '' && c.project !== project
		if ((foreignProject && apps.has(c.name)) || (labelProject !== '' && labelProject !== project)) {
			if (c.image) built.add(c.image)
		} else if (foreignProject && c.image && !RESERVED_CONTAINER_NAMES.includes(c.name) && !publicImage(c.image)) {
			// any other image another compose project runs (a sidecar's local build
			// under a name that is no app's, e.g. `acme/jobs`), unless it is public. powder's
			// own containers (postgres, traefik, ...) are left out: they run public pulls and
			// powder-named builds (image_name), and the server's single pgvector pull there
			// would otherwise mark the DB image of an app next to it as foreign.
			built.add(c.image)
		}
		if (foreignProject) for (const pt of c.ports) ports.push({ ...pt, owner: c.name })
	}
	return { foreignBuiltImages: [...built], foreignPorts: ports }
}

/** Shared network -> container and compose service names other projects answer on it.
 *  undefined when the probe did not report networks (older probe output). */
function namesByNetwork(
	foreign: ComposeCheckInput['containers'],
	foreignAliases?: ComposeCheckInput['aliases'],
): Record<string, string[]> | undefined {
	if (!foreign.some((c) => c.networks !== undefined)) return undefined
	const out: Record<string, string[]> = {}
	// the aliases other projects' running containers answer on each network.
	for (const a of foreignAliases ?? []) {
		for (const [n, list] of Object.entries(a.networks)) out[n] = [...(out[n] ?? []), ...list]
	}
	// Only a running container answers DNS on a network.
	for (const c of foreign.filter((x) => x.state === undefined || x.state === 'running')) {
		for (const n of c.networks ?? []) {
			const list = out[n] ?? []
			list.push(c.name)
			if (c.service) list.push(c.service)
			out[n] = list
		}
	}
	return out
}

/** Canonical JSON: object keys sorted at every level. */
function canonical(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canonical)
	if (v && typeof v === 'object')
		return Object.fromEntries(
			Object.keys(v as Record<string, unknown>)
				.sort()
				.map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
		)
	return v
}

/** Image ref without its tag or digest (`app:deploy-12` and `app@sha256:..` -> `app`). */
function imageRepo(ref: string): string {
	const noDigest = ref.split('@')[0] ?? ref
	const slash = noDigest.lastIndexOf('/')
	const colon = noDigest.lastIndexOf(':')
	return colon > slash ? noDigest.slice(0, colon) : noDigest
}

/**
 * The hash a successful deploy stores (deploys.compose_config_hash) and the next deploy
 * compares against. Input: the RESOLVED config (`docker compose config --format json`:
 * merges, include, extends and project-.env interpolation applied) of the repo/app
 * compose files WITHOUT powder's own override file, plus the env_file / label_file paths
 * taken from the `--no-interpolate` config (the resolved form inlines them into
 * `environment`). Removed before hashing: every service's `environment` (env_file
 * contents and inline values) and the tag/digest of every `image`. Keys are sorted.
 *
 * So: an env var edit in powder, a new image tag, or a domain/route label powder writes
 * into its override file is not a compose change. A tracked `.env` value that feeds an
 * interpolation (`${DATA_DIR}:/data`), a new bind, capability, network, build section,
 * label in the app's compose, or env_file path is. Caveat: a value that powder renders
 * into the PROJECT `.env` (an app whose env file is `.env` next to the compose) and that
 * the compose interpolates into a field other than `environment` also counts.
 * '' when the config is missing.
 */
export function structuralComposeHash(resolved: unknown, raw?: unknown): string {
	const doc = structuralComposeDoc(resolved, raw)
	if (!doc) return ''
	return createHash('sha256').update(JSON.stringify(canonical(doc))).digest('hex')
}

/** the document structuralComposeHash hashes (env dropped, image tags removed), or
 *  null when the config is missing. */
export function structuralComposeDoc(resolved: unknown, raw?: unknown): Record<string, unknown> | null {
	const merged = raw === undefined ? resolved : mergeFilePaths(resolved, raw)
	const doc = merged as { services?: Record<string, Record<string, unknown>> } | null
	if (!doc || typeof doc !== 'object' || !doc.services) return null
	const services: Record<string, Record<string, unknown>> = {}
	for (const [name, svc] of Object.entries(doc.services)) {
		const { environment: _env, ...rest } = svc ?? {}
		if (typeof rest.image === 'string') rest.image = imageRepo(rest.image)
		services[name] = rest
	}
	return { ...(doc as object), services }
}

/** the view a success stores next to compose_config_hash (compose-diff.ts). `salt`:
 *  a stored view's salt (to diff against it), else a fresh one. */
export function structuralComposeView(resolved: unknown, raw?: unknown, salt?: string): ComposeView | null {
	return composeViewOf(structuralComposeDoc(resolved, raw), salt)
}

/** Pure: the lines the guard prints when the config differs from the last successful
 *  deploy: what changed per service (secret-bearing values never shown) and where such
 *  a change can come from. */
export function composeChangeReport(
	approvedView: ComposeView | null | undefined,
	currentView: ComposeView | null,
	composeFiles: string[],
): string {
	const files = composeFiles.filter((f) => posix.basename(f) !== OVERRIDE_FILE)
	const where = `A hand edit of the compose on the server (${files.join(', ') || 'the app compose file'}) changes it as much as a repo commit does.`
	if (!approvedView || !currentView)
		return `What changed: unknown, no copy of the last successful config is stored to compare with (deploys from this powder version on store one).\n${where}\n`
	const lines = composeViewDiff(approvedView, currentView)
	if (!lines.length) return `What changed: nothing powder can print (a value it never shows, such as a label or build value, moved).\n${where}\n`
	return `What changed since the last successful deploy (environment values are never shown):\n${lines.map((l) => `  ${l}`).join('\n')}\n${where}\n`
}

export class ComposeGuardError extends Error {}

/** First line of the probe output when the env file link guard refused. */
export const ENV_LINK_MARKER = '__POWDER_ENV_LINK_REFUSED__'

/** Pure: the guard's message when the probe output starts with ENV_LINK_MARKER, else null. */
export function envLinkRefusal(stdout: string): string | null {
	if (!stdout.startsWith(`${ENV_LINK_MARKER}\n`)) return null
	const msg = stdout.slice(ENV_LINK_MARKER.length + 1).trim()
	return msg || 'env file guard: refusing, an env_file / label_file symlink check failed'
}

/** Guard mode: ENFORCE by default (unset, `enforce`, or any unknown value). WARN only
 *  with POWDER_COMPOSE_GUARD=warn, an operator opt-out for existing installs while it
 *  collects findings (docs/SECURITY-COMPOSE.md rollout). */
export function composeGuardEnforced(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return (env.POWDER_COMPOSE_GUARD ?? '').trim().toLowerCase() !== 'warn'
}

/** One greppable line per finding: `[compose-guard] WARN <app> <rule-code> <detail>`. */
function warnLine(app: string, code: string, detail: string): string {
	return `[compose-guard] WARN ${app} ${code} ${detail.replace(/\s+/g, ' ').trim()}`
}

/** Probe the server, run the authority, return the hash the script must keep seeing.
 *  Enforce mode (default): throws ComposeGuardError (with a __POWDER_FAIL__ marker) on
 *  any violation or an unreadable config. Warn mode: logs and returns. */
export async function checkComposeForDeploy(
	server: ServerConfig,
	cf: string,
	p: {
		appName: string
		workingDir: string
		composeFiles: string[]
		routeHosts: string[] | null
		/** see deployGuardContext. */
		proxyRouteHosts?: string[]
		extraEnvFiles?: string[]
		/** the other powder apps on this server (app_repos container names). */
		otherApps?: string[]
		/** where this deploy renders the app's env file (any path, also one inside
		 *  the app dir): no service may bind it. */
		envTarget?: string | null
		/** the repo changed this config (the hash moved during the
		 *  git sync). Warn mode then refuses the high-severity rule codes when the
		 *  structural hash moved too (priorStructuralHash). */
		repoChanged?: boolean
		/** the structural hash the FIRST check of this deploy saw. With repoChanged,
		 *  the high-severity codes are enforced only when the structure moved (vs
		 *  approvedHash, else vs this): the in-script tripwire hashes the full config
		 *  (inlined env values, image tags), so an env-only edit fires it too. */
		priorStructuralHash?: string | null
		/** Compose file args WITHOUT powder's override (composeFileArgs override:false):
		 *  the structural hash is computed from that config. Defaults to `cf`. */
		userCf?: string
		/** compose_config_hash of the app's last SUCCESSFUL deploy (0056), a
		 *  structuralComposeHash. Warn mode enforces the high-severity rule codes when the
		 *  probed config's structural hash differs from it: the compose changed (in this
		 *  push or in an earlier refused one that left its tree on disk). No stored hash
		 *  (no successful deploy stored one yet, e.g. a new app): warn only, and the deploy's hash
		 *  becomes the baseline when it succeeds. Enforce mode refuses every finding. */
		approvedHash?: string | null
		/** compose_config_view of that same deploy (0062): what the refusal diffs the
		 *  probed config against. Null: the change is reported without a diff. */
		approvedView?: ComposeView | null
	},
	env: Record<string, string | undefined> = process.env,
): Promise<{
	hash: string
	structuralHash: string
	/** the view of the probed structure (store it on success as compose_config_view). */
	structuralView?: ComposeView | null
	log: string
	enforce: boolean
	dockerfileAuthority?: DockerfileImageAuthority
}> {
	const enforce = composeGuardEnforced(env)
	// a fresh nonce separator per probe; content cannot forge a section break.
	const sepToken = probeSeparator()
	const sep = `echo; echo ${sepToken}`
	// the env_file / label_file and mount source symlink checks run before
	// the first resolved `compose config` (which reads those files as root). A refusal is
	// hard in every mode.
	const linkGuard = onServerComposeGuardShell(cf, p.appName, p.workingDir)
	// the aliases every running container answers per network (6th section).
	const aliasProbe = `{ docker ps -q | xargs -r docker inspect --format ${shq(ALIAS_PROBE_FORMAT)} 2>/dev/null || true; }`
	// every container (any state) with its image ref, image ID and host port
	// bindings (7th section), and the compose project label of each of those images (8th).
	const detailProbe = `{ docker ps -aq | xargs -r docker inspect --format ${shq(DETAIL_PROBE_FORMAT)} 2>/dev/null || true; }`
	const imageProbe = `{ docker ps -aq | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null | sort -u | xargs -r docker image inspect --format ${shq(IMAGE_PROBE_FORMAT)} 2>/dev/null || true; }`
	// every volume on the server with its driver options (9th section): an external
	// volume whose server copy binds a host folder is refused.
	const volumeProbe = `{ docker volume ls -q 2>/dev/null | xargs -r docker volume inspect --format ${shq(VOLUME_PROBE_FORMAT)} 2>/dev/null || true; }`
	// every volume's compose project label (12th section); the
	// /opt/apps entries come before it (11th). Every local image with its repos and
	// compose label (13th), every image ref the Dockerfiles under /opt/apps read (14th).
	const volumeProjectProbe = `{ docker volume ls -q 2>/dev/null | xargs -r docker volume inspect --format ${shq(VOLUME_PROJECT_PROBE_FORMAT)} 2>/dev/null || true; }`
	const cmd = `cd ${shq(p.workingDir)} 2>/dev/null || true; EL_OUT=$(${linkGuard} 2>&1) || { printf '%s\n%s\n' ${shq(ENV_LINK_MARKER)} "$EL_OUT"; exit 0; }; ${composeConfigHashShell(cf)}; ${sep}; docker compose ${cf} ${ALL_PROFILES} config --format json 2>/dev/null; ${sep}; docker compose ${cf} ${ALL_PROFILES} config --no-interpolate --format json 2>/dev/null; ${sep}; docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.State}}\t{{.Label "com.docker.compose.service"}}\t{{.Networks}}'; ${sep}; docker compose ${p.userCf ?? cf} ${ALL_PROFILES} config --format json 2>/dev/null; ${sep}; ${aliasProbe}; ${sep}; ${detailProbe}; ${sep}; ${imageProbe}; ${sep}; ${volumeProbe}; ${sep}; { ${REGISTRY_LOGIN_HOSTS_SHELL}; }; ${sep}; { ${APPS_DIR_PROBE}; } 2>/dev/null; ${sep}; ${volumeProjectProbe}; ${sep}; { ${IMAGE_LIST_PROBE}; } 2>/dev/null; ${sep}; { ${DOCKERFILE_REFS_PROBE}; } 2>/dev/null; ${sep}; { ${DOCKER_PROXY_PROBE}; } 2>/dev/null`
	const fail = (msg: string) =>
		new ComposeGuardError(`compose guard: ${msg}\n__POWDER_FAIL__ step=compose guard code=1`)
	let input: ComposeCheckInput | null = null
	let probeErr = ''
	try {
		const r = await runCommand(server, cmd, 60_000)
		const refused = envLinkRefusal(r.stdout)
		if (refused !== null) throw fail(refused)
		input = parseComposeProbe(r.stdout, sepToken)
	} catch (err) {
		if (err instanceof ComposeGuardError) throw err
		probeErr = err instanceof Error ? err.message.slice(0, 200) : String(err)
	}
	const structuralHash = input
		? structuralComposeHash(input.userResolved ?? input.resolved, input.raw ?? undefined)
		: ''
	const structuralView = input ? structuralComposeView(input.userResolved ?? input.resolved, input.raw ?? undefined) : null
	// the probed config hashed with the stored view's salt, so hidden values compare
	const diffView =
		input && p.approvedView ? structuralComposeView(input.userResolved ?? input.resolved, input.raw ?? undefined, p.approvedView.salt) : null
	// A stored baseline that this config no longer matches. Missing baseline: not
	// "changed" (warn mode baselines it); enforce mode checks every rule anyway.
	const unapproved = !!p.approvedHash && structuralHash !== p.approvedHash
	// a repo change counts only when it changed the STRUCTURE: an env-only edit
	// (same structural hash as the baseline) keeps plain warn. No baseline and no
	// prior hash: treated as changed.
	const baseline = p.approvedHash || p.priorStructuralHash || null
	const repoStructural = p.repoChanged === true && structuralHash !== baseline
	const highOnly = !enforce && (repoStructural || unapproved)
	const reason = repoStructural ? 'the repo changed the compose config' : 'the compose config differs from the last successful deploy'
	// one line per deploy for a bare-key exemption (it matches every server).
	const exWarn = exemptionFor(server.id, p.appName)
		.warnings.map((w) => `${warnLine(p.appName, 'exempt_key', w)}\n`)
		.join('')
	const head = `── compose guard (${enforce ? 'enforce' : highOnly ? `warn, high-severity enforced: ${reason}` : 'warn'}) ──\n${exWarn}`
	if (!input || !/^[0-9a-f]{64}$/.test(input.hash)) {
		const why = `could not read the resolved compose config${probeErr ? ` (${probeErr})` : ' (docker compose config --format json failed, or the probe output did not parse)'}`
		if (enforce) throw fail(`${why}, refusing to deploy an unchecked compose`)
		// warn mode keeps going, loudly (dashboard log and powder's own log).
		console.error(`[compose-guard] WARN ${p.appName} probe ${why}; continuing UNCHECKED (POWDER_COMPOSE_GUARD=warn)`)
		return {
			hash: '',
			structuralHash: '',
			enforce,
			log: `${head}${warnLine(p.appName, 'probe', `${why}; continuing UNCHECKED: no compose rule ran for this config (enforce mode refuses this)`)}\n`,
		}
	}
	// the compose project name decides which containers, volumes and networks the
	// deploy treats as this app's. A hard refusal in every mode (the on-server bind guard in
	// the probe refuses it too, before any interpolated config is read).
	const projectName = (input.resolved as { name?: unknown } | null)?.name
	if (projectName !== composeProjectNameFor(p.appName))
		throw fail(
			`refusing, the compose project name is "${String(projectName ?? '')}", not "${composeProjectNameFor(p.appName)}" (the app name "${p.appName}" as compose writes a project name). powder decides what an app owns by its name; remove the name: key from the compose file (or set it to the app name). A hard refusal in every guard mode.`,
		)
	// the config moved since the last successful deploy (or in this push): the rules
	// that judge a change, not a standing setup, run too (env_loopback).
	const changed = unapproved || repoStructural
	// the server's own Traefik network counts as shared here when it is not `web`
	// (no SSH: the cached or stored answer, traefik-network-run.ts)
	const tnet = knownTraefikNetwork(server)
	const ctx = {
		...deployGuardContext(input, { ...p, serverId: server.id, ...(tnet !== 'web' ? { traefikNetwork: tnet } : {}) }),
		checkEnvLoopback: changed,
	}
	// what moved, versus the stored view of the last successful deploy.
	const changeReport = unapproved ? composeChangeReport(p.approvedView, diffView, p.composeFiles) : ''
	// say when Host rules are enforced because a proxy was seen on the server.
	const proxyNote =
		!p.routeHosts && ctx.routeHosts
			? `[compose-guard] ${p.appName}: Docker-provider proxy running on the server (${(input.dockerProxies ?? []).slice(0, 3).join(', ')}): Traefik Host() rules are checked against this app's hosts\n`
			: ''
	// a service the resolved config lacks (an inactive profile) is one no rule
	// below sees, while `up --no-deps <service>` starts it by name. A hard refusal in every
	// mode, like the on-server profile guard (composeProfileGuardShell).
	if (ctx.unresolvedServices?.length)
		throw fail(
			`refusing, service(s) ${ctx.unresolvedServices.join(', ')} are in the uninterpolated compose config but missing from the resolved one (a profile hides them from the safety rules, while "up <service>" still starts them). Remove the profiles: keys. A hard refusal in every guard mode. [profiles]`,
		)
	// what the Dockerfile image check compares FROM / COPY --from refs against.
	const checked = mergeFilePaths(input.resolved, input.raw)
	// with the config, so the authority carries the repos this app OWNS (DFR_OWNED).
	const dockerfileAuthority = dockerfileImageAuthority(ctx, checked)
	const violations = composeViolations(checked, ctx)
	const high = highOnly ? violations.filter(isHighSeverity) : []
	if (high.length) {
		const list = high.map((v) => `  - ${v.message} [${v.code}]`).join('\n')
		throw fail(
			`refusing, ${reason} and it breaks a high-severity safety rule:\n${list}\n${changeReport}Fix the compose file. An operator can exempt this app from a named rule with POWDER_COMPOSE_GUARD_EXEMPT (see docs/SECURITY-COMPOSE.md).`,
		)
	}
	if (violations.length && !enforce) {
		return {
			hash: input.hash,
			structuralHash,
			structuralView,
			enforce,
			dockerfileAuthority,
			log: `${head}${proxyNote}${violations.map((v) => warnLine(p.appName, v.code, v.message)).join('\n')}\n${changeReport}`,
		}
	}
	if (violations.length) {
		const list = violations.map((v) => `  - ${v.message} [${v.code}]`).join('\n')
		throw fail(
			`refusing, the compose config breaks powder's safety rules:\n${list}\n${changeReport}Fix the compose file. An operator can exempt this app from a named rule with POWDER_COMPOSE_GUARD_EXEMPT (see docs/SECURITY-COMPOSE.md).`,
		)
	}
	const exv = Object.entries(ctx.exemptValues ?? {}).map(([c, v]) => `${c}=${v.join('|')}`)
	const exAll = [...(ctx.exempt ?? []), ...exv]
	const ex = exAll.length ? ` (exempt: ${exAll.join(', ')})` : ''
	return {
		hash: input.hash,
		structuralHash,
		structuralView,
		enforce,
		dockerfileAuthority,
		log: `${head}${proxyNote}[compose-guard] resolved config passes the safety rules${ex}\n${changeReport}`,
	}
}
