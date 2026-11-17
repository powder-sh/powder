// POST — retention sweep over S3 backups (admin-Bearer, same cross-plane
// channel as the other /api/internal routes). Body:
//
//   { "dryRun": true }                                  → preview only
//   { "apps": [{ "server": "…", "app": "…", "keep": 3 }] } → explicit scope
//
// Scheduled and manual backups are separate pools, pruned separately: keep is
// the scheduled keep (default BACKUP_KEEP_PER_APP), manual backups always keep
// BACKUP_KEEP_MANUAL_PER_APP. results has one entry per app and pool.
//   { "force": true, … }                                → skip the size guard
//
// The size guard (planRetention) holds older backups when newer ones are
// <50% of the largest — pass force only after confirming the DB legitimately
// shrank, otherwise it deletes the real backups behind tiny "successful" ones.
//
// Default scope = every enrolled (has_postgres) app at the standard keep.
// Explicit `apps` exists for pruning UN-enrolled history (e.g.
// an app whose S3 backups were disabled while its old objects stayed
// behind, billing forever), with a per-app keep floor.
//
// The steady-state path is prune-on-success in pollPendingBackups; this route
// is for the one-time retro sweep + future manual cleanups.

import { requireUser } from '@/lib/access'
import { pruneBackupPools, type PruneResult } from '@/lib/backups'
import { appRepos, db, eq } from '@/lib/db'
import { sessionOnlyActionDenied } from '@/lib/session-only'

/** a keep is a whole number >= 1, or absent (the default). */
function badKeep(v: unknown): boolean {
	return v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 1)
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PruneRequest {
	dryRun?: boolean
	keep?: number
	force?: boolean
	apps?: { server: string; app: string; keep?: number }[]
}

export async function POST(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	if (!userOrResp.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })

	let body: PruneRequest = {}
	try {
		body = (await req.json()) as PruneRequest
	} catch {
		/* empty body = defaults */
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {}
	const dryRun = body.dryRun !== false // default TRUE — deleting backups must be opted into
	// NaN / strings / fractions / < 1 would disable the keep floor and the size
	// guard (a NaN keep prunes every backup). Refused before anything is read.
	if (badKeep(body.keep)) return Response.json({ error: 'keep must be a whole number >= 1' }, { status: 400 })
	if (body.apps !== undefined) {
		if (!Array.isArray(body.apps)) return Response.json({ error: 'apps must be a list' }, { status: 400 })
		for (const a of body.apps)
			if (!a || typeof a !== 'object' || typeof a.server !== 'string' || typeof a.app !== 'string' || badKeep(a.keep))
				return Response.json({ error: 'each app needs server and app (strings) and an optional keep (whole number >= 1)' }, { status: 400 })
	}
	// the delete is session-only unless the operator allows token prunes.
	if (!dryRun && process.env.POWDER_TOKEN_BACKUP_PRUNE !== '1') {
		const denied = sessionOnlyActionDenied('backup_prune', userOrResp)
		if (denied) return denied
	}
	const defaultKeep = body.keep

	let scope: { server: string; app: string; keep?: number }[]
	if (body.apps && body.apps.length > 0) {
		scope = body.apps
	} else {
		const repos = await db
			.select({ serverId: appRepos.serverId, containerName: appRepos.containerName })
			.from(appRepos)
			.where(eq(appRepos.hasPostgres, true))
		scope = repos.map((r) => ({ server: r.serverId, app: r.containerName }))
	}

	// Each pool on its own (pruneBackupPools): keep applies to scheduled
	// backups, manual ones keep BACKUP_KEEP_MANUAL_PER_APP. One result per pool.
	const results: PruneResult[] = []
	for (const s of scope) {
		results.push(...(await pruneBackupPools(s.server, s.app, { scheduledKeep: s.keep ?? defaultKeep, dryRun, force: body.force === true })))
	}

	const totals = results.reduce(
		(acc, r) => ({
			pruned: acc.pruned + r.pruned,
			freedBytes: acc.freedBytes + r.freedBytes,
			errors: acc.errors + r.errors,
		}),
		{ pruned: 0, freedBytes: 0, errors: 0 },
	)

	return Response.json({
		dryRun,
		totals,
		// A dry run lists every app's two pools (what each would keep and prune).
		results: dryRun ? results : results.filter((r) => r.pruned > 0 || r.errors > 0 || r.held > 0),
	})
}
