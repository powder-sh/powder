// Single helper for "is this server routed by Traefik labels?". Reads
// servers.proxy (migration 0040), not a hardcoded list. Not a
// tenancy concept: it is the per-server routing mode, set one server at a time.
import { db, eq, servers } from './db'

type ServerProxy = 'nginx' | 'nginx-container' | 'traefik'

interface ProxyFields {
	proxy?: ServerProxy | null
}

/**
 * Pass the server row/config when you already have it (no query); pass a
 * server id to look it up. Unknown id = false.
 */
export async function isTraefikServer(serverOrId: string | ProxyFields): Promise<boolean> {
	if (typeof serverOrId !== 'string') return serverOrId.proxy === 'traefik'
	const [row] = await db
		.select({ proxy: servers.proxy })
		.from(servers)
		.where(eq(servers.id, serverOrId))
		.limit(1)
	return row?.proxy === 'traefik'
}

/** Ids of every server with proxy = 'traefik' (traffic aggregation loop). */
export async function listTraefikServerIds(): Promise<string[]> {
	const rows = await db.select({ id: servers.id }).from(servers).where(eq(servers.proxy, 'traefik'))
	return rows.map((r) => r.id)
}
