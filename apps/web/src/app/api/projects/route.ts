// Returns every project (app_repos row) the user has access to, enriched with
// the latest deploy status, the latest uptime check, and basic server info.
// Used by the /projects view to render a status dot that means "is this app
// actually up right now" rather than "did the last deploy succeed at some point."

import { requireUser, visibleRepos } from '@/lib/access'
import { appDomains, appEnvVars, appUptimeChecks, and, db, eq, inArray, isNull, sql } from '@/lib/db'
import { emptyDays } from '@/lib/deploy-days'
import { deployDaysFor } from '@/lib/deploy-days-db'
import { listAllServers } from '@/lib/servers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp

	// powder's own row to an admin session (its project page is a selfRead), never to a token.
	const repos = await visibleRepos(userOrResp, 'admin-session')
	if (repos.length === 0) {
		return Response.json({ projects: [] })
	}

	// Uptime status per app, one row per app_repo, written by the uptime ticker.
	const repoIds = repos.map((r) => r.id)
	const uptimeRows = await db
		.select({
			appRepoId: appUptimeChecks.appRepoId,
			url: appUptimeChecks.url,
			isUp: appUptimeChecks.isUp,
			lastCheckedAt: appUptimeChecks.lastCheckedAt,
			lastStatusCode: appUptimeChecks.lastStatusCode,
			lastDownAt: appUptimeChecks.lastDownAt,
		})
		.from(appUptimeChecks)
		.where(inArray(appUptimeChecks.appRepoId, repoIds))
	const uptimeById = new Map(uptimeRows.map((u) => [u.appRepoId, u]))

	// Latest deploy per (server_id, container_name), single distinct-on query.
	const latest = (await db.execute(sql`
		SELECT DISTINCT ON (server_id, container_name)
			server_id, container_name, id, status, kind, started_at, finished_at, git_sha, git_branch
		FROM deploys
		WHERE (server_id, container_name) IN (
			${sql.join(
				repos.map((r) => sql`(${r.serverId}, ${r.containerName})`),
				sql`, `,
			)}
		)
		ORDER BY server_id, container_name, started_at DESC
	`)) as unknown as Array<{
		server_id: string
		container_name: string
		id: string
		status: string
		kind: string
		started_at: string
		finished_at: string | null
		git_sha: string | null
		git_branch: string | null
	}>
	const latestByKey = new Map(
		latest.map((d) => [`${d.server_id}|${d.container_name}`, d]),
	)

	// Total deploy count per project.
	const counts = (await db.execute(sql`
		SELECT server_id, container_name, count(*)::int AS n
		FROM deploys
		WHERE (server_id, container_name) IN (
			${sql.join(
				repos.map((r) => sql`(${r.serverId}, ${r.containerName})`),
				sql`, `,
			)}
		)
		GROUP BY server_id, container_name
	`)) as unknown as Array<{ server_id: string; container_name: string; n: number }>
	const countByKey = new Map(counts.map((c) => [`${c.server_id}|${c.container_name}`, c.n]))

	// Live domain + env var count per app: one grouped query each, never per row.
	const domainRows = await db
		.select({ appRepoId: appDomains.appRepoId, hostname: appDomains.hostname })
		.from(appDomains)
		.where(and(inArray(appDomains.appRepoId, repoIds), isNull(appDomains.previewDeployId), eq(appDomains.status, 'live')))
		.orderBy(appDomains.createdAt)
	const domainById = new Map<string, string>()
	for (const d of domainRows) if (!domainById.has(d.appRepoId)) domainById.set(d.appRepoId, d.hostname)
	const envRows = await db
		.select({ appRepoId: appEnvVars.appRepoId, n: sql<number>`count(distinct ${appEnvVars.key})::int` })
		.from(appEnvVars)
		.where(and(inArray(appEnvVars.appRepoId, repoIds), eq(appEnvVars.scope, 'production')))
		.groupBy(appEnvVars.appRepoId)
	const envCountById = new Map(envRows.map((e) => [e.appRepoId, e.n]))

	// Deploys per day, last 30 days, for the strips on /projects.
	const daysByKey = await deployDaysFor(repos)

	const servers = await listAllServers()
	const serverById = new Map(servers.map((s) => [s.id, s]))

	const projects = repos.map((r) => {
		const key = `${r.serverId}|${r.containerName}`
		const ld = latestByKey.get(key)
		const server = serverById.get(r.serverId)
		const up = uptimeById.get(r.id) ?? null
		return {
			id: r.id,
			serverId: r.serverId,
			serverName: server?.name ?? r.serverId,
			// The server row's last SSH result; the list never SSHes per app.
			serverReachable: server?.status !== 'unreachable',
			containerName: r.containerName,
			repoUrl: r.repoUrl,
			branch: r.branch,
			hasPostgres: r.hasPostgres,
			createdAt: r.createdAt,
			domain: domainById.get(r.id) ?? null,
			envCount: envCountById.get(r.id) ?? 0,
			deployCount: countByKey.get(key) ?? 0,
			deployDays: daysByKey.get(key) ?? emptyDays(),
			lastDeploy: ld
				? {
					id: ld.id,
					status: ld.status,
					kind: ld.kind,
					startedAt: ld.started_at,
					finishedAt: ld.finished_at,
					gitSha: ld.git_sha,
					gitBranch: ld.git_branch,
				}
				: null,
			uptime: up
				? {
					url: up.url,
					isUp: up.isUp,
					lastCheckedAt: up.lastCheckedAt ? up.lastCheckedAt.toISOString() : null,
					lastStatusCode: up.lastStatusCode,
					lastDownAt: up.lastDownAt ? up.lastDownAt.toISOString() : null,
				}
				: null,
		}
	})
	// Sort by recency: most recent deploy first, then by created_at.
	projects.sort((a, b) => {
		const at = a.lastDeploy?.startedAt ?? a.createdAt.toString()
		const bt = b.lastDeploy?.startedAt ?? b.createdAt.toString()
		return bt.localeCompare(at)
	})

	return Response.json({ projects })
}
