import { requireContainerAccess } from '@/lib/access'
import { and, appRepos, db, deploys, eq } from '@/lib/db'
import { spawnSnapshot } from '@/lib/deploy-snapshots'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
	_req: Request,
	ctx: { params: Promise<{ id: string; name: string; deployId: string }> },
) {
	const { id, name, deployId } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const [deploy] = await db.select().from(deploys).where(eq(deploys.id, deployId))
	if (!deploy) return Response.json({ error: 'unknown deploy' }, { status: 404 })
	if (deploy.serverId !== id || deploy.containerName !== name) {
		return Response.json({ error: 'forbidden' }, { status: 403 })
	}

	const [repo] = await db
		.select()
		.from(appRepos)
		.where(and(eq(appRepos.serverId, id), eq(appRepos.containerName, name)))
	if (!repo) return Response.json({ error: 'no app_repos row' }, { status: 400 })

	try {
		const { url, expiresAt } = await spawnSnapshot(deploy, repo)
		return Response.json({
			ok: true,
			url,
			expiresAt: expiresAt.toISOString(),
			expiresInMinutes: 60,
		})
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'snapshot failed', 'servers/:id/containers/:name/deploys/:deployId/snapshot') },
			{ status: 500 },
		)
	}
}
