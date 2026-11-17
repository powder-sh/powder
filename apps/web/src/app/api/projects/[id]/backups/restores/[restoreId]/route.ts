// GET  → one restore/verify job: polls the server while it runs (log tail, status),
//        finalizes the row when the script reports. The dashboard polls this.
// POST {action:'drop'} → drop that job's restore database. Only names matching
//        <db>_restore_<yyyymmdd_hhmm>, never the live db or the db DATABASE_URL
//        uses; postgres itself refuses while anything is connected.
// Admin only.

import { requireProjectAccess } from '@/lib/access'
import { RestoreError, dropRestoreDb, pollRestore, restoreUrlHint } from '@/lib/backup-restore'
import { and, appBackupRestores, db, eq } from '@/lib/db'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function load(id: string, restoreId: string, selfRead = false) {
	// requireProjectAccess (user, row, never powder's own container); the
	// status read serves powder's own row to an admin session, the drop does not
	const a = await requireProjectAccess(id, { selfRead })
	if (a instanceof Response) return { resp: a }
	const { user, repo } = a
	if (!user.isAdmin) return { resp: Response.json({ error: 'admin only' }, { status: 403 }) }
	const [row] = await db
		.select()
		.from(appBackupRestores)
		.where(
			and(
				eq(appBackupRestores.id, restoreId),
				eq(appBackupRestores.serverId, repo.serverId),
				eq(appBackupRestores.containerName, repo.containerName),
			),
		)
		.limit(1)
	if (!row) return { resp: Response.json({ error: 'not found' }, { status: 404 }) }
	return { user, repo, row }
}

export async function GET(
	_req: Request,
	ctx: { params: Promise<{ id: string; restoreId: string }> },
) {
	const { id, restoreId } = await ctx.params
	const l = await load(id, restoreId, true)
	if ('resp' in l) return l.resp
	const { row, log, reachable } = await pollRestore(l.row)
	const databaseUrl =
		row.kind === 'restore' && row.status === 'success' && !row.droppedAt && row.targetDb
			? await restoreUrlHint(l.repo, row.targetDb)
			: null
	return Response.json({ restore: { ...row, databaseUrl }, log, reachable })
}

export async function POST(
	req: Request,
	ctx: { params: Promise<{ id: string; restoreId: string }> },
) {
	const { id, restoreId } = await ctx.params
	const l = await load(id, restoreId)
	if ('resp' in l) return l.resp
	const body = (await req.json().catch(() => ({}))) as { action?: string }
	if (body.action !== 'drop') {
		return Response.json({ error: 'action must be drop' }, { status: 400 })
	}
	if (l.row.kind !== 'restore' || !l.row.targetDb) {
		return Response.json({ error: 'only a restore database can be dropped' }, { status: 400 })
	}
	if (l.row.status === 'running') {
		return Response.json({ error: 'restore still running' }, { status: 409 })
	}
	try {
		const drop = await dropRestoreDb(l.repo, l.row.targetDb, l.user.email || l.user.id)
		return Response.json({ drop })
	} catch (err) {
		if (err instanceof RestoreError) {
			return Response.json({ error: err.message }, { status: err.status })
		}
		console.error('[restore drop]', err)
		return Response.json(
			{ error: clientErrorMessage(err, 'drop failed', 'projects/:id/backups/restores/:restoreId') },
			{ status: 500 },
		)
	}
}
