// POST /api/projects/[id]/domains/[hostname]/verify
// Resolves the TXT challenge for the given hostname. On match, flips the
// app_domains row to 'verified' (next step: apply). On miss, flips to
// 'verify_failed' with a human-readable error. See lib/app-domains.ts.

import { requireProjectAccess } from '@/lib/access'
import { verifyDomain } from '@/lib/app-domains'

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
	const result = await verifyDomain(repo.id, decoded)
	return Response.json(result, { status: result.verified ? 200 : 400 })
}
