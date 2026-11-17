// Recent audit entries for a project's env vars. Shows who set/rotated/
// deleted/rolled-back what, when, from where. Values never appear — only
// 4-char previews of before/after.

import { requireProjectAccess } from '@/lib/access'
import { listAuditForProject } from '@/lib/env-vars-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id, { selfRead: true })
	if (access instanceof Response) return access

	const url = new URL(req.url)
	const limit = Number(url.searchParams.get('limit') ?? '50')

	const entries = await listAuditForProject(id, Number.isFinite(limit) ? limit : 50)
	return Response.json({ entries })
}
