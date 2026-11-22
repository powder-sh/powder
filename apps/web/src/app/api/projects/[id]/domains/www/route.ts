// GET /api/projects/[id]/domains/www[?fresh=1]
// What www does for each live apex domain of the app (and what the apex does for a
// live www domain): lib/www-status.ts classifies, lib/www-probe.ts probes. Only
// hostnames derived from this app's own live, non-preview domain rows are probed;
// the client names none. On demand only (the domains tab loads it, or its recheck
// control), never on a schedule.

import { requireProjectAccess } from '@/lib/access'
import { listDomainsForRepo } from '@/lib/app-domains'
import { probeWww } from '@/lib/www-probe'
import { type WwwCheck, classifyWwwProbe, wwwSibling } from '@/lib/www-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A safety cap: an app with more live apex domains than this is checked for the first ones. */
const MAX_CHECKS = 12

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	// the one project access check (user, row, never powder's own container), like GET domains
	const access = await requireProjectAccess(id, { selfRead: true })
	if (access instanceof Response) return access
	const { repo } = access
	const fresh = new URL(req.url).searchParams.get('fresh') === '1'

	const rows = await listDomainsForRepo(repo.id)
	const pairs = rows
		.filter((d) => d.status === 'live' && d.previewDeployId === null)
		.map((d) => ({ hostname: d.hostname, sibling: wwwSibling(d.hostname) }))
		.filter((p): p is { hostname: string; sibling: string } => p.sibling !== null)
		.slice(0, MAX_CHECKS)

	const checks: WwwCheck[] = await Promise.all(
		pairs.map(async (p) => {
			const outcome = await probeWww(p.sibling, { fresh }).catch(() => ({ error: 'UNKNOWN' }))
			return {
				hostname: p.hostname,
				sibling: p.sibling,
				status: classifyWwwProbe(outcome, p.hostname, p.sibling),
			}
		}),
	)
	return Response.json({ checks })
}
