// POST /api/projects/[id]/domains/[hostname]/apply
// Once a domain is 'verified', this writes Traefik labels to the app's
// compose file and recreates the container. On success the row goes to
// 'live'; on failure 'apply_failed' with appliedError. See lib/app-domains.ts.

import { requireProjectAccess } from '@/lib/access'
import { applyDomain } from '@/lib/app-domains'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
	_req: Request,
	ctx: { params: Promise<{ id: string; hostname: string }> },
) {
	const { id, hostname } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const { repo } = access

	const decoded = decodeURIComponent(hostname).toLowerCase()
	const result = await applyDomain(repo.id, decoded)
	return Response.json(result, { status: result.applied ? 200 : 400 })
}
