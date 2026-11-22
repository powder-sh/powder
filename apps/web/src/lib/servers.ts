import { resolveBaseDomain } from './app-hosts'
import { appRepos, createId, db, domainRedirects, eq, prefixes, servers } from './db'
import { redirectRowInUse } from './traefik-network'

export interface ServerConfig {
	id: string
	name: string
	host: string
	user: string
	port: number
	kind: 'compose' | 'raw-docker'
	/** Dedicated builder host — when set, this server's apps build there. */
	buildHost?: string | null
	/** Routing mode (servers.proxy). Absent on hand-built configs = 'nginx'. */
	proxy?: 'nginx' | 'nginx-container' | 'traefik'
	/** Traefik TLS mode (servers.tls_mode). Absent = 'acme'. */
	tlsMode?: 'acme' | 'origin-cert'
	/** Default-host base domain (servers.base_domain). */
	baseDomain?: string | null
	/** Public IPv4 for custom-domain DNS verification (servers.ingress_ip). */
	ingressIp?: string | null
	/** The network the server's Traefik routes over, as last resolved (0069,
	 *  servers.traefik_network; traefik-network-run.ts). null = not resolved yet. */
	traefikNetwork?: string | null
	/** Where traefikNetwork came from (0069): flag | config | attached | default. */
	traefikNetworkSource?: 'flag' | 'config' | 'attached' | 'default' | null
}

export interface ServerRecord extends ServerConfig {
	status: 'pending' | 'connected' | 'unreachable'
	lastSeenAt: Date | null
	lastError: string | null
	createdAt: Date
	ownerUserId: string | null
	/** Last persisted server check (0060), null = never checked. */
	lastCheck: StoredServerCheck | null
}

/** A required piece the server check found missing (server-bootstrap.ts checkItems). */
export interface MissingPiece {
	id: string
	label: string
	detail: string
}

export interface StoredServerCheck {
	green: boolean
	proxy: 'nginx' | 'nginx-container' | 'traefik'
	at: Date
	/** The missing required pieces (0068); null = saved before 0068. */
	missing: MissingPiece[] | null
}

function rowToConfig(row: typeof servers.$inferSelect): ServerConfig {
	return {
		id: row.id,
		name: row.name,
		host: row.host,
		user: row.sshUser,
		port: Number(row.sshPort) || 22,
		kind: row.kind,
		buildHost: row.buildHost ?? null,
		proxy: row.proxy,
		tlsMode: row.tlsMode,
		baseDomain: resolveBaseDomain(row.id, row.baseDomain),
		ingressIp: row.ingressIp ?? null,
		traefikNetwork: row.traefikNetwork ?? null,
		traefikNetworkSource: row.traefikNetworkSource ?? null,
	}
}

function rowToRecord(row: typeof servers.$inferSelect): ServerRecord {
	return {
		...rowToConfig(row),
		status: row.status,
		lastSeenAt: row.lastSeenAt,
		lastError: row.lastError,
		createdAt: row.createdAt,
		ownerUserId: row.ownerUserId,
		lastCheck:
			row.checkGreen !== null && row.checkProxy && row.checkedAt
				? {
						green: row.checkGreen,
						proxy: row.checkProxy,
						at: row.checkedAt,
						missing: Array.isArray(row.checkMissing) ? row.checkMissing : null,
					}
				: null,
	}
}

/** Persist a server check result so it survives a powder restart. */
export async function saveServerCheck(
	id: string,
	result: StoredServerCheck & { missing: MissingPiece[] },
): Promise<void> {
	await db
		.update(servers)
		.set({
			checkGreen: result.green,
			checkProxy: result.proxy,
			checkedAt: result.at,
			checkMissing: result.missing,
		})
		.where(eq(servers.id, id))
}

/** Is a domain redirect set up for an app on this server (redirectRowInUse)? Then
 *  its Traefik needs the file provider (the server check). */
export async function serverRedirectsInUse(id: string): Promise<boolean> {
	const rows = await db
		.select({ wwwMode: domainRedirects.wwwMode, customRedirectsJson: domainRedirects.customRedirectsJson })
		.from(domainRedirects)
		.where(eq(domainRedirects.serverId, id))
	return rows.some(redirectRowInUse)
}

