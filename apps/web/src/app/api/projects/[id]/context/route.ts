import { requireProjectAccess } from '@/lib/access'
import { and, db, deploys, desc, eq } from '@/lib/db'
import { managedContainerNames } from '@/lib/managed-containers'
import { getServer } from '@/lib/servers'
import { getContainerHostNetInfo, getNginxRoutes, inspectContainer } from '@/lib/ssh'
import { dashboardUrl, webhookBaseUrl } from '@/lib/hosts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// One-shot canonical snapshot for an app: the endpoint coding agents and the CLI call when
// it needs to know the truth about where this app lives, what serves it, and
// where it last deployed. Returns structured JSON; do not change keys without
// version-bumping CLI/MCP consumers.
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id, { selfRead: true })
	if (access instanceof Response) return access
	const { repo } = access

	// Authorization: admin or owner.

	const server = await getServer(repo.serverId)
	if (!server) return Response.json({ error: 'server not found' }, { status: 500 })

	let workingDir: string | null = null
	let configFile: string | null = null
	let envPort: number | null = null
	let networkMode: string | null = null
	let traefikHosts: string[] = []
	let containerState: string | null = null
	const hostPorts: number[] = []
	try {
		const detail = await inspectContainer(server, repo.containerName)
		workingDir = detail.compose.workingDir
		configFile = detail.compose.configFile
		containerState = detail.state
		for (const portStr of detail.ports) {
			const m = portStr.match(/:(\d+)\s*→/)
			if (m) hostPorts.push(Number(m[1]))
		}
	} catch {
		// container not running (yet) — fine, return what we know
	}

	let hostnames: string[] = []
	try {
		const [nginxRoutes, netInfo] = await Promise.all([
			managedContainerNames(server.id).then((names) => getNginxRoutes(server, names)),
			getContainerHostNetInfo(server, [repo.containerName]),
		])
		const info = netInfo.get(repo.containerName)
		envPort = info?.envPort ?? null
		networkMode = info?.networkMode ?? null
		traefikHosts = info?.traefikHosts ?? []
		const ports = new Set(hostPorts)
		if (info?.networkMode === 'host' && info.envPort) ports.add(info.envPort)
		const hosts = new Set<string>()
		for (const route of nginxRoutes) {
			if (!route.host) continue
			const isLocalhost = route.host === '127.0.0.1' || route.host === 'localhost'
			const portMatchesContainer = route.port != null && ports.has(route.port)
			const dnsMatchesContainer =
				route.host === repo.containerName || route.host === info?.composeService
			if ((isLocalhost && portMatchesContainer) || dnsMatchesContainer) {
				for (const u of route.urls) {
					try {
						hosts.add(new URL(u).host)
					} catch {
						// ignore
					}
				}
			}
		}
		for (const t of traefikHosts) hosts.add(t)
		hostnames = [...hosts].sort()
	} catch {
		// network discovery failed — return whatever we have
	}

	const recentDeploys = await db
		.select({
			id: deploys.id,
			status: deploys.status,
			startedAt: deploys.startedAt,
			finishedAt: deploys.finishedAt,
			gitSha: deploys.gitSha,
			gitBranch: deploys.gitBranch,
		})
		.from(deploys)
		// Keyed on server AND container: the same name can be an app on another server.
		.where(and(eq(deploys.serverId, repo.serverId), eq(deploys.containerName, repo.containerName)))
		.orderBy(desc(deploys.startedAt))
		.limit(5)

	return Response.json({
		project: {
			id: repo.id,
			containerName: repo.containerName,
			repoUrl: repo.repoUrl,
			branch: repo.branch,
			ownerUserId: repo.ownerUserId,
		},
		server: {
			id: server.id,
			name: server.name,
			host: server.host,
			kind: server.kind,
		},
		container: {
			workingDir,
			configFile,
			state: containerState,
			hostPorts,
			networkMode,
			envPort,
			composeAvailable: workingDir != null,
		},
		hostnames,
		traefikHosts,
		recentDeploys: recentDeploys.map((d) => ({
			...d,
			startedAt: d.startedAt instanceof Date ? d.startedAt.toISOString() : d.startedAt,
			finishedAt:
				d.finishedAt instanceof Date ? d.finishedAt.toISOString() : d.finishedAt,
		})),
		links: {
			dashboard: `${dashboardUrl()}/projects`,
			logs: `${dashboardUrl()}/projects`,
			webhook: `${webhookBaseUrl(_req.headers)}/api/webhooks/deploy/<token>`,
		},
		operations: {
			deploy: `git push origin ${repo.branch}`,
			containerLogs: `ssh root@${server.host} 'docker logs ${repo.containerName} --tail 100 -f'`,
			manualRebuild: workingDir
				? `ssh root@${server.host} 'cd ${workingDir} && docker compose build ${repo.containerName} && docker compose up -d --force-recreate ${repo.containerName}' (before up: if the image has label powder.release.cmd, run: docker compose run --rm --no-deps -T --entrypoint sh <svc> -c "<cmd>" ; or redeploy through powder)`
				: null,
		},
	})
}
