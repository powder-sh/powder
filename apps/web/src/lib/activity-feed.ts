// Pure half of the /activity feed: search-param parsing, which
// sources each filter reads, row -> event mapping and the newest-first merge.
// No DB here, so it is unit-tested (lib/__tests__/activity-feed.test.ts). The
// queries live in lib/activity-feed-db.ts.

import { deployKindLabel, triggeredByLabel } from './deploy-status'

export const ACTIVITY_FILTERS = [
	{ key: 'all', label: 'all' },
	{ key: 'deploys', label: 'deploys' },
	{ key: 'env', label: 'env' },
	{ key: 'backups', label: 'backups' },
	{ key: 'failures', label: 'failures' },
] as const
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]['key']

export const ACTIVITY_WINDOWS = [
	{ days: 1, label: '24h' },
	{ days: 7, label: '7d' },
	{ days: 30, label: '30d' },
	{ days: 90, label: '90d' },
] as const
export type ActivityWindowDays = (typeof ACTIVITY_WINDOWS)[number]['days']
export const DEFAULT_WINDOW_DAYS: ActivityWindowDays = 7

// Rows per page, and the hard LIMIT on every query leg (PAGE_SIZE + 1, so a
// leg that has more than a page tells us there is an older page).
export const PAGE_SIZE = 100
export const LEG_LIMIT = PAGE_SIZE + 1

export interface ActivityParams {
	filter: ActivityFilter
	days: ActivityWindowDays
	// Exclusive upper bound ("load older" cursor). Null = now.
	before: Date | null
}

type RawParams = Record<string, string | string[] | undefined>

function first(v: string | string[] | undefined): string | undefined {
	return Array.isArray(v) ? v[0] : v
}

export function parseActivityParams(sp: RawParams, now: Date = new Date()): ActivityParams {
	const rawFilter = first(sp.filter)
	const filter = ACTIVITY_FILTERS.some((f) => f.key === rawFilter)
		? (rawFilter as ActivityFilter)
		: 'all'
	const rawDays = Number(first(sp.days))
	const days = ACTIVITY_WINDOWS.some((w) => w.days === rawDays)
		? (rawDays as ActivityWindowDays)
		: DEFAULT_WINDOW_DAYS
	const rawBefore = first(sp.before)
	let before: Date | null = null
	if (rawBefore && /^\d{4}-\d{2}-\d{2}T/.test(rawBefore)) {
		const d = new Date(rawBefore)
		// A cursor in the future is the same as "now"; drop it.
		if (!Number.isNaN(d.getTime()) && d.getTime() < now.getTime()) before = d
	}
	return { filter, days, before }
}

export function windowStart(params: ActivityParams, now: Date = new Date()): Date {
	return new Date(now.getTime() - params.days * 86_400_000)
}

// Query string for a link that keeps the other params. Defaults are left out
// so the plain /activity URL stays canonical.
export function activityHref(params: ActivityParams, patch: Partial<ActivityParams> = {}): string {
	const next = { ...params, ...patch }
	const p = new URLSearchParams()
	if (next.filter !== 'all') p.set('filter', next.filter)
	if (next.days !== DEFAULT_WINDOW_DAYS) p.set('days', String(next.days))
	if (next.before) p.set('before', next.before.toISOString())
	const q = p.toString()
	return q ? `/activity?${q}` : '/activity'
}

// Which deploy rows a filter reads:
//   activity - every non-git deploy, plus failed git deploys (auto-rollbacks
//              land here too: a rolled-back git deploy is status failed with
//              "auto-rolled back to ..." in error_summary)
//   env      - env_change deploys only
//   failed   - every failed deploy, any kind
export type DeployLegMode = 'activity' | 'env' | 'failed'

export interface LegPlan {
	deploys: DeployLegMode | null
	envAudit: boolean
	// 'failed' = failed backups only; 'all' = failed + in-flight rows one by one
	// and successes collapsed to one row per app per UTC day.
	backups: 'failed' | 'all' | null
	restores: 'failed' | 'all' | null
}

export function legsFor(filter: ActivityFilter): LegPlan {
	switch (filter) {
		case 'deploys':
			return { deploys: 'activity', envAudit: false, backups: null, restores: null }
		case 'env':
			return { deploys: 'env', envAudit: true, backups: null, restores: null }
		case 'backups':
			return { deploys: null, envAudit: false, backups: 'all', restores: 'all' }
		case 'failures':
			return { deploys: 'failed', envAudit: false, backups: 'failed', restores: 'failed' }
		default:
			return { deploys: 'activity', envAudit: true, backups: 'failed', restores: 'all' }
	}
}

type ActivitySource = 'deploy' | 'env' | 'backup' | 'restore'

export interface ActivityEvent {
	id: string
	source: ActivitySource
	at: Date
	app: string
	what: string
	// Null where the source has no status (env audit rows are written only
	// after a successful write).
	status: string | null
	detail: string | null
	by: string | null
	href: string
	queuedAt: Date | null
}

// ── row -> event mappers ────────────────────────────────────────────────────

export interface DeployRowIn {
	id: string
	containerName: string
	kind: string
	status: string
	queuedAt: Date | null
	startedAt: Date
	triggeredBy: string | null
	gitSha: string | null
	errorSummary: string | null
}

