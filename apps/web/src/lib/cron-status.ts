// A scheduled job's dot carries its last run, not whether it is switched on:
// green ran fine, red failed or timed out, grey never ran or is paused.

import type { StatusTone } from '@/components/ui/status'

export function cronRunTone(
	enabled: boolean,
	lastRunStatus: string | null | undefined,
): StatusTone {
	if (!enabled) return 'neutral'
	if (lastRunStatus === 'success') return 'success'
	if (lastRunStatus === 'failed' || lastRunStatus === 'timeout') return 'destructive'
	if (lastRunStatus === 'running') return 'warning'
	return 'neutral'
}

export function cronRunLabel(enabled: boolean, lastRunStatus: string | null | undefined): string {
	if (!enabled) return 'paused'
	if (lastRunStatus === 'success') return 'last run ok'
	if (lastRunStatus === 'failed') return 'last run failed'
	if (lastRunStatus === 'timeout') return 'last run timed out'
	if (lastRunStatus === 'running') return 'running'
	return 'not run yet'
}
