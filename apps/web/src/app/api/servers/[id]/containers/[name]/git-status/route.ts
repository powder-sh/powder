import { requireContainerAccess } from '@/lib/access'
import { containerReadError } from '@/lib/container-state'
import { getGitStatus, inspectContainer } from '@/lib/ssh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access

	try {
		const detail = await inspectContainer(server, name)
		if (!detail.compose.workingDir) {
			return Response.json({ supported: false, reason: 'no compose working dir' })
		}
		const status = await getGitStatus(server, detail.compose.workingDir)
		return Response.json({ supported: true, workingDir: detail.compose.workingDir, ...status })
	} catch (err) {
		return containerReadError(err)
	}
}