export function deployEvent(r: DeployRowIn): ActivityEvent {
	const kind = deployKindLabel(r.kind)
	return {
		id: `deploy:${r.id}`,
		source: 'deploy',
		at: r.startedAt,
		app: r.containerName,
		what: r.kind === 'git_deploy' && r.gitSha ? `${kind} ${r.gitSha.slice(0, 7)}` : kind,
		status: r.status,
		detail: r.status === 'failed' ? r.errorSummary : null,
		by: triggeredByLabel(r.triggeredBy),
		href: `/deploys/${r.id}`,
		queuedAt: r.queuedAt,
	}
}

export interface EnvAuditRowIn {
	id: string
	createdAt: Date
	appRepoId: string
	appName: string | null
	action: string
	key: string
	scope: string
	actorKind: string
	actorUserId: string | null
	actorEmail: string | null
	actorIp: string | null
}

export function envActorLabel(
	r: Pick<EnvAuditRowIn, 'actorKind' | 'actorUserId' | 'actorEmail' | 'actorIp'>,
): string {
	if (r.actorKind === 'system') return 'system'
	const who = r.actorEmail ?? r.actorUserId ?? r.actorIp ?? 'unknown'
	return r.actorKind === 'api_token' ? `token (${who})` : who
}

// Key, scope and action only: values (and their previews) stay on the env tab.
export function envEvent(r: EnvAuditRowIn): ActivityEvent {
	return {
		id: `env:${r.id}`,
		source: 'env',
		at: r.createdAt,
		app: r.appName ?? r.appRepoId,
		what: `env ${r.action}`,
		status: null,
		detail: r.scope === 'production' ? r.key : `${r.key} (${r.scope})`,
		by: envActorLabel(r),
		href: `/projects/${r.appRepoId}/env`,
		queuedAt: null,
	}
}

function appHref(
	repoId: string | null,
	serverId: string,
	containerName: string,
	tab: string,
): string {
	return repoId ? `/projects/${repoId}/${tab}` : `/servers/${serverId}/${containerName}`
}

export interface BackupRowIn {
	id: string
	serverId: string
	containerName: string
	status: string
	startedAt: Date
	error: string | null
	repoId: string | null
}

export function backupEvent(r: BackupRowIn): ActivityEvent {
	return {
		id: `backup:${r.id}`,
		source: 'backup',
		at: r.startedAt,
		app: r.containerName,
		what: 'backup',
		status: r.status,
		detail: r.status === 'failed' ? firstLine(r.error) : null,
		by: null,
		href: appHref(r.repoId, r.serverId, r.containerName, 'backups'),
		queuedAt: null,
	}
}

// One row per app per UTC day of successful backups (the hourly tick would
// otherwise bury everything else).
export interface BackupGroupRowIn {
	serverId: string
	containerName: string
	// yyyy-mm-dd, UTC
	day: string
	count: number
	lastAt: Date
	repoId: string | null
}

export function backupGroupEvent(r: BackupGroupRowIn): ActivityEvent {
	const n = Number(r.count)
	return {
		id: `backups:${r.serverId}/${r.containerName}/${r.day}`,
		source: 'backup',
		at: r.lastAt,
		app: r.containerName,
		what: n === 1 ? '1 backup ok' : `${n} backups ok`,
		status: 'success',
		detail: `${r.day} (utc)`,
		by: null,
		href: appHref(r.repoId, r.serverId, r.containerName, 'backups'),
		queuedAt: null,
	}
}

const RESTORE_KIND_LABEL: Record<string, string> = {
	download: 'backup download',
	restore: 'backup restore',
	verify: 'backup verify',
	drop: 'drop restore db',
}

export interface RestoreRowIn {
	id: string
	serverId: string
	containerName: string
	kind: string
	status: string
	startedAt: Date
	requestedBy: string | null
	targetDb: string | null
	error: string | null
	repoId: string | null
}

export function restoreEvent(r: RestoreRowIn): ActivityEvent {
	return {
		id: `restore:${r.id}`,
		source: 'restore',
		at: r.startedAt,
		app: r.containerName,
		what: RESTORE_KIND_LABEL[r.kind] ?? r.kind,
		status: r.status,
		detail: r.status === 'failed' ? firstLine(r.error) : r.targetDb,
		by: r.requestedBy,
		href: appHref(r.repoId, r.serverId, r.containerName, 'backups'),
		queuedAt: null,
	}
}

function firstLine(s: string | null): string | null {
	if (!s) return null
	const line = s.trim().split('\n')[0]?.trim() ?? ''
	return line ? line.slice(0, 200) : null
}

// ── merge ───────────────────────────────────────────────────────────────────

export interface FeedPage {
	events: ActivityEvent[]
	// Cursor for "load older": the oldest shown event's time. Null when the
	// window holds nothing older.
	nextBefore: Date | null
}

// Newest first across every leg, ties broken by id so the order is stable.
// Each leg was fetched with LIMIT PAGE_SIZE + 1, so the true top PAGE_SIZE is
// always inside the union, and "more than a page in total" means an older
// page exists.
export function mergeFeed(legs: ActivityEvent[][], limit: number = PAGE_SIZE): FeedPage {
	const all = legs.flat()
	all.sort((a, b) => {
		const d = b.at.getTime() - a.at.getTime()
		if (d !== 0) return d
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
	})
	const events = all.slice(0, limit)
	const last = events[events.length - 1]
	const nextBefore = all.length > limit && last ? last.at : null
	return { events, nextBefore }
}
