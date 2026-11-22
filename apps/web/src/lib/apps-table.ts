// Pure logic for the Apps table (/projects): status derivation, counters,
// filtering and sorting. No DB, no React, so it is unit-tested directly.

import {
	APP_HEALTH,
	APP_STATES,
	type AppHealth,
	type AppState,
	UPTIME_FRESH_MS,
	appHealth,
	isAppState,
	isLifecycleKind,
	needsAttention,
} from './app-health'
import type { DeployDay } from './deploy-days'

export interface AppLastDeploy {
	id: string
	status: 'success' | 'failed' | 'running' | 'queued'
	kind: string
	startedAt: string
	finishedAt: string | null
	gitSha: string | null
	gitBranch: string | null
}

interface AppUptime {
	isUp: boolean
	lastCheckedAt: string | null
	lastStatusCode: number | null
}

export interface AppRow {
	id: string
	serverId: string
	serverName: string
	containerName: string
	repoUrl: string
	branch: string
	createdAt: string
	domain: string | null
	envCount: number
	lastDeploy: AppLastDeploy | null
	uptime: AppUptime | null
	/** false when the app's server is marked unreachable (SSH failed on its last sync). */
	serverReachable?: boolean
	/** Deploys per UTC day, last 30 days (lib/deploy-days.ts). */
	deployDays?: DeployDay[]
}

export type AppStatus = AppState
export type StatusFilter = 'all' | AppState

// The detailed state and its word both live in lib/app-health.ts. The list does
// not read containers: a stopped app is told by its newest row (kind stop).
export function appRowHealth(
	app: Pick<AppRow, 'lastDeploy' | 'uptime' | 'serverReachable'>,
	now = Date.now(),
): AppHealth {
	return appHealth(
		{ lastDeploy: app.lastDeploy, uptime: app.uptime, serverReachable: app.serverReachable },
		now,
	)
}

export function deriveStatus(
	app: Pick<AppRow, 'lastDeploy' | 'uptime' | 'serverReachable'>,
	now = Date.now(),
): AppStatus {
	return APP_HEALTH[appRowHealth(app, now)].state
}

export type Counters = Record<AppState, number>

export function countStatuses(apps: readonly AppRow[], now = Date.now()): Counters {
	const c = Object.fromEntries(APP_STATES.map((s) => [s, 0])) as Counters
	for (const a of apps) c[deriveStatus(a, now)]++
	return c
}

export interface AppFilters {
	status: StatusFilter
	server: string
	q: string
}

export function parseStatusFilter(v: string | null | undefined): StatusFilter {
	return isAppState(v) ? v : 'all'
}

export function filterApps(apps: readonly AppRow[], f: AppFilters, now = Date.now()): AppRow[] {
	const q = f.q.trim().toLowerCase()
	return apps.filter((a) => {
		if (f.server && a.serverId !== f.server) return false
		if (f.status !== 'all') {
			if (deriveStatus(a, now) !== f.status) return false
		}
		if (q) {
			const hay = `${a.containerName} ${a.domain ?? ''} ${a.serverName} ${a.repoUrl}`.toLowerCase()
			if (!hay.includes(q)) return false
		}
		return true
	})
}

// Failed or down first, then most recently deployed (never-deployed last, by creation),
// then name for a stable order.
export function sortApps(apps: readonly AppRow[], now = Date.now()): AppRow[] {
	const rank = (a: AppRow) => (needsAttention(deriveStatus(a, now)) ? 0 : 1)
	const when = (a: AppRow) => new Date(a.lastDeploy?.startedAt ?? 0).getTime()
	return [...apps].sort((a, b) => {
		const r = rank(a) - rank(b)
		if (r !== 0) return r
		const w = when(b) - when(a)
		if (w !== 0) return w
		const c = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		if (c !== 0) return c
		return a.containerName.localeCompare(b.containerName)
	})
}

export function shortSha(sha: string | null | undefined): string | null {
	return sha ? sha.slice(0, 7) : null
}

export function deployDuration(
	d: Pick<AppLastDeploy, 'startedAt' | 'finishedAt'> | null,
): string | null {
	if (!d?.finishedAt) return null
	const ms = new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()
	if (!Number.isFinite(ms) || ms < 0) return null
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	return `${Math.floor(s / 60)}m ${s % 60}s`
}

export interface Heartbeat {
	up: number
	down: number
	unchecked: number
	last: { app: string; status: AppLastDeploy['status']; startedAt: string } | null
}

// Fleet heartbeat for the top of /projects. up/down come from the uptime
// checker (fresh checks only); apps without a fresh check count as unchecked.
export function fleetHeartbeat(apps: readonly AppRow[], now = Date.now()): Heartbeat {
	const h: Heartbeat = { up: 0, down: 0, unchecked: 0, last: null }
	for (const a of apps) {
		const u = a.uptime
		const checked = u?.lastCheckedAt ? new Date(u.lastCheckedAt).getTime() : 0
		if (!u || now - checked >= UPTIME_FRESH_MS) h.unchecked++
		else if (u.isUp) h.up++
		else h.down++
		// a stop or delete is not a deploy: "last deploy … failed" must not name it
		const d = a.lastDeploy && !isLifecycleKind(a.lastDeploy.kind) ? a.lastDeploy : null
		if (d && (!h.last || d.startedAt > h.last.startedAt))
			h.last = { app: a.containerName, status: d.status, startedAt: d.startedAt }
	}
	return h
}

// The redeploy button's explanation (apps list and app page). An app the shared
// health reads as never deployed has no running version to keep serving.
export function redeployHint(branch: string | null | undefined, neverDeployed: boolean): string {
	const b = branch || 'its branch'
	return neverDeployed
		? `pull the latest commit of ${b}, build and start it.`
		: `pull the latest commit of ${b}, rebuild and swap. if the build or a check before the swap fails, the running version keeps serving.`
}
