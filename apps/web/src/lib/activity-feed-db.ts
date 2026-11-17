import {
	type ActivityEvent,
	type ActivityParams,
	type DeployLegMode,
	type FeedPage,
	LEG_LIMIT,
	backupEvent,
	backupGroupEvent,
	deployEvent,
	envEvent,
	legsFor,
	mergeFeed,
	restoreEvent,
	windowStart,
} from '@/lib/activity-feed'
import {
	and,
	appBackupRestores,
	appBackups,
	appEnvVarAudit,
	appRepos,
	db,
	deploys,
	desc,
	eq,
	sql,
	user,
} from '@/lib/db'

// Queries for the /activity feed. One query per source, each bounded by the
// time window [since, before) and a hard LIMIT (LEG_LIMIT), merged in
// lib/activity-feed.ts. Single-tenant: the caller has passed requirePageUser
// (admin only), same as /deploys and the env pages, so no per-owner filter.
//
// Index notes: deploys has no started_at index (only the partial
// running/queued uniques), so the deploy legs are a seq scan + top-N sort.
// app_backups is indexed (server_id, container_name, started_at), which does
// not serve an all-servers time window: also a seq scan. app_env_var_audit is
// indexed (app_repo_id, created_at) / (actor_user_id, created_at), same story.
// All cheap at tens of thousands of rows; a started_at index on deploys and app_backups is the fix if they grow.

function deployWhere(mode: DeployLegMode) {
	if (mode === 'env') return sql`${deploys.kind} = 'env_change'`
	if (mode === 'failed') return sql`${deploys.status} = 'failed'`
	return sql`(${deploys.kind} <> 'git_deploy' or ${deploys.status} = 'failed')`
}

