// Backup health for an external ops hub's backup sweep (the receiver of
// POWDER_HQ_*, polling on its own schedule) and its daily digest. Read-only,
// admin-Bearer authed — same cross-plane channel as /api/internal/deploys.
//
// Why this exists: backup execution, staleness detection AND failure alerting
// all run inside the same powder-worker tick (lib/backups.ts backupTick). If
// that tick dies — worker wedged, timer never fires, early throw — backups stop
// AND the thing that would report them stale stops with it. This endpoint lets
// the hub watch backup truth from outside that failure domain, and gives the
// digest positive coverage/age/size visibility instead of failure-only alerts.

import { requireUser } from '@/lib/access'
import { db, sql } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AppKeyRow {
	server_id: string
	container_name: string
}

export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	if (!userOrResp.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })

	const enrolled = (await db.execute(sql`
		SELECT server_id, container_name
		FROM app_repos
		WHERE has_postgres = true
	`)) as unknown as AppKeyRow[]

	// Latest success + latest attempt per app, one DISTINCT ON pass each,
	// joined in JS. Includes rows for since-unenrolled apps; filtered by the
	// enrolled list below.
	const lastSuccess = (await db.execute(sql`
		SELECT DISTINCT ON (server_id, container_name)
			server_id, container_name, finished_at, size_bytes::float8 AS size_bytes
		FROM app_backups
		WHERE status = 'success'
		ORDER BY server_id, container_name, started_at DESC
	`)) as unknown as Array<AppKeyRow & { finished_at: string | Date; size_bytes: number | null }>

	const lastAttempt = (await db.execute(sql`
		SELECT DISTINCT ON (server_id, container_name)
			server_id, container_name, status, started_at, error
		FROM app_backups
		ORDER BY server_id, container_name, started_at DESC
	`)) as unknown as Array<
		AppKeyRow & { status: string; started_at: string | Date; error: string | null }
	>

	// Sum of what the bucket actually holds: successful uploads minus rows the
	// keep-N retention sweep has pruned (pruned_at set = S3 object deleted).
	const [stored] = (await db.execute(sql`
		SELECT count(*)::int AS objects, coalesce(sum(size_bytes), 0)::float8 AS bytes
		FROM app_backups WHERE status = 'success' AND pruned_at IS NULL
	`)) as unknown as Array<{ objects: number; bytes: number }>

	const key = (r: AppKeyRow) => `${r.server_id}|${r.container_name}`
	const successByKey = new Map(lastSuccess.map((r) => [key(r), r]))
	const attemptByKey = new Map(lastAttempt.map((r) => [key(r), r]))

	const now = Date.now()
	const apps = enrolled.map((r) => {
		const ok = successByKey.get(key(r))
		const att = attemptByKey.get(key(r))
		const okAt = ok ? new Date(ok.finished_at).getTime() : null
		return {
			server: r.server_id,
			app: r.container_name,
			lastSuccessAt: ok ? new Date(ok.finished_at).toISOString() : null,
			ageHours: okAt ? Math.round(((now - okAt) / 3.6e6) * 10) / 10 : null,
			sizeBytes: ok?.size_bytes ?? null,
			lastAttemptStatus: att?.status ?? null,
			lastAttemptAt: att ? new Date(att.started_at).toISOString() : null,
			lastAttemptError: att?.error ? att.error.slice(0, 300) : null,
		}
	})

	return Response.json({
		apps,
		storedObjects: stored?.objects ?? 0,
		storedBytes: stored?.bytes ?? 0,
	})
}
