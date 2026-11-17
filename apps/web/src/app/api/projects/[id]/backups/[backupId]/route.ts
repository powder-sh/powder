// POST {action} on one backup. Admin only; every call writes an
// app_backup_restores row (the audit trail /activity shows).
//   download → short-lived presigned GET URL + the exact decrypt/psql commands.
//              Admin browser session only (never a bearer token), like ?reveal=1.
//   restore  → restore into a NEW database <db>_restore_<yyyymmdd_hhmm>. 202 + row.
//   verify   → restore into a throwaway database, count tables, drop it. 202 + row.

import { requireProjectAccess } from '@/lib/access'
import { RestoreError, presignBackupDownload, startRestore } from '@/lib/backup-restore'
import { canReveal } from '@/lib/secret-mask'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
	req: Request,
	ctx: { params: Promise<{ id: string; backupId: string }> },
) {
	const { id, backupId } = await ctx.params
	// requireProjectAccess (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const { user, repo } = access
	if (!user.isAdmin) return Response.json({ error: 'admin only' }, { status: 403 })

	const body = (await req.json().catch(() => ({}))) as { action?: string }
	const action = body.action
	if (action !== 'download' && action !== 'restore' && action !== 'verify') {
		return Response.json({ error: 'action must be download, restore or verify' }, { status: 400 })
	}
	const by = user.email || user.id

	try {
		if (action === 'download') {
			if (!canReveal(user)) {
				return Response.json({ error: 'download needs an admin browser session' }, { status: 403 })
			}
			return Response.json(await presignBackupDownload(repo, backupId, by))
		}
		const row = await startRestore(repo, backupId, action, by)
		return Response.json({ restore: row }, { status: 202 })
	} catch (err) {
		if (err instanceof RestoreError) {
			return Response.json({ error: err.message }, { status: err.status })
		}
		console.error(`[backup ${action}]`, err)
		return Response.json(
			{ error: clientErrorMessage(err, `${action} failed`, 'projects/:id/backups/:backupId') },
			{ status: 500 },
		)
	}
}
