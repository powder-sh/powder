// The one vocabulary for a deploy row: status (queued/running/success/failed as
// stored) and kind (git_deploy, rollback, ...). Every page and the command
// palette read labels and tones from here; a guard test keeps local copies out.

import type { StatusTone } from '@/components/ui/status'
import { CheckCircle2, Clock, Loader2, type LucideIcon, XCircle } from 'lucide-react'

export type DeployStatus = 'queued' | 'running' | 'success' | 'failed'

export interface StatusMeta {
	label: string
	tone: StatusTone
	pulse?: boolean
	icon: LucideIcon
}

export const DEPLOY_STATUS: Record<DeployStatus, StatusMeta> = {
	queued: { label: 'queued', tone: 'warning', pulse: true, icon: Clock },
	running: { label: 'building', tone: 'warning', pulse: true, icon: Loader2 },
	success: { label: 'ready', tone: 'success', icon: CheckCircle2 },
	failed: { label: 'failed', tone: 'destructive', icon: XCircle },
}

export function deployStatus(status: string | null | undefined): StatusMeta {
	return (
		DEPLOY_STATUS[status as DeployStatus] ?? {
			label: status ?? 'unknown',
			tone: 'neutral',
			icon: Clock,
		}
	)
}

type DeployKind =
	| 'git_deploy'
	| 'rollback'
	| 'env_change'
	| 'image_update'
	| 'manual_apply'
	| 'restart'
	| 'stop'
	| 'delete'

const DEPLOY_KIND: Record<DeployKind, string> = {
	git_deploy: 'deploy',
	rollback: 'rollback',
	env_change: 'env change',
	image_update: 'image update',
	manual_apply: 'apply',
	restart: 'restart',
	stop: 'stop',
	delete: 'delete',
}

export function deployKindLabel(kind: string | null | undefined): string {
	if (!kind) return 'deploy'
	return DEPLOY_KIND[kind as DeployKind] ?? kind.replace(/_/g, ' ')
}

// A plain git deploy is the default and needs no badge; every other kind does.
export function deployKindBadge(kind: string | null | undefined): string | null {
	return !kind || kind === 'git_deploy' ? null : deployKindLabel(kind)
}

// Stored triggered_by -> how and who. The one parser of triggered_by: the "triggered
// by" label, the /deploys author filter and its dropdown all read it.
//   "webhook:octo-dev" / "webhook-group:octo-dev" / "webhook-catchup:…" /
//   "webhook-group-catchup:…" / "push:octo-dev"  -> push by octo-dev
//   "manual:alex@example.com" / "wizard:…"       -> manual by alex@example.com
//   "alex@example.com" (older rows)              -> manual by alex@example.com
//   "reconcile", "webhook" (no login)            -> no person
export interface Trigger {
	/** 'push' (any webhook prefix), 'manual' (manual or wizard), else the stored prefix; null = none */
	how: string | null
	/** the login or user, null when the row names none */
	who: string | null
	/** "<how> · <who>" for display; null = no trigger recorded */
	label: string | null
	/** the author-filter value that matches this row: "push:<login>" or "manual:<user>"; null = no person */
	filter: string | null
}

export function parseTrigger(t: string | null | undefined): Trigger {
	if (!t) return { how: null, who: null, label: null, filter: null }
	const m = t.match(/^([a-z_-]+):(.+)$/)
	if (!m) {
		if (t.includes('@')) return { how: 'manual', who: t, label: `manual · ${t}`, filter: `manual:${t}` }
		return { how: t, who: null, label: t, filter: null }
	}
	const [, how, who] = m as unknown as [string, string, string]
	if (how === 'push' || how.startsWith('webhook')) return { how: 'push', who, label: `push · ${who}`, filter: `push:${who}` }
	if (how === 'manual' || how === 'wizard') return { how: 'manual', who, label: `manual · ${who}`, filter: `manual:${who}` }
	return { how, who, label: `${how.replace(/[_-]/g, ' ')} · ${who}`, filter: null }
}

export function triggeredByLabel(t: string | null | undefined): string | null {
	return parseTrigger(t).label
}

/** An author-filter value as the list sends it: "push:<login>", "manual:<user>", or a bare
 *  login (older links) read as "push:<login>". Null = no filter. */
export function normalizeAuthorFilter(v: string | null | undefined): string | null {
	const t = v?.trim()
	if (!t) return null
	return /^(push|manual):./.test(t) ? t : `push:${t}`
}

/** The stored triggered_by values (of the ones given) an author filter matches: every
 *  push-like prefix for a login, manual and wizard deploys (and older bare emails) for a
 *  user. Pure. */
export function triggersMatching(filter: string, values: readonly (string | null)[]): string[] {
	const f = normalizeAuthorFilter(filter)
	return values.filter((v): v is string => !!v && parseTrigger(v).filter === f)
}

/** The author dropdown: one option per person found in triggered_by, pushes as the login,
 *  manual deploys as "<user> (manual)". Pure. */
export function authorOptions(values: readonly (string | null)[]): { value: string; label: string }[] {
	const out = new Map<string, string>()
	for (const v of values) {
		const t = parseTrigger(v)
		if (t.filter && t.who) out.set(t.filter, t.how === 'manual' ? `${t.who} (manual)` : t.who)
	}
	return [...out.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
}