async function deployLeg(mode: DeployLegMode, since: Date, before: Date): Promise<ActivityEvent[]> {
	const rows = await db
		.select({
			id: deploys.id,
			containerName: deploys.containerName,
			kind: deploys.kind,
			status: deploys.status,
			queuedAt: deploys.queuedAt,
			startedAt: deploys.startedAt,
			triggeredBy: deploys.triggeredBy,
			gitSha: deploys.gitSha,
			errorSummary: deploys.errorSummary,
		})
		.from(deploys)
		.where(
			and(
				deployWhere(mode),
				sql`${deploys.startedAt} >= ${since.toISOString()}::timestamptz`,
				sql`${deploys.startedAt} < ${before.toISOString()}::timestamptz`,
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(LEG_LIMIT)
	return rows.map(deployEvent)
}

async function envLeg(since: Date, before: Date): Promise<ActivityEvent[]> {
	// Values and their previews are deliberately not selected.
	const rows = await db
		.select({
			id: appEnvVarAudit.id,
			createdAt: appEnvVarAudit.createdAt,
			appRepoId: appEnvVarAudit.appRepoId,
			appName: appRepos.containerName,
			action: appEnvVarAudit.action,
			key: appEnvVarAudit.key,
			scope: appEnvVarAudit.scope,
			actorKind: appEnvVarAudit.actorKind,
			actorUserId: appEnvVarAudit.actorUserId,
			actorEmail: user.email,
			actorIp: appEnvVarAudit.actorIp,
		})
		.from(appEnvVarAudit)
		.leftJoin(appRepos, eq(appRepos.id, appEnvVarAudit.appRepoId))
		.leftJoin(user, eq(user.id, appEnvVarAudit.actorUserId))
		.where(
			and(
				sql`${appEnvVarAudit.createdAt} >= ${since.toISOString()}::timestamptz`,
				sql`${appEnvVarAudit.createdAt} < ${before.toISOString()}::timestamptz`,
			),
		)
		.orderBy(desc(appEnvVarAudit.createdAt))
		.limit(LEG_LIMIT)
	return rows.map(envEvent)
}

const backupRepoJoin = and(
	eq(appRepos.serverId, appBackups.serverId),
	eq(appRepos.containerName, appBackups.containerName),
)

// Non-success backup rows one by one: failed only, or failed + in flight.
async function backupRowsLeg(
	mode: 'failed' | 'all',
	since: Date,
	before: Date,
): Promise<ActivityEvent[]> {
	const rows = await db
		.select({
			id: appBackups.id,
			serverId: appBackups.serverId,
			containerName: appBackups.containerName,
			status: appBackups.status,
			startedAt: appBackups.startedAt,
			error: appBackups.error,
			repoId: appRepos.id,
		})
		.from(appBackups)
		.leftJoin(appRepos, backupRepoJoin)
		.where(
			and(
				mode === 'failed'
					? sql`${appBackups.status} = 'failed'`
					: sql`${appBackups.status} <> 'success'`,
				sql`${appBackups.startedAt} >= ${since.toISOString()}::timestamptz`,
				sql`${appBackups.startedAt} < ${before.toISOString()}::timestamptz`,
			),
		)
		.orderBy(desc(appBackups.startedAt))
		.limit(LEG_LIMIT)
	return rows.map(backupEvent)
}

// Successful backups collapsed to one row per app per UTC day. The cursor is
// applied to the group's newest backup (HAVING), so a group is never split
// across pages.
async function backupGroupLeg(since: Date, before: Date): Promise<ActivityEvent[]> {
	const day = sql<string>`to_char(${appBackups.startedAt} at time zone 'UTC', 'YYYY-MM-DD')`
	const lastAt = sql<Date>`max(${appBackups.startedAt})`
	const rows = await db
		.select({
			serverId: appBackups.serverId,
			containerName: appBackups.containerName,
			day,
			count: sql<number>`count(*)::int`,
			lastAt: lastAt.mapWith((v: string | Date) => new Date(v)),
			repoId: sql<string | null>`max(${appRepos.id})`,
		})
		.from(appBackups)
		.leftJoin(appRepos, backupRepoJoin)
		.where(
			and(
				sql`${appBackups.status} = 'success'`,
				sql`${appBackups.startedAt} >= ${since.toISOString()}::timestamptz`,
			),
		)
		.groupBy(appBackups.serverId, appBackups.containerName, day)
		.having(sql`max(${appBackups.startedAt}) < ${before.toISOString()}::timestamptz`)
		.orderBy(desc(lastAt))
		.limit(LEG_LIMIT)
	return rows.map(backupGroupEvent)
}

async function restoreLeg(
	mode: 'failed' | 'all',
	since: Date,
	before: Date,
): Promise<ActivityEvent[]> {
	const rows = await db
		.select({
			id: appBackupRestores.id,
			serverId: appBackupRestores.serverId,
			containerName: appBackupRestores.containerName,
			kind: appBackupRestores.kind,
			status: appBackupRestores.status,
			startedAt: appBackupRestores.startedAt,
			requestedBy: appBackupRestores.requestedBy,
			targetDb: appBackupRestores.targetDb,
			error: appBackupRestores.error,
			repoId: appRepos.id,
		})
		.from(appBackupRestores)
		.leftJoin(
			appRepos,
			and(
				eq(appRepos.serverId, appBackupRestores.serverId),
				eq(appRepos.containerName, appBackupRestores.containerName),
			),
		)
		.where(
			and(
				mode === 'failed' ? sql`${appBackupRestores.status} = 'failed'` : undefined,
				sql`${appBackupRestores.startedAt} >= ${since.toISOString()}::timestamptz`,
				sql`${appBackupRestores.startedAt} < ${before.toISOString()}::timestamptz`,
			),
		)
		.orderBy(desc(appBackupRestores.startedAt))
		.limit(LEG_LIMIT)
	return rows.map(restoreEvent)
}

export async function loadActivityPage(
	params: ActivityParams,
	now: Date = new Date(),
): Promise<FeedPage> {
	const plan = legsFor(params.filter)
	const since = windowStart(params, now)
	const before = params.before ?? now
	const legs: Promise<ActivityEvent[]>[] = []
	if (plan.deploys) legs.push(deployLeg(plan.deploys, since, before))
	if (plan.envAudit) legs.push(envLeg(since, before))
	if (plan.backups) legs.push(backupRowsLeg(plan.backups, since, before))
	if (plan.backups === 'all') legs.push(backupGroupLeg(since, before))
	if (plan.restores) legs.push(restoreLeg(plan.restores, since, before))
	return mergeFeed(await Promise.all(legs))
}
