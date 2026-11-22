import { requireContainerAccess } from '@/lib/access'
import { and, appRepos, db, eq, previewDeploys } from '@/lib/db'
import { tearDownPreview } from '@/lib/preview-deploys'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
	_req: Request,
	ctx: { params: Promise<{ id: string; name: string; previewId: string }> },
) {
	const { id, name, previewId } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	// Scope the preview to THIS container's app — the access check above only
	// proves access to (id, name), not to whichever preview id was passed.
	const [preview] = await db
		.select({ id: previewDeploys.id })
		.from(previewDeploys)
		.innerJoin(appRepos, eq(appRepos.id, previewDeploys.appRepoId))
		.where(
			and(
				eq(previewDeploys.id, previewId),
				eq(appRepos.serverId, id),
				eq(appRepos.containerName, name),
			),
		)
	if (!preview) return Response.json({ error: 'not found' }, { status: 404 })

	try {
		const { note } = await tearDownPreview(previewId)
		return Response.json({ ok: true, note })
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'teardown failed', 'servers/:id/containers/:name/previews/:previewId') },
			{ status: 500 },
		)
	}
}
