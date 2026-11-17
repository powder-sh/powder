import { requireContainerAccess } from '@/lib/access'
import { stopContainer } from '@/lib/app-lifecycle'
import { cancelHeldDeploys, finishDeploy, tryStartDeploy } from '@/lib/deploys'
import { redactSecrets } from '@/lib/secret-text'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Stop the app container (lib/app-lifecycle.ts stopCommand). Same access as restart:
// requireContainerAccess (a managed container, never powder's own), a deploys row of
// kind 'stop' that holds the per-app in-flight lock and lands in the activity feed.
// Start again with POST .../apply (compose guard, then `compose up`) or a redeploy.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server, user } = access

	const deployOrResp = await tryStartDeploy({
		serverId: id,
		containerName: name,
		kind: 'stop',
		triggeredBy: `manual:${user.email ?? user.id}`,
		inline: true, // this route runs the work itself; the worker must not claim it
	})
	if (deployOrResp instanceof Response) return deployOrResp
	const deploy = deployOrResp

	// A stop is never blocked by a push held on the settle window (lib/deploy-settle.ts),
	// and that push must not start the app again afterwards: cancel it, like a rollback.
	const cancelled = await cancelHeldDeploys(id, name, { id: deploy.id, kind: 'stop' }).catch((err) => {
		console.error(`[stop] ${name}: could not cancel held deploys:`, err)
		return [] as string[]
	})
	const cancelNote = cancelled.length
		? `[settle] cancelled the held push deploy ${cancelled.join(', ')} so it does not start the app again after this stop; push again or redeploy to ship it\n`
		: ''

	try {
		const output = cancelNote + (await stopContainer(server, name))
		await finishDeploy(deploy.id, { status: 'success', output })
		return Response.json({ ok: true, deployId: deploy.id, output, ...(cancelled.length ? { cancelledHeldDeploys: cancelled } : {}) })
	} catch (err) {
		const message = redactSecrets(clientErrorMessage(err, 'unknown error', 'servers/:id/containers/:name/stop'))
		await finishDeploy(deploy.id, { status: 'failed', error: message, errorSummary: message, ...(cancelNote ? { output: cancelNote } : {}) })
		return Response.json({ error: message, deployId: deploy.id }, { status: 500 })
	}
}
