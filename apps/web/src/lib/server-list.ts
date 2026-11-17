import { isValidHostname, newChallenge } from '@/lib/app-domains'
import { and, appDomains, appRepos, createId, db, deploys, desc, eq, prefixes, sql } from '@/lib/db'
import { managedContainerNames } from '@/lib/managed-containers'
import { maybeBackgroundCheck } from '@/lib/server-bootstrap-run'
import { listAllServers, updateServerStatus } from '@/lib/servers'
import {
	extractHostPorts,
	getContainerHostNetInfo,
	getNginxRoutes,
	listContainers,
} from '@/lib/ssh'
import { getPinnedFingerprint } from '@/lib/ssh-host-keys'

// Server list + discovery sync, shared by GET /api/servers (sync=false, no
// writes) and POST /api/servers/sync (sync=true: server status, discovered
// domains, stale-failure reconcile rows). Moved out of the route so the sync
// has its own path and therefore its own token scope.

export async function buildServerList(sync: boolean): Promise<Response> {
	const allServers = await listAllServers()
	const results = await Promise.all(
		allServers.map(async (server) => {
			try {
				// per-container repo + latest deploy from db (single query each, then map)
				const repos = await db.select().from(appRepos).where(eq(appRepos.serverId, server.id))
				const [containers, nginxRoutes] = await Promise.all([
					listContainers(server),
					// the app containers AND their preview containers.
					managedContainerNames(server.id).then((names) => getNginxRoutes(server, names)),
				])
				const netInfo = await getContainerHostNetInfo(
					server,
					containers.map((c) => c.name),
				)
				const repoByContainer = new Map(repos.map((r) => [r.containerName, r]))

				// latest deploy per container - single query using DISTINCT ON
				const latestDeploys = (await db.execute(sql`
					SELECT DISTINCT ON (container_name) container_name, id, status, kind, started_at, finished_at, git_sha
					FROM deploys
					WHERE server_id = ${server.id}
					ORDER BY container_name, started_at DESC
				`)) as unknown as Array<{
					container_name: string
					id: string
					status: string
					kind: string
					started_at: string
					finished_at: string | null
					git_sha: string | null
				}>
				const latestByContainer = new Map(latestDeploys.map((r) => [r.container_name, r]))

				// Infrastructure containers (reverse proxy, shared db, monitoring, etc.) are
				// hidden from the server list. They're not user apps, they're never going to
				// be git-deployed, and they make every server look half-broken with "not
				// connected" rows. Admins can still see them on the server detail page.
				const isInfra = (name: string, image: string) => {
					if (repoByContainer.has(name)) return false
					const n = name.toLowerCase()
					const i = image.toLowerCase()
					const infraImages = [
						'nginx',
						'traefik',
						'caddy',
						'haproxy',
						'postgres',
						'mysql',
						'mariadb',
						'mongo',
						'redis',
						'memcached',
						'pgvector/pgvector',
						'rabbitmq',
						'meilisearch',
						'minio',
						'louislam/uptime-kuma',
						'prom/prometheus',
						'grafana/grafana',
					]
					if (infraImages.some((p) => i.startsWith(p) || i.includes('/' + p))) return true
					const infraNamePatterns = [
						/^[a-z0-9]+(?:-[a-z0-9]+)*-(nginx|postgres|redis|kuma)-\d+$/,
						/^(nginx|traefik|postgres|redis|kuma|prometheus|grafana)$/,
						/^(nginx|postgres|redis)-\d+$/,
					]
					return infraNamePatterns.some((re) => re.test(n))
				}

				const visibleContainers = containers.filter((c) => !isInfra(c.name, c.image))

				const containersWithUrls = visibleContainers.map((c) => {
					const info = netInfo.get(c.name)
					const hostPorts = new Set(extractHostPorts(c.ports))
					if (info?.networkMode === 'host' && info.envPort) hostPorts.add(info.envPort)
					const dnsNames = new Set<string>()
					if (info?.composeService) dnsNames.add(info.composeService)
					dnsNames.add(c.name)

					const urls = new Set<string>()
					for (const route of nginxRoutes) {
						if (!route.host) continue
						const isLocalhost = route.host === '127.0.0.1' || route.host === 'localhost'
						const portMatchesContainer = route.port != null && hostPorts.has(route.port)
						const dnsMatchesContainer = dnsNames.has(route.host)
						if ((isLocalhost && portMatchesContainer) || dnsMatchesContainer) {
							for (const u of route.urls) {
								// Keep wildcards (`https://*.foo.com`) so users see that the app
								// catches subdomains. They render as text (not clickable) but are
								// informational - useful for tenant-routing apps.
								urls.add(u)
							}
						}
					}
					// only these (host nginx, proxy containers powder does not manage)
					// may become app_domains rows; container labels are app-controlled.
					const persistable = [...urls]
					// Traefik-routed apps (no nginx). Pull hostnames straight from
					// the container's traefik.http.routers.*.rule labels (display only).
					if (info?.traefikHosts) {
						for (const host of info.traefikHosts) {
							if (!host.includes('*')) urls.add(`https://${host}`)
						}
					}

					const repo = repoByContainer.get(c.name)
					const ld = latestByContainer.get(c.name)

					return {
						...c,
						urls: dedupeWwwVariants([...urls]),
						persistUrls: dedupeWwwVariants(persistable),
						repo: repo
							? {
									repoUrl: repo.repoUrl,
									branch: repo.branch,
								}
							: null,
						lastDeploy: ld
							? {
									id: ld.id,
									status: ld.status,
									kind: ld.kind,
									startedAt: ld.started_at,
									finishedAt: ld.finished_at,
									gitSha: ld.git_sha,
								}
							: null,
					}
				})
				if (sync && server.status !== 'connected') {
					await updateServerStatus(server.id, 'connected', null)
				}
				// Persist discovered hostnames into app_domains so they exist as queryable
				// truth (not only the ones the custom-domain wizard adds).
				// Fire-and-forget: a failed write must not break the dashboard render.
				if (sync) void persistDiscoveredDomains(containersWithUrls).catch(() => {})
				// Reconcile dashboard truth with reality. If the running image is a
				// registry-mode image (ghcr.io/...) but the last deploys row is failed,
				// the failure log is misleading - the container actually rolled forward
				// (manual fix, an image pushed after the deploy failed, etc). Write a synthetic
				// success row so the dashboard stops showing red on a working app.
				if (sync) void reconcileStaleFailures(server.id, containersWithUrls).catch(() => {})
				// Keep the server check fresh without anyone pressing "check now": a sync
				// that reached the server re-runs the read-only check once a day (persisted); one run per server at a
				// time, and a failed attempt waits BACKGROUND_RETRY_MS before the next.
				if (sync) void maybeBackgroundCheck(server)?.catch(() => {})
				return {
					id: server.id,
					name: server.name,
					host: server.host,
					hostKeyFingerprint: await getPinnedFingerprint(server.host, server.port),
					kind: server.kind,
					proxy: server.proxy ?? 'nginx',
					tlsMode: server.tlsMode ?? 'acme',
					baseDomain: server.baseDomain ?? null,
					status: 'connected' as const,
					reachable: true,
					containers: containersWithUrls.map(({ persistUrls: _p, ...c }) => c),
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'unknown error'
				if (sync) await updateServerStatus(server.id, 'unreachable', msg)
				return {
					id: server.id,
					name: server.name,
					host: server.host,
					hostKeyFingerprint: await getPinnedFingerprint(server.host, server.port),
					kind: server.kind,
					proxy: server.proxy ?? 'nginx',
					tlsMode: server.tlsMode ?? 'acme',
					baseDomain: server.baseDomain ?? null,
					status: 'unreachable' as const,
					reachable: false,
					error: msg,
					containers: [],
				}
			}
		}),
	)

	return Response.json({ servers: results })
}

// If a container is running a registry image (ghcr.io/...) but the most recent
// deploys row says `failed`, the failed log is misleading - reality moved on.
// Write a synthetic success row tagged kind=image_update, triggered_by=reconcile.
// Idempotent: only emits one reconcile per (server, container) until the next
// real deploy arrives. Identified by the synthetic `triggered_by` value.
async function reconcileStaleFailures(
	serverId: string,
	containers: Array<{
		name: string
		image: string
		repo: { repoUrl: string; branch: string } | null
		lastDeploy: { id: string; status: string; kind: string } | null
	}>,
): Promise<void> {
	for (const c of containers) {
		if (!c.repo) continue
		if (!c.image.startsWith('ghcr.io/')) continue
		if (!c.lastDeploy || c.lastDeploy.status !== 'failed') continue

		// Already reconciled? Don't pile up duplicate rows.
		const [recent] = await db
			.select({ triggeredBy: deploys.triggeredBy })
			.from(deploys)
			.where(and(eq(deploys.serverId, serverId), eq(deploys.containerName, c.name)))
			.orderBy(desc(deploys.startedAt))
			.limit(1)
		if (recent?.triggeredBy === 'reconcile') continue

		await db.insert(deploys).values({
			id: createId(prefixes.deploy),
			serverId,
			containerName: c.name,
			kind: 'image_update',
			status: 'success',
			startedAt: new Date(),
			finishedAt: new Date(),
			triggeredBy: 'reconcile',
			imageTag: c.image,
			output: `dashboard reconcile: container is running ${c.image} but last deploy log was failed. Reality wins - recording synthetic success so the row reflects the live state.`,
		})
	}
}

// Background upsert: for every container we just rendered, persist the hostnames
// we discovered into app_domains. Scraped labels are NOT proof of
// ownership (a tenant image can carry any Host() label), so they are inserted
// as 'pending' and never promoted to 'live' here; verification does that.
// only hostnames from host nginx and from proxy containers powder does not
// manage are persisted (never Traefik labels, never an app's own nginx), never a
// hostname another row already holds, and addDomain may take over such a pending
// row, so a discovered row can never block the real owner.
// Idempotent - uses the existing (app_repo_id, hostname) unique index.
export async function persistDiscoveredDomains(
	containers: Array<{
		name: string
		/** hostnames from sources the app cannot write (host nginx, proxy
		 *  containers powder does not manage). Container labels are never persisted. */
		persistUrls?: string[]
		repo: { repoUrl: string; branch: string } | null
	}>,
): Promise<void> {
	const allRepos = await db.select().from(appRepos)
	const repoIdByContainer = new Map<string, string>()
	for (const r of allRepos) repoIdByContainer.set(r.containerName, r.id)
	// a hostname any app already has a row for is never inserted again
	// (the global unique index would make it a silent no-op at best).
	const claimed = new Set(
		(
			(await db.select({ hostname: appDomains.hostname }).from(appDomains)) as Array<{
				hostname?: unknown
			}>
		)
			.map((r) => (typeof r.hostname === 'string' ? r.hostname.toLowerCase() : ''))
			.filter(Boolean),
	)

	for (const c of containers) {
		const repoId = repoIdByContainer.get(c.name)
		if (!repoId) continue
		const urls = c.persistUrls ?? []
		if (urls.length === 0) continue

		const hostnames = new Set<string>()
		for (const u of urls) {
			try {
				const h = new URL(u).hostname.toLowerCase()
				// the URL parser lets backtick, $, , &, quotes and ;
				// through; the hostname later lands in a Traefik Host() rule.
				if (isValidHostname(h)) hostnames.add(h)
				else if (!h.includes('*'))
					console.warn(
						`[servers] ${c.name}: ignoring invalid discovered hostname ${JSON.stringify(h).slice(0, 120)}`,
					)
			} catch {
				// skip
			}
		}
		if (hostnames.size === 0) continue

		const existing = await db.select().from(appDomains).where(eq(appDomains.appRepoId, repoId))
		const existingByHost = new Map(existing.map((r) => [r.hostname, r]))

		for (const hostname of hostnames) {
			if (existingByHost.has(hostname) || claimed.has(hostname)) continue
			claimed.add(hostname)
			await db
				.insert(appDomains)
				.values({
					id: createId(prefixes.appDomain),
					appRepoId: repoId,
					hostname,
					status: 'pending',
					verifyChallenge: newChallenge(),
				})
				.onConflictDoNothing()
		}
	}
}

// Collapse `www.x.com` and `x.com` to a single canonical entry, preferring non-www.
// Keeps distinct domains separate (e.g. acme.com + foo.com both kept).
function dedupeWwwVariants(urls: string[]): string[] {
	const byBase = new Map<string, string>()
	for (const url of urls) {
		try {
			const u = new URL(url)
			const baseHost = u.host.replace(/^www\./, '')
			const existing = byBase.get(baseHost)
			if (!existing) {
				byBase.set(baseHost, url)
			} else if (existing.includes('://www.') && !u.host.startsWith('www.')) {
				byBase.set(baseHost, url)
			}
		} catch {
			byBase.set(url, url)
		}
	}
	return [...byBase.values()].sort()
}
