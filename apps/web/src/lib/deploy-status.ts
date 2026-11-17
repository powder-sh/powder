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

// Stored triggered_by -> how and who, as "<how> · <who>".
//   "webhook:octo-dev" / "push:octo-dev"  -> "push · octo-dev"
//   "manual:alex@example.com" / "wizard:…" -> "manual · alex@example.com"
//   "alex@example.com" (older rows)        -> "manual · alex@example.com"
export function triggeredByLabel(t: string | null | undefined): string | null {
	if (!t) return null
	const m = t.match(/^([a-z_-]+):(.+)$/)
	if (!m) return t.includes('@') ? `manual · ${t}` : t
	const [, how, who] = m as unknown as [string, string, string]
	if (how === 'push' || how.startsWith('webhook')) return `push · ${who}`
	if (how === 'manual' || how === 'wizard') return `manual · ${who}`
	return `${how.replace(/[_-]/g, ' ')} · ${who}`
}
