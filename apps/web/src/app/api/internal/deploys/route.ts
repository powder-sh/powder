// Terminal + stuck deploys for an external ops hub's reconciliation sweep (the
// receiver of POWDER_HQ_*, polling on its own schedule). Read-only, admin-
// Bearer authed (the hub holds a persistent admin user_api_token).
//
// Why this exists: the direct fire-and-forget emit (lib/hq.ts) can drop
// events (3s timeout, no retry), and four trigger paths never emit at all
// (manual apply / restart / rollback / first-deploy) - plus watchdog-reaped
// rows. This endpoint lets the hub backstop ALL of them from the source of
// truth, the deploys table, and also see stuck queued/running rows (a wedged
// 'queued' row holds the in-flight lock and blocks every future deploy).

import { redactNullable, redactSecrets, safeSlice } from '@/lib/secret-text'
import { hiddenSelfNames, requireUser } from '@/lib/access'
import { and, asc, db, deploys, inArray, notInArray, sql } from '@/lib/db'
import { heldSql } from '@/lib/deploy-settle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	if (!userOrResp.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })

	const url = new URL(req.url)
	const sinceHours = Math.min(48, Math.max(1, Number(url.searchParams.get('since_hours')) || 6))
	const stuckMinutes = Math.min(1440, Math.max(5, Number(url.searchParams.get('stuck_minutes')) || 30))
	// powder's own deploys only to an admin session (lib/access.ts visibleRepos), never to a token.
	const hidden = hiddenSelfNames(userOrResp, 'admin-session')
	const notSelf = hidden.length > 0 ? notInArray(deploys.containerName, hidden) : undefined

	const terminal = await db
		.select({
			id: deploys.id,
			server: deploys.serverId,
			app: deploys.containerName,
			status: deploys.status,
			kind: deploys.kind,
			queuedAt: deploys.queuedAt,
			startedAt: deploys.startedAt,
			finishedAt: deploys.finishedAt,
			sha: deploys.gitSha,
			branch: deploys.gitBranch,
			errorSummary: deploys.errorSummary,
			error: deploys.error,
		})
		.from(deploys)
		.where(
			and(
				inArray(deploys.status, ['success', 'failed']),
				sql`${deploys.finishedAt} > now() - (${sinceHours} * interval '1 hour')`,
				// A push cancelled while held on the settle window (a rollback or stop superseded
				// it, deploys.ts cancelHeldDeploys) never ran: not a failed deploy to reconcile.
				sql`NOT (${deploys.failedStep} = 'superseded' AND ${deploys.notBefore} IS NOT NULL)`,
				notSelf,
			),
		)
		.orderBy(asc(deploys.finishedAt))
		.limit(500)

	const stuckRows = await db
		.select({
			id: deploys.id,
			server: deploys.serverId,
			app: deploys.containerName,
			status: deploys.status,
			kind: deploys.kind,
			startedAt: deploys.startedAt,
		})
		.from(deploys)
		.where(
			and(
				inArray(deploys.status, ['queued', 'running']),
				sql`${deploys.startedAt} < now() - (${stuckMinutes} * interval '1 minute')`,
				// A queued row waiting behind its own app's running deploy (0035:
				// the durable catch-up) is not stuck - it runs when that one ends.
				// If the running one IS stuck, it's reported itself.
				sql`NOT (${deploys.status} = 'queued' AND EXISTS (SELECT 1 FROM deploys r WHERE r.server_id = ${deploys.serverId} AND r.container_name = ${deploys.containerName} AND r.status = 'running'))`,
				// A push held on its settle window (lib/deploy-settle.ts) is waiting by design.
				sql`NOT ${sql.raw(heldSql('"deploys"'))}`,
				notSelf,
			),
		)
		.orderBy(asc(deploys.startedAt))
		.limit(100)

	const now = Date.now()
	return Response.json({
		deploys: terminal.map((d) => ({
			id: d.id,
			server: d.server,
			app: d.app,
			status: d.status,
			kind: d.kind,
			queuedAt: d.queuedAt,
			startedAt: d.startedAt,
			finishedAt: d.finishedAt,
			durationMs:
				d.startedAt && d.finishedAt
					? new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()
					: null,
			sha: d.sha,
			branch: d.branch,
			// errorSummary is the structured one-liner; fall back to the raw error
			// (truncated) for rows that predate structured failures.
			errorSummary: redactNullable(d.errorSummary) ?? (d.error ? safeSlice(redactSecrets(d.error), 0, 300) : null),
		})),
		stuck: stuckRows.map((s) => ({
			id: s.id,
			server: s.server,
			app: s.app,
			status: s.status,
			kind: s.kind,
			startedAt: s.startedAt,
			ageMinutes: s.startedAt ? Math.round((now - new Date(s.startedAt).getTime()) / 60_000) : null,
		})),
	})
}
