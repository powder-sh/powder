// The one vocabulary for "how is this app doing": the apps list, its counter
// strip and filters, the app header and the command palette all derive it here
// from the same facts (last deploy, uptime check, server reachability,
// container presence).
//
// Six states, each with one word and one tone: live, deploying, failed, down,
// stopped, unknown. A reason ("queued", "server unreachable") follows the word
// after a middle dot and never replaces it.

import type { StatusTone } from '@/components/ui/status'

export type AppState = 'live' | 'deploying' | 'failed' | 'down' | 'stopped' | 'unknown'

export interface AppStateMeta {
	label: string
	tone: StatusTone
	pulse?: boolean
}

export const APP_STATE: Record<AppState, AppStateMeta> = {
	live: { label: 'live', tone: 'success' },
	deploying: { label: 'deploying', tone: 'warning', pulse: true },
	failed: { label: 'failed', tone: 'destructive' },
	down: { label: 'down', tone: 'destructive' },
	stopped: { label: 'stopped', tone: 'neutral' },
	unknown: { label: 'unknown', tone: 'neutral' },
}

// Display order for counters and filters.
export const APP_STATES: readonly AppState[] = ['live', 'deploying', 'failed', 'down', 'stopped', 'unknown']

export function isAppState(v: string | null | undefined): v is AppState {
	return !!v && (APP_STATES as readonly string[]).includes(v)
}

// States that put an app at the top of the list.
export function needsAttention(s: AppState): boolean {
	return s === 'failed' || s === 'down'
}

export type AppHealth =
	| 'live'
	| 'deploying'
	| 'queued'
	| 'down'
	| 'stopped'
	| 'deploy_failed'
	| 'not_deployed'
	| 'unreachable'
	| 'docker_error'

export interface AppHealthMeta extends AppStateMeta {
	/** The state word plus the reason, e.g. "unknown · server unreachable". */
	label: string
	state: AppState
}

function meta(state: AppState, reason?: string): AppHealthMeta {
	const s = APP_STATE[state]
	return { ...s, state, label: reason ? `${s.label} · ${reason}` : s.label }
}

export const APP_HEALTH: Record<AppHealth, AppHealthMeta> = {
	live: meta('live'),
	deploying: meta('deploying'),
	queued: meta('deploying', 'queued'),
	down: meta('down'),
	stopped: meta('stopped'),
	deploy_failed: meta('failed'),
	not_deployed: meta('unknown', 'never deployed'),
	unreachable: meta('unknown', 'server unreachable'),
	docker_error: meta('unknown', 'docker not answering'),
}

// Uptime older than this is ignored: a stale "down" must not keep an app red.
export const UPTIME_FRESH_MS = 30 * 60_000

/** Deploy kinds that change whether the app runs without deploying it. */
const LIFECYCLE_KINDS = new Set(['stop', 'delete'])

/** True for a stop or delete row: not a deploy of the app. */
export function isLifecycleKind(kind: string | null | undefined): boolean {
	return LIFECYCLE_KINDS.has(kind ?? '')
}

export interface HealthFacts {
	/** The app's newest deploys row. `kind` tells a stop or delete from a deploy. */
	lastDeploy: { status: string; kind?: string | null } | null | undefined
	uptime: { isUp: boolean; lastCheckedAt: string | null } | null | undefined
	/** false when powder could not reach the app's server (SSH failed). */
	serverReachable?: boolean
	/** true when the server answered and the container is not there. */
	containerMissing?: boolean
	/** true when SSH worked but docker failed, so the container state is unknown. */
	dockerFailed?: boolean
	/** docker's state of the app container (running, exited, ...) when it was read;
	 *  undefined when unknown (the apps list does not read containers). */
	containerStatus?: string
}

/** True for the newest row of a stop that went through: the container was stopped
 *  on purpose and stays stopped until a start, push or redeploy. */
function isStoppedByPowder(d: HealthFacts['lastDeploy']): boolean {
	return !!d && d.kind === 'stop' && d.status === 'success'
}

// Precedence: a deploy in flight > server unreachable (whatever the last uptime
// check said, so every app on that server reads the same) > stopped > fresh
// downtime > last deploy failed > docker not answering > container gone or not
// running after a good deploy > last deploy ok or site up > never deployed.
//
// Stopped: when the container state is known, a container that is not running
// and whose newest row is a successful stop; a running container is never
// stopped, and one that exited without a stop is down (it crashed). When the
// container state is unknown (the apps list, docker not answering), the newest
// row alone: a successful stop.
// A stop or delete that FAILED is not a failed deploy: nothing was deployed and
// the app was left as it was, so the row counts as the app still being deployed.
export function appHealth(f: HealthFacts, now = Date.now()): AppHealth {
	const raw = f.lastDeploy
	const d =
		raw && raw.status === 'failed' && isLifecycleKind(raw.kind) ? { status: 'success', kind: null } : raw
	if (d?.status === 'running') return 'deploying'
	if (d?.status === 'queued') return 'queued'
	if (f.serverReachable === false) return 'unreachable'
	const status = f.containerStatus
	const running = status !== undefined && /^(running|restarting)/.test(status)
	const containerKnown = status !== undefined || !!f.containerMissing
	if (isStoppedByPowder(d) && (containerKnown ? status !== undefined && !running : true)) return 'stopped'
	const u = f.uptime
	const fresh =
		!!u && now - (u.lastCheckedAt ? new Date(u.lastCheckedAt).getTime() : 0) < UPTIME_FRESH_MS
	if (fresh && u && !u.isUp) return 'down'
	if (d?.status === 'failed') return 'deploy_failed'
	if (f.dockerFailed) return fresh && u?.isUp ? 'live' : 'docker_error'
	if (f.containerMissing && d?.status === 'success') return 'down'
	if (status !== undefined && !running && d?.status === 'success') return 'down'
	if (d?.status === 'success' || u?.isUp) return 'live'
	return 'not_deployed'
}
