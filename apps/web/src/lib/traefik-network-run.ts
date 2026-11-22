// Reads the Traefik network of a server over SSH (the rule: traefik-network.ts)
// and caches it in-process like the server check result; the last answer is also
// stored on the server row (servers.traefik_network), so the deploy's compose guard
// knows it without an SSH call and it survives a restart. Every feature that
// attaches a container for Traefik to route asks here: the new-app flow, previews,
// URL snapshots and the rollback bridge.
import {
	DEFAULT_TRAEFIK_NETWORK,
	type DockerNetworkInfo,
	cacheTraefikNetwork,
	cachedTraefikNetwork,
	type InspectJson,
	type TraefikNetwork,
	isDockerNetworkName,
	parseDockerNetworks,
	routingNetwork,
	traefikConfigHostPath,
	traefikNetworkFlag,
	traefikNetworkFrom,
} from './traefik-network'
import { saveTraefikNetwork, type ServerConfig } from './servers'
import { shq } from './shell'
import { runCommand } from './ssh'

const NETWORKS_MARKER = '===POWDER_DOCKER_NETWORKS==='

/** Store an answer (the server check resolves it too) in the cache and, when it
 *  changed, on the server row. Best effort: a failed write is logged. */
export async function rememberTraefikNetwork(
	server: Pick<ServerConfig, 'id' | 'traefikNetwork' | 'traefikNetworkSource'>,
	value: TraefikNetwork,
): Promise<void> {
	cacheTraefikNetwork(server.id, value)
	if (server.traefikNetwork === value.name && server.traefikNetworkSource === value.source) return
	try {
		await saveTraefikNetwork(server.id, value.name, value.source)
	} catch (err) {
		console.warn(`[traefik-network] could not save the network of ${server.id}`, err)
	}
}

/** Reads the config file the traefik container mounts (traefikConfigHostPath), or
 *  null. The one read of that file: the server check's file provider state uses it too. */
export async function readTraefikConfig(
	server: ServerConfig,
	inspect: InspectJson,
): Promise<{ text: string; path: string } | null> {
	const path = traefikConfigHostPath(inspect)
	if (!path) return null
	const cat = await runCommand(server, `cat ${shq(path)}`, 10_000).catch(() => null)
	return cat && cat.code === 0 ? { text: cat.stdout, path } : null
}

/** Pure: the resolver's inputs from one `docker inspect traefik` + network list run. */
export function parseTraefikNetworkProbe(stdout: string): {
	inspect: InspectJson | null
	networks: DockerNetworkInfo[] | null
} {
	const i = stdout.indexOf(NETWORKS_MARKER)
	const inspectText = (i >= 0 ? stdout.slice(0, i) : stdout).trim()
	let inspect: InspectJson | null = null
	try {
		const arr = JSON.parse(inspectText || '[]') as unknown
		inspect = Array.isArray(arr) && arr[0] && typeof arr[0] === 'object' ? (arr[0] as InspectJson) : null
	} catch {
		inspect = null
	}
	return { inspect, networks: i >= 0 ? parseDockerNetworks(stdout.slice(i + NETWORKS_MARKER.length)) : null }
}

export const TRAEFIK_NETWORK_PROBE = `docker inspect --type container traefik 2>/dev/null || echo '[]'; echo ${shq(NETWORKS_MARKER)}; docker network ls --format '{{.Name}}:{{.Internal}}:{{.Label "com.docker.compose.project"}}' 2>/dev/null || true`

/**
 * The network this server's Traefik routes over. Not a Traefik server: `web`, no
 * SSH (nothing changes there). Otherwise a fresh cached answer, else the running
 * traefik container is read. An SSH failure is not cached: the stored answer is
 * used, else `web`.
 */
export async function resolveTraefikNetwork(server: ServerConfig): Promise<TraefikNetwork> {
	if (server.proxy !== 'traefik') {
		return { name: DEFAULT_TRAEFIK_NETWORK, source: 'default', attached: null, why: 'not a Traefik server' }
	}
	const hit = cachedTraefikNetwork(server.id)
	if (hit) return hit
	const r = await runCommand(server, TRAEFIK_NETWORK_PROBE, 15_000).catch(() => null)
	// the marker comes after the inspect: without it the answer was cut or never ran
	if (!r || !r.stdout.includes(NETWORKS_MARKER)) {
		const stored = isDockerNetworkName(server.traefikNetwork) ? server.traefikNetwork : null
		const source = server.traefikNetworkSource
		return stored && source
			? { name: stored, source, attached: null, why: 'could not read the traefik container: the last resolved network' }
			: { name: DEFAULT_TRAEFIK_NETWORK, source: 'default', attached: null, why: 'could not read the traefik container: powder uses web' }
	}
	const { inspect, networks } = parseTraefikNetworkProbe(r.stdout)
	// the config file only matters when no flag names the network
	const config = inspect && !traefikNetworkFlag(inspect) ? await readTraefikConfig(server, inspect) : null
	const value = traefikNetworkFrom({ traefik: inspect !== null, inspect, config, networks })
	await rememberTraefikNetwork(server, value)
	return value
}

/** The network powder attaches containers to for Traefik on this server
 *  (routingNetwork of resolveTraefikNetwork): a declared one, else `web`. The new-app
 *  flow, previews, URL snapshots and the rollback bridge use this. */
export async function resolveRoutingNetwork(server: ServerConfig): Promise<string> {
	return routingNetwork(await resolveTraefikNetwork(server))
}
