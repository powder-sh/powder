import { requireContainerAccess } from '@/lib/access'
import { containerReadError } from '@/lib/container-state'
import { revealDenied, revealKey, revealRequested, revealView } from '@/lib/secret-mask'
import { inspectContainer } from '@/lib/ssh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server, user } = access
	const denied = revealDenied(req, user)
	if (denied) return denied
	try {
		const detail = await inspectContainer(server, name)
		return Response.json({ ...detail, env: revealView(detail.env, revealRequested(req), revealKey(req)) })
	} catch (err) {
		return containerReadError(err)
	}
}
