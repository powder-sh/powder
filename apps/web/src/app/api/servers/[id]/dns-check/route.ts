import { requireServerForUser, requireUser } from '@/lib/access'
import { runDnsCheck } from '@/lib/server-dns-check'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Resolves <random>.<base_domain> and compares with the ingress target. POST
// because it records the result for the first-run checklist.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const server = await requireServerForUser(id)
	if (server instanceof Response) return server
	return Response.json({ dns: await runDnsCheck(server) })
}
