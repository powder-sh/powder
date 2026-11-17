// Version history for a single env var. Returns the last N previous values
// (5 by default) — previews only, never plaintext. Restoring a version
// requires the separate rollback endpoint.

import { requireProjectAccess } from '@/lib/access'
import { type EnvScope, listVersions } from '@/lib/env-vars-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_SCOPES: ReadonlySet<EnvScope> = new Set(['production', 'preview', 'development'])

export async function GET(req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
	const { id, key } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access

	const url = new URL(req.url)
	const scopeRaw = url.searchParams.get('scope') ?? 'production'
	const scope: EnvScope = ALLOWED_SCOPES.has(scopeRaw as EnvScope)
		? (scopeRaw as EnvScope)
		: 'production'

	// route params arrive decoded; decoding again changed keys holding `%`.
	const versions = await listVersions(id, key, scope)
	return Response.json({ versions })
}
