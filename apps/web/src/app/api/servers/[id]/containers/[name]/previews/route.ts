import { requireContainerAccess } from '@/lib/access'
import { and, appRepos, db, eq, previewDeploys } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const repos = await db
		.select()
		.from(appRepos)
		.where(and(eq(appRepos.serverId, id), eq(appRepos.containerName, name)))
	const repo = repos[0]
	if (!repo) return Response.json({ previews: [] })

	const previews = await db
		.select()
		.from(previewDeploys)
		.where(eq(previewDeploys.appRepoId, repo.id))
	return Response.json({ previews })
}
