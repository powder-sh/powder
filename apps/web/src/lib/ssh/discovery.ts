import type { ServerConfig } from '../servers'
import { SAFE_NAME, assertSafeName, shq } from '../shell'
import { DockerCommandError } from '../container-state'
import { runCommand } from './connection'
import { isPowderTempComposeFile } from '../compose-override'

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
): Promise<NginxRoute[]> {
	// Defense-in-depth: even though docker container names follow a tight regex,
	// belt-and-braces sanitize the loop variable with a post-`head` regex filter
	// so `$c` can never expand to anything that would let a hostile container
	// name inject shell. `head -10` first to cap the iteration count, then the
	// regex filter so we never accept a name with anything but [A-Za-z0-9._-].
	const managed = managedNames.filter((n) => SAFE_NAME.test(n))
	const cmd =
		// host nginx
		`{ cat /etc/nginx/sites-enabled/* 2>/dev/null; ` +
		// the compose projects of powder's apps (their containers are app-controlled)
		`MANAGED=${shq(managed.join('\n'))}; ` +
		`OPTR=$(readlink -f /opt/apps 2>/dev/null || true); OPTR=\${OPTR:-/opt/apps}; ` +
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

	const map = new Map<string, Set<string>>() // key = "host|port"
	const blocks = stdout.split(/\bserver\s*\{/).slice(1)
	for (const block of blocks) {
		const closeIdx = findMatchingClose(block)
		const body = closeIdx === -1 ? block : block.slice(0, closeIdx)
		const nameMatch = body.match(/server_name\s+([^;]+);/)
		if (!nameMatch) continue
		const names = (nameMatch[1] ?? '')
			.trim()
			.split(/\s+/)
			.filter((n) => n && n !== '_' && !n.startsWith('localhost'))
		// Some nginx configs use `set $upstream "..."` indirection. Inline those
		// so the proxy_pass regex below catches the upstream. Two flavors:
		//   set $u "http://X:Y";  proxy_pass $u;            (scheme in set)
		//   set $u "X:Y";         proxy_pass http://$u;     (scheme on proxy_pass)
		let inlinedBody = body.replace(
			/set\s+\$([A-Za-z0-9_]+)\s+["']?(https?:\/\/[A-Za-z0-9._:-]+)["']?\s*;[\s\S]*?proxy_pass\s+\$\1\s*;/g,
			(_, _v, url) => `proxy_pass ${url};`,
		)
		inlinedBody = inlinedBody.replace(
			/set\s+\$([A-Za-z0-9_]+)\s+["']?([A-Za-z0-9._:-]+)["']?\s*;[\s\S]*?proxy_pass\s+(https?:\/\/)\$\1\s*;/g,
			(_, _v, hostport, scheme) => `proxy_pass ${scheme}${hostport};`,
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
			const key = `${host}|${port ?? ''}`
			const set = map.get(key) ?? new Set<string>()
			for (const name of names) set.add(`${proto}://${name}`)
			map.set(key, set)
		}
	}
	return [...map.entries()].map(([key, urls]) => {
		const [host, portStr] = key.split('|')
		return {
			host: host || null,
			port: portStr ? Number(portStr) : null,
			urls: [...urls].sort(),
		}
	})
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
