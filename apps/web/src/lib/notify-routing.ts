// Pure routing rules for lib/notifications.ts: event names, which targets get
// an event, the implicit env webhook target and the in-memory dedupe. No DB,
// network or env reads here except envWebhookTarget, so it stays unit-testable.

export const NOTIFY_EVENTS = [
	'deploy_failed',
	'deploy_succeeded',
	'app_down',
	'app_up',
	'backup_stale',
	'backup_failed',
	'cron_failed',
] as const

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

/** What the dashboard shows for each event; the stored names stay as they are. */
const NOTIFY_EVENT_LABELS: Record<NotifyEvent, string> = {
	deploy_failed: 'deploy failed',
	deploy_succeeded: 'deploy ready',
	app_down: 'app down',
	app_up: 'app back up',
	backup_stale: 'backup overdue',
	backup_failed: 'backup failed',
	cron_failed: 'cron failed',
}

export function notifyEventLabel(ev: string): string {
	return NOTIFY_EVENT_LABELS[ev as NotifyEvent] ?? ev.replace(/[._]/g, ' ')
}

export function isNotifyEvent(v: unknown): v is NotifyEvent {
	return typeof v === 'string' && (NOTIFY_EVENTS as readonly string[]).includes(v)
}

/** Events the env webhook (POWDER_NOTIFY_WEBHOOK_URL) receives. It received
 *  deploy_failed, app_down and the app_up recovery notice before targets
 *  existed; keep those so nothing changes for existing installs. cron_failed is
 *  new with managed crons and only fires for jobs powder runs itself. */
export const ENV_WEBHOOK_EVENTS: readonly NotifyEvent[] = ['deploy_failed', 'app_down', 'app_up', 'cron_failed']

/** The minimal shape routing needs from a notification_targets row. */
export interface RoutableTarget {
	id: string
	kind: string
	events: string[]
	appRepoId: string | null
	enabled: boolean
}

/** A target gets an event when it is enabled, subscribes to the event, and its
 *  app filter is empty (all apps) or names this app. An event with no known
 *  app id only reaches all-app targets. */
export function targetWants(
	t: RoutableTarget,
	event: NotifyEvent,
	appRepoId: string | null,
): boolean {
	if (!t.enabled) return false
	if (!t.events.includes(event)) return false
	if (t.appRepoId === null) return true
	return appRepoId !== null && t.appRepoId === appRepoId
}

export function routeTargets<T extends RoutableTarget>(
	targets: T[],
	event: NotifyEvent,
	appRepoId: string | null,
): T[] {
	return targets.filter((t) => targetWants(t, event, appRepoId))
}

/** The implicit always-on target from POWDER_NOTIFY_WEBHOOK_URL, or null. */
export function envWebhookTarget(env: Record<string, string | undefined> = process.env): {
	url: string
	events: readonly NotifyEvent[]
} | null {
	const url = env.POWDER_NOTIFY_WEBHOOK_URL?.trim()
	return url ? { url, events: ENV_WEBHOOK_EVENTS } : null
}

export const DEFAULT_DEDUPE_MS = 5 * 60 * 1000

/** Per-event dedupe windows. Most events are one-off transitions (5 minutes);
 *  backup_stale is re-checked every hour and a cron can fail every minute, so
 *  those hold longer. A caller's explicit dedupeMs wins. */
const EVENT_DEDUPE_MS: Partial<Record<NotifyEvent, number>> = {
	backup_stale: 23 * 60 * 60 * 1000,
	cron_failed: 30 * 60 * 1000,
}

export function dedupeWindowMs(event: NotifyEvent, override?: number): number {
	return override ?? EVENT_DEDUPE_MS[event] ?? DEFAULT_DEDUPE_MS
}

/** Drops a repeat of the same (event, server, app) inside the window. In memory,
 *  per process: a restart forgets it, which at worst sends one extra alert. */
export class NotifyDedupe {
	private seen = new Map<string, number>()

	constructor(private now: () => number = Date.now) {}

	/** `instance` separates distinct occurrences that must never collapse, e.g.
	 *  the deploy id: fail, succeed, fail again inside the window is three sends. */
	static key(event: string, server: string, app: string, instance?: string): string {
		return instance ? `${event}|${server}|${app}|${instance}` : `${event}|${server}|${app}`
	}

	/** True (and records the send) when the key was not seen inside windowMs. */
	claim(key: string, windowMs: number): boolean {
		const t = this.now()
		const last = this.seen.get(key)
		if (last !== undefined && t - last < windowMs) return false
		this.seen.set(key, t)
		if (this.seen.size > 5000) this.prune(t)
		return true
	}

	/** Undo a claim whose sends all failed, so the next attempt is not swallowed. */
	release(key: string): void {
		this.seen.delete(key)
	}

	private prune(t: number): void {
		for (const [k, v] of this.seen) if (t - v > 24 * 60 * 60 * 1000) this.seen.delete(k)
	}
}
