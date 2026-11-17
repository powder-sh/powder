// One-shot import of the existing on-disk env file into the DB. Run once per
// project when migrating to DB-mode. Idempotent: re-runs only insert keys that
// aren't already in the DB by default (set ?overwrite=1 to overwrite).
//
// Reads from the canonical compose-discovered env file via existing SSH
// helpers, so it reads the same file the env-file editor does.

import { requireProjectAccess } from '@/lib/access'
import { deniedNote } from '@/lib/env-key-policy'
import { bulkImportFromText, envWriteCtx } from '@/lib/env-vars-db'
import { getServer } from '@/lib/servers'
import { findEnvFile } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const { repo, user } = access

	const server = await getServer(repo.serverId)
	if (!server) return Response.json({ error: 'server not found' }, { status: 404 })

	const url = new URL(req.url)
	const overwrite = url.searchParams.get('overwrite') === '1'

	try {
		const { path, exists, contents } = await findEnvFile(server, repo.containerName)
		if (!exists) {
			return Response.json({
				ok: true,
				path,
				imported: 0,
				skipped: 0,
				existing: 0,
				note: 'no env file found on server — nothing to import',
			})
		}
		const result = await bulkImportFromText(id, contents, 'production', envWriteCtx(req, user), {
			overwrite,
		})
		return Response.json({ ok: true, path, ...result, ...deniedNote(result.deniedKeys) })
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'backfill failed', 'projects/:id/env/backfill') },
			{ status: 500 },
		)
	}
}
