// Restore a previous value for an env var from the versions table. Takes
// {versionId} in the body, returns the new current EnvVarSummary. The
// rollback itself is audited as a 'rollback' action so the timeline shows
// the restore distinctly from a normal rotation.

import { requireProjectAccess } from '@/lib/access'
import { EnvKeyDeniedError } from '@/lib/env-key-policy'
import { envWriteCtx, rollbackToVersion } from '@/lib/env-vars-db'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
	const { id, key } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const { user } = access

	let body: { versionId?: string }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return Response.json({ error: 'invalid body' }, { status: 400 })
	}
	if (!body.versionId) {
		return Response.json({ error: 'versionId required' }, { status: 400 })
	}

	try {
		// the version must belong to the key in the URL (params arrive decoded).
		const restored = await rollbackToVersion(id, body.versionId, envWriteCtx(req, user), key)
		return Response.json({ ok: true, var: restored })
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'rollback failed', 'projects/:id/env/:key/rollback') },
			{ status: err instanceof EnvKeyDeniedError ? 403 : 400 },
		)
	}
}
