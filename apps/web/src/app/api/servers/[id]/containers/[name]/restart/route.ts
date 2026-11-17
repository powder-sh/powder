import { requireContainerAccess } from '@/lib/access'
import { finishDeploy, tryStartDeploy } from '@/lib/deploys'
import { redactSecrets } from '@/lib/secret-text'
import { restartContainer } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	// never powder's own containers (POWDER_SELF_CONTAINER).
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access

	const deployOrResp = await tryStartDeploy({
		serverId: id,
		containerName: name,
		kind: 'restart',
		inline: true, // this route runs the work itself — the worker must not claim it
	})
	if (deployOrResp instanceof Response) return deployOrResp
	const deploy = deployOrResp

	try {
		await restartContainer(server, name)
		await finishDeploy(deploy.id, { status: 'success' })
		return Response.json({ ok: true, deployId: deploy.id })
	} catch (err) {
		// never return raw guard / ssh output
		const message = redactSecrets(clientErrorMessage(err, 'unknown error', 'servers/:id/containers/:name/restart'))
		await finishDeploy(deploy.id, { status: 'failed', error: message })
		return Response.json({ error: message, deployId: deploy.id }, { status: 500 })
	}
}
