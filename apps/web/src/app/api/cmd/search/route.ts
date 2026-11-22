// Cmd+K palette backend. One request per keystroke, keep it cheap:
// only DB reads, no SSH, no external calls. Returns projects + recent deploys
// + a static actions list scoped to what's possible from the matched project.

import { requireUser, visibleRepos } from '@/lib/access'
import { and, deploys, eq, db, desc, or } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CmdProject {
	id: string
	containerName: string
	serverId: string
	repoUrl: string
}

interface CmdDeploy {
	id: string
	containerName: string
	serverId: string
	appRepoId: string | null
	status: string
	kind: string
	startedAt: string
	gitSha: string | null
}

interface CmdAction {
	id: string
	label: string
	subtitle?: string
	hint?: string
	href: string
}

interface CmdSearchResponse {
	projects: CmdProject[]
	deploys: CmdDeploy[]
	actions: CmdAction[]
}

export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const user = userOrResp

	const url = new URL(req.url)
	const q = url.searchParams.get('q')?.trim().toLowerCase() ?? ''

	// Projects, filter the user's app_repos by container name substring.
	const allRepos = await visibleRepos(user, 'admin-session')
	const repos = q
		? allRepos.filter((r) => r.containerName.toLowerCase().includes(q))
		: allRepos
	const projects: CmdProject[] = repos.slice(0, 8).map((r) => ({
		id: r.id,
		containerName: r.containerName,
		serverId: r.serverId,
		repoUrl: r.repoUrl,
	}))

	// Recent deploys, last 8 across the user's apps. If user typed something,
	// filter to deploys whose container_name matches.
	const repoKeys = allRepos.map((r) => `${r.serverId}|${r.containerName}`)
	const repoIdByKey = new Map(
		allRepos.map((r) => [`${r.serverId}|${r.containerName}`, r.id]),
	)
	let recentDeploys: typeof deploys.$inferSelect[] = []
	if (repoKeys.length > 0 && repos.length > 0) {
		// Cheap version: pull last 30 deploys for user's repos, filter in-memory.
		// Matched per (server, container) pair: two name and server lists crossed
		// would also match an app's name on another of the servers.
		recentDeploys = await db
			.select()
			.from(deploys)
			.where(
				or(
					...repos.map((r) =>
						and(eq(deploys.serverId, r.serverId), eq(deploys.containerName, r.containerName)),
					),
				),
			)
			.orderBy(desc(deploys.startedAt))
			.limit(30)
	}
	const filteredDeploys = q
		? recentDeploys.filter(
				(d) =>
					d.containerName.toLowerCase().includes(q) ||
					(d.gitSha?.toLowerCase().includes(q) ?? false),
			)
		: recentDeploys
	const cmdDeploys: CmdDeploy[] = filteredDeploys.slice(0, 8).map((d) => ({
		id: d.id,
		containerName: d.containerName,
		serverId: d.serverId,
		appRepoId: repoIdByKey.get(`${d.serverId}|${d.containerName}`) ?? null,
		status: d.status,
		kind: d.kind,
		startedAt: d.startedAt.toISOString(),
		gitSha: d.gitSha,
	}))

	// Actions, context-aware. If exactly one project matches, offer
	// project-scoped actions (redeploy/logs/domains). Always offer global
	// actions (new project, activity).
	const actions: CmdAction[] = []
	const p = projects.length === 1 ? projects[0] : undefined
	if (p) {
		actions.push(
			{
				id: 'redeploy',
				label: `redeploy ${p.containerName}`,
				subtitle: 'POST /api/projects/[id]/redeploy',
				href: `/projects/${p.id}#redeploy`,
			},
			{
				id: 'open-deploys',
				label: `open ${p.containerName} deployments`,
				href: `/projects/${p.id}/deployments`,
			},
			{
				id: 'open-domains',
				label: `manage ${p.containerName} domains`,
				href: `/projects/${p.id}/domains`,
			},
			{
				id: 'open-logs',
				label: `open ${p.containerName} logs`,
				href: `/projects/${p.id}/logs`,
			},
			{
				id: 'open-env',
				label: `open ${p.containerName} env vars`,
				href: `/projects/${p.id}/env`,
			},
			{
				id: 'open-crons',
				label: `open ${p.containerName} crons`,
				href: `/projects/${p.id}/crons`,
			},
			{
				id: 'open-backups',
				label: `open ${p.containerName} backups`,
				href: `/projects/${p.id}/backups`,
			},
		)
	}
	const globalActions: CmdAction[] = [
		{ id: 'apps', label: 'apps', hint: 'every app', href: '/projects' },
		{ id: 'new', label: 'new app', hint: 'import a GitHub repo', href: '/new' },
		{ id: 'deploys', label: 'deploys', hint: 'every deploy on all servers', href: '/deploys' },
		{ id: 'servers', label: 'servers', href: '/servers' },
		{ id: 'activity', label: 'activity', hint: 'restarts, env changes, failures, backups', href: '/activity' },
		{ id: 'settings', label: 'settings', hint: 'integrations, API tokens, users', href: '/settings' },
		{ id: 'domains', label: 'domains', hint: 'redirects on all servers', href: '/domains' },
		{ id: 'databases', label: 'databases', href: '/databases' },
	]
	for (const a of globalActions) {
		if (!q || a.label.toLowerCase().includes(q) || a.hint?.toLowerCase().includes(q)) {
			actions.push(a)
		}
	}

	const body: CmdSearchResponse = { projects, deploys: cmdDeploys, actions }
	return Response.json(body)
}