/** Store the network the server's Traefik routes over (traefik-network-run.ts). */
export async function saveTraefikNetwork(
	id: string,
	network: string,
	source: 'flag' | 'config' | 'attached' | 'default',
): Promise<void> {
	await db.update(servers).set({ traefikNetwork: network, traefikNetworkSource: source }).where(eq(servers.id, id))
}

// Admin-only: lists every server regardless of owner. For internal scans.
export async function listAllServers(): Promise<ServerRecord[]> {
	const rows = await db.select().from(servers)
	return rows.map(rowToRecord)
}

export async function getServer(id: string): Promise<ServerConfig | undefined> {
	const [row] = await db.select().from(servers).where(eq(servers.id, id))
	return row ? rowToConfig(row) : undefined
}

export async function createServer(input: {
	name: string
	host: string
	user?: string
	port?: number
	kind?: 'compose' | 'raw-docker'
	proxy?: 'nginx' | 'nginx-container' | 'traefik'
	ownerUserId: string
}): Promise<ServerRecord> {
	const id = createId(prefixes.server)
	const [row] = await db
		.insert(servers)
		.values({
			id,
			name: input.name,
			host: input.host,
			sshUser: input.user ?? 'root',
			sshPort: String(input.port ?? 22),
			kind: input.kind ?? 'compose',
			...(input.proxy ? { proxy: input.proxy } : {}),
			status: 'pending',
			ownerUserId: input.ownerUserId,
		})
		.returning()
	if (!row) throw new Error('failed to insert server')
	return rowToRecord(row)
}

// Raw editable settings (base_domain as stored, no per-server fallback).
export interface ServerSettingsRow {
	proxy: 'nginx' | 'nginx-container' | 'traefik'
	tlsMode: 'acme' | 'origin-cert'
	baseDomain: string | null
	ingressIp: string | null
	buildHost: string | null
}

export async function getServerSettings(id: string): Promise<ServerSettingsRow | undefined> {
	const [row] = await db
		.select({
			proxy: servers.proxy,
			tlsMode: servers.tlsMode,
			baseDomain: servers.baseDomain,
			ingressIp: servers.ingressIp,
			buildHost: servers.buildHost,
		})
		.from(servers)
		.where(eq(servers.id, id))
	return row
}

export async function updateServerSettings(
	id: string,
	patch: Partial<ServerSettingsRow>,
): Promise<ServerSettingsRow | undefined> {
	const [row] = await db.update(servers).set(patch).where(eq(servers.id, id)).returning({
		proxy: servers.proxy,
		tlsMode: servers.tlsMode,
		baseDomain: servers.baseDomain,
		ingressIp: servers.ingressIp,
		buildHost: servers.buildHost,
	})
	return row
}

export type DeleteServerResult =
	| { ok: true }
	| { ok: false; reason: 'unknown' }
	| { ok: false; reason: 'apps'; apps: string[] }

/** Deletes powder's record of a server, only when no app row points at it (previews
 *  hang off app rows, so none can be left either). There is no foreign key, so the
 *  check and the delete run in one transaction with the server row locked FOR UPDATE.
 *  App creation share-locks the same row (lockServerForAppCreate, lib/repos.ts): an
 *  app insert in flight makes this wait and then see the app; a delete in flight
 *  makes the insert wait and then find no server. */
export async function deleteServer(id: string): Promise<DeleteServerResult> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ id: servers.id })
			.from(servers)
			.where(eq(servers.id, id))
			.for('update')
		if (!row) return { ok: false as const, reason: 'unknown' as const }
		const apps = await tx
			.select({ name: appRepos.containerName })
			.from(appRepos)
			.where(eq(appRepos.serverId, id))
			.for('update')
		if (apps.length > 0)
			return { ok: false as const, reason: 'apps' as const, apps: apps.map((a) => a.name) }
		await tx.delete(servers).where(eq(servers.id, id))
		return { ok: true as const }
	})
}

export async function updateServerStatus(
	id: string,
	status: 'pending' | 'connected' | 'unreachable',
	error?: string | null,
): Promise<void> {
	await db
		.update(servers)
		.set({
			status,
			lastError: error ?? null,
			lastSeenAt: status === 'connected' ? new Date() : undefined,
		})
		.where(eq(servers.id, id))
}
