// GET — list backups for an app (newest first, last 60).
// POST — manually trigger a backup. Returns 202 immediately; check the row
//        the GET returns to see status. 409 while one runs for the app, 429
//        past the per-app limits: a short one for token callers, and a daily
//        cap for every caller but an admin browser session. Its success
//        prunes manual backups only (BACKUP_KEEP_MANUAL_PER_APP), never
//        scheduled ones.
//
// GET also returns this app's download/restore/verify/drop rows (restores),
// each restore db with the DATABASE_URL variant to switch to (password masked).
//
// Both gated to the owner (or admin). Returns 400 if the app has no postgres
// sibling, 503 if backup env isn't configured.

import { requireProjectAccess } from '@/lib/access'
import { listRestoresForApp, restoreUrlHint } from '@/lib/backup-restore'
import {
	BackupInFlightError,
	isBackupConfigured,
	listBackupsForApp,
	liveInFlightBackup,
	recentManualBackups,
	runBackupForApp,
} from '@/lib/backups'
import { checkRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Token-triggered backups per app: TOKEN_BACKUP_LIMIT per TOKEN_BACKUP_WINDOW_MS.
// The window stays within the limiter's 10 min bucket horizon
// (pruneRateLimitBuckets), or buckets would be dropped early.
const TOKEN_BACKUP_LIMIT = 2
const TOKEN_BACKUP_WINDOW_MS = 10 * 60_000
// Manual backups per app per 24h for every caller but an admin browser
// session (tokens and non-admin sessions). Counted from app_backups rows, so a
// restart does not reset it.
const MANUAL_BACKUP_DAILY_CAP = 12
const MANUAL_BACKUP_DAY_MS = 24 * 3600_000

// requireProjectAccess (user, row, never powder's own container)
async function loadOwnedRepo(id: string) {
	// list and run serve powder's own row to an admin session
	const a = await requireProjectAccess(id, { selfRead: true })
	if (a instanceof Response) return { resp: a }
	return { repo: a.repo, user: a.user }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const access = await loadOwnedRepo(id)
	if ('resp' in access) return access.resp
	const { repo } = access

	const backups = await listBackupsForApp(repo.serverId, repo.containerName)
	const restores = await Promise.all(
		(await listRestoresForApp(repo.serverId, repo.containerName)).map(async (r) => ({
			...r,
			databaseUrl:
				r.kind === 'restore' && r.status === 'success' && !r.droppedAt && r.targetDb
					? await restoreUrlHint(repo, r.targetDb)
					: null,
		})),
	)
	return Response.json({
		configured: isBackupConfigured(),
		hasPostgres: repo.hasPostgres,
		// Restore needs the db in a container (resolveRestoreDb).
		restorable: repo.hasPostgres && !repo.backupDbHost,
		// The database backups dump (set with PATCH /api/projects/[id]); the
		// password only as set or not.
		database: {
			container: repo.backupDbContainer,
			host: repo.backupDbHost,
			name: repo.backupDbName,
			user: repo.backupDbUser,
			passwordSet: !!repo.backupDbPasswordEncrypted,
			defaultContainer: `${repo.containerName}-db`,
			canEdit: access.user.isAdmin === true && access.user.viaToken !== true,
		},
		backups,
		restores,
	})
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const access = await loadOwnedRepo(id)
	if ('resp' in access) return access.resp
	const { repo } = access

	if (!repo.hasPostgres) {
		return Response.json({ error: 'app has no postgres sibling' }, { status: 400 })
	}
	if (!isBackupConfigured()) {
		return Response.json(
			{ error: 'backup not configured (BACKUP_S3_* + POWDER_BACKUP_KEY env vars required)' },
			{ status: 503 },
		)
	}
	// One at a time per app (runBackupForApp holds the same rule against races).
	const running = await liveInFlightBackup(repo.serverId, repo.containerName)
	if (running) {
		return Response.json(
			{ error: 'a backup of this app is already running', backupId: running.id },
			{ status: 409 },
		)
	}
	if (access.user.viaToken === true) {
		const rl = checkRateLimit(`backup:token:${repo.id}`, TOKEN_BACKUP_LIMIT, TOKEN_BACKUP_WINDOW_MS)
		if (!rl.ok) {
			return Response.json(
				{ error: 'rate limited' },
				{ status: 429, headers: { 'Retry-After': Math.ceil(rl.retryAfterMs / 1000).toString() } },
			)
		}
	}
	const adminSession = access.user.isAdmin === true && access.user.viaToken !== true
	if (!adminSession) {
		const recent = await recentManualBackups(repo.serverId, repo.containerName, MANUAL_BACKUP_DAY_MS)
		if (recent.count >= MANUAL_BACKUP_DAILY_CAP) {
			const retryMs = recent.oldestAt ? recent.oldestAt.getTime() + MANUAL_BACKUP_DAY_MS - Date.now() : MANUAL_BACKUP_DAY_MS
			return Response.json(
				{ error: `at most ${MANUAL_BACKUP_DAILY_CAP} manual backups per app per 24 hours` },
				{ status: 429, headers: { 'Retry-After': Math.max(1, Math.ceil(retryMs / 1000)).toString() } },
			)
		}
	}
	// Fire-and-forget. Caller polls GET to see the row appear + complete.
	// Its success prunes manual backups only (lib/backups.ts markBackupSuccess).
	;(async () => {
		try {
			await runBackupForApp(repo, { source: 'manual' })
		} catch (err) {
			if (err instanceof BackupInFlightError) console.warn('[backup manual] already running')
			else console.error('[backup manual]', err)
		}
	})()

	return Response.json({ ok: true, message: 'backup triggered' }, { status: 202 })
}
