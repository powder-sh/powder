// List of domains visible to the user, with current redirect config (if any)
// from domain_redirects.

import { requireUser, visibleRepos } from '@/lib/access'
import {
	type CustomRedirect,
	detectExistingRedirect,
	detectProxyKind,
} from '@/lib/domain-redirects'
import { domainRedirects, db, inArray } from '@/lib/db'
import { redactNullable } from '@/lib/secret-text'
import { managedContainerNames } from '@/lib/managed-containers'
import { getServer, listAllServers, type ServerConfig } from '@/lib/servers'
import {
	extractHostPorts,
	getContainerHostNetInfo,
	getNginxRoutes,
	listContainers,
	runCommand,
} from '@/lib/ssh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Row {
	serverId: string
	serverName: string
	containerName: string
	hostname: string
	urls: string[]
	proxyKind: ReturnType<typeof detectProxyKind>
	wwwMode: 'none' | 'apex' | 'www'
	custom: CustomRedirect[]
	appliedAt: string | null
	appliedError: string | null
	existingRedirect: 'apex' | 'www' | null
}

// Per-server work — listContainers + nginx routes + container netinfo + nginx
// dump + row assembly. Pulled out so we can:
//   1. Run per-server in parallel across all servers via Promise.all (was
//      sequential for...of, N servers x 4 SSH calls each)
//   2. Call once for `?app=` fast path (single server only)
async function rowsForServer(
	server: ServerConfig,
	reposByKey: Map<string, { serverId: string; containerName: string }>,
	cfgByKey: Map<string, typeof domainRedirects.$inferSelect>,
	containerFilter: string | null,
): Promise<Row[]> {
	try {
		const [containers, routes] = await Promise.all([
			listContainers(server),
			managedContainerNames(server.id).then((names) => getNginxRoutes(server, names)),
		])
		const filteredContainers = containerFilter
			? containers.filter((c) => c.name === containerFilter)
			: containers
		if (filteredContainers.length === 0) return []
		const netInfo = await getContainerHostNetInfo(
			server,
			filteredContainers.map((c) => c.name),
		)

		// Pull merged nginx config once per server for the "already handled"
		// detection. Cheap (one ssh) compared to per-domain queries.
		const proxy = detectProxyKind(server)
		let mergedNginx = ''
		if (proxy === 'nginx-host') {
			const r = await runCommand(
				server,
				`{ cat /etc/nginx/sites-enabled/*; cat /etc/nginx/conf.d/*.conf 2>/dev/null; } 2>/dev/null`,
				8_000,
			).catch(() => ({ stdout: '' }))
			mergedNginx = r.stdout
		} else if (proxy === 'nginx-container') {
			const r = await runCommand(
				server,
				`docker exec nginx nginx -T 2>/dev/null`,
				10_000,
			).catch(() => ({ stdout: '' }))
			mergedNginx = r.stdout
		}

		const rows: Row[] = []
		for (const c of filteredContainers) {
			const info = netInfo.get(c.name)
			const hostPorts = new Set(extractHostPorts(c.ports))
			if (info?.networkMode === 'host' && info.envPort) hostPorts.add(info.envPort)
			const dnsNames = new Set<string>()
			if (info?.composeService) dnsNames.add(info.composeService)
			dnsNames.add(c.name)

			const urlSet = new Set<string>()
			for (const route of routes) {
				if (!route.host) continue
				const isLocal = route.host === '127.0.0.1' || route.host === 'localhost'
				const portMatch = route.port != null && hostPorts.has(route.port)
				const dnsMatch = dnsNames.has(route.host)
				if ((isLocal && portMatch) || dnsMatch) {
					for (const u of route.urls) {
						if (!u.includes('://*.')) urlSet.add(u)
					}
				}
			}

			// Group by APEX (strip www.) so each domain shows once.
			const apexes = new Set<string>()
			for (const u of urlSet) {
				try {
					apexes.add(new URL(u).host.replace(/^www\./, ''))
				} catch {
					// skip invalid
				}
			}
			if (apexes.size === 0) continue

			for (const apex of apexes) {
				const cfg = cfgByKey.get(`${server.id}|${c.name}|${apex}`)
				const existingRedirect = mergedNginx
					? detectExistingRedirect(mergedNginx, apex)
					: null
				rows.push({
					serverId: server.id,
					serverName: server.name,
					containerName: c.name,
					hostname: apex,
					urls: [...urlSet]
						.filter((u) => {
							try {
								return new URL(u).host.replace(/^www\./, '') === apex
							} catch {
								return false
							}
						})
						.sort(),
					proxyKind: proxy,
					wwwMode: (cfg?.wwwMode as Row['wwwMode']) ?? 'none',
					custom: cfg ? safeParse(cfg.customRedirectsJson) : [],
					appliedAt: cfg?.appliedAt ? cfg.appliedAt.toISOString() : null,
					appliedError: redactNullable(cfg?.appliedError),
					existingRedirect,
				})
			}
		}
		return rows
	} catch {
		// non-fatal — return empty rows for this server
		return []
	}
}

export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const user = userOrResp

	const url = new URL(req.url)
	const appFilter = url.searchParams.get('app')?.trim() || null

	const repos = await visibleRepos(user, 'admin-session')
	const reposByKey = new Map(repos.map((r) => [`${r.serverId}|${r.containerName}`, r]))

	// Existing redirect config on the servers of the apps this user sees, keyed by
	// (server, container, hostname) like every write of it. Never by owner_user_id: a row
	// saved by a user who was removed later still belongs to the app.
	const serverIds = [...new Set(repos.map((r) => r.serverId))]
	const cfgRows = serverIds.length
		? await db.select().from(domainRedirects).where(inArray(domainRedirects.serverId, serverIds))
		: []
	const cfgByKey = new Map(cfgRows.map((r) => [`${r.serverId}|${r.containerName}|${r.hostname}`, r]))

	// `?app=name` fast path: only fan out to the one server hosting that app.
	if (appFilter) {
		const repo = repos.find((r) => r.containerName === appFilter)
		if (!repo) return Response.json({ domains: [] })
		const server = await getServer(repo.serverId)
		if (!server) return Response.json({ domains: [] })
		const rows = await rowsForServer(server, reposByKey, cfgByKey, appFilter)
		rows.sort((a, b) => a.hostname.localeCompare(b.hostname))
		return Response.json({ domains: rows })
	}

	const servers = await listAllServers()
	// Parallel across servers; one SSH round trip per server.
	const perServer = await Promise.all(
		servers.map((s) => rowsForServer(s, reposByKey, cfgByKey, null)),
	)
	const out = perServer.flat()
	out.sort((a, b) => a.hostname.localeCompare(b.hostname))
	return Response.json({ domains: out })
}

function safeParse(s: string): CustomRedirect[] {
	try {
		const v = JSON.parse(s)
		return Array.isArray(v) ? (v as CustomRedirect[]) : []
	} catch {
		return []
	}
}
