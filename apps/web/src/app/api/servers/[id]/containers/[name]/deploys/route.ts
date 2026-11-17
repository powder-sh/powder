import { requireContainerAccess } from '@/lib/access'
import { listDeploysFor } from '@/lib/deploys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	try {
		const rows = await listDeploysFor(id, name, 20)
		return Response.json({ deploys: rows })
	} catch (err) {
		// The detail (driver message, SQL, hosts) stays in the server log.
		console.warn('[deploys] db read failed:', err instanceof Error ? err.message : String(err))
		return Response.json({ deploys: [], dbError: 'db unreachable' })
	}
}
