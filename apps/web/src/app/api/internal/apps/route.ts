// App ops summary for an external ops hub's action panel: where the container runs, its
// recent deploys (with ids so rollback can target one), and env key names.
// Admin-token only. Values are never returned — only key + preview.
//
// The hub then drives the EXISTING user-facing routes with the same bearer:
//   POST /api/projects/{repoId}/redeploy
//   POST /api/servers/{serverId}/containers/{name}/restart
//   POST /api/servers/{serverId}/containers/{name}/rollback {targetDeployId}
//   GET  /api/servers/{serverId}/containers/{name}/logs?tail=
//   PUT  /api/projects/{repoId}/env {key,value}
// This route only exists because the hub has no way to map a project name
// to (repoId, serverId) — everything else was already there.
//
// container_name is unique per server only. When the same name exists on two
// servers, callers must pass ?server= — otherwise 409, never a guess (a guess
// would aim redeploy/restart/env at the wrong server). ?deploys= (1-50, default
// 10) widens the deploy list for callers hunting an older rollback target.

import { requireUser } from '@/lib/access'
import { and, appEnvVars, appRepos, db, deploys, desc, eq } from '@/lib/db'
import { isPowderSelfContainer } from '@/lib/secret-mask'
import { safeStoredPreview, redactNullable } from '@/lib/secret-text'
import { getServer } from '@/lib/servers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	if (!userOrResp.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })

	const params = new URL(req.url).searchParams
	const project = params.get('project')?.trim()
	if (!project) return Response.json({ error: 'project required' }, { status: 400 })
	// powder's own rows (the same names isPowderSelfContainer / selfDeployNames
	// give every container route) answer the plain 404 to a bearer token, before any
	// lookup, so a token cannot read powder's deploys or env key names (or learn from a
	// 409 on which servers it runs). An admin browser session still sees them.
	if (userOrResp.viaToken === true && isPowderSelfContainer(project))
		return Response.json({ error: 'not found' }, { status: 404 })
	const serverId = params.get('server')?.trim() || null
	const deployLimit = Math.min(50, Math.max(1, Number(params.get('deploys')) || 10))

	const repos = await db
		.select()
		.from(appRepos)
		.where(
			serverId
				? and(eq(appRepos.containerName, project), eq(appRepos.serverId, serverId))
				: eq(appRepos.containerName, project),
		)
	if (repos.length > 1) {
		return Response.json(
			{ error: `${project} exists on ${repos.map((r) => r.serverId).join(', ')} — pass ?server=` },
			{ status: 409 },
		)
	}
	const repo = repos[0]
	if (!repo) return Response.json({ error: 'not found' }, { status: 404 })

	const server = await getServer(repo.serverId)

	const recent = await db
		.select({
			id: deploys.id,
			kind: deploys.kind,
			status: deploys.status,
			startedAt: deploys.startedAt,
			finishedAt: deploys.finishedAt,
			gitSha: deploys.gitSha,
			gitBranch: deploys.gitBranch,
			imageTag: deploys.imageTag,
			triggeredBy: deploys.triggeredBy,
			failedStep: deploys.failedStep,
			errorSummary: deploys.errorSummary,
		})
		.from(deploys)
		.where(and(eq(deploys.serverId, repo.serverId), eq(deploys.containerName, project)))
		.orderBy(desc(deploys.startedAt))
		.limit(deployLimit)

	const envRows = await db
		.select({ key: appEnvVars.key, preview: appEnvVars.valuePreview, updatedAt: appEnvVars.updatedAt, scope: appEnvVars.scope })
		.from(appEnvVars)
		.where(eq(appEnvVars.appRepoId, repo.id))

	return Response.json({
		repo: {
			id: repo.id,
			containerName: repo.containerName,
			repoUrl: repo.repoUrl,
			branch: repo.branch,
			hasPostgres: repo.hasPostgres,
		},
		server: server
			? { id: server.id, name: server.name, host: server.host, kind: server.kind }
			: { id: repo.serverId, name: repo.serverId, host: null, kind: null },
		// an explicit pick: no deploy text leaves unmasked (failed_step comes from script output)
		deploys: recent.map((d) => ({
			id: d.id,
			kind: d.kind,
			status: d.status,
			gitSha: d.gitSha,
			gitBranch: d.gitBranch,
			imageTag: d.imageTag,
			triggeredBy: d.triggeredBy,
			failedStep: redactNullable(d.failedStep),
			errorSummary: redactNullable(d.errorSummary),
			startedAt: d.startedAt?.toISOString() ?? null,
			finishedAt: d.finishedAt?.toISOString() ?? null,
		})),
		env: envRows
			.filter((e) => e.scope === 'production')
			.map((e) => ({
				key: e.key,
				preview: safeStoredPreview(e.preview),
				updatedAt: e.updatedAt?.toISOString() ?? null,
			}))
			.sort((a, b) => a.key.localeCompare(b.key)),
	})
}
