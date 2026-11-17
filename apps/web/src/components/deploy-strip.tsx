// Deploy history strips for the dashboard: one cell per UTC day, last 30
// days, colored by what the deploys table recorded that day. powder keeps no
// uptime history, so this is labeled as deploys, never as uptime.

import { cn } from '@/lib/cn'
import { type DeployDay, dayLabel, dayTone, summarizeDays } from '@/lib/deploy-days'

const TONE_CLASS = {
	none: 'bg-border',
	ok: 'bg-success',
	mixed: 'bg-warning',
	failed: 'bg-destructive',
} as const

/** The window length, then ok and failed deploy counts. */
export function stripSummary(days: readonly DeployDay[]): string {
	const s = summarizeDays(days)
	if (s.ok + s.failed === 0) return `no deploys in the last ${days.length} days`
	return `${days.length} days: ${s.ok} ok, ${s.failed} failed`
}

/** Nothing on record in the window: callers hide the strip. */
export function stripEmpty(days: readonly DeployDay[]): boolean {
	return days.every((d) => d.ok + d.failed === 0)
}

/** One small cell per day. For table rows and cards. */
export function DeployStrip({
	days,
	className,
}: {
	days: readonly DeployDay[]
	className?: string
}) {
	return (
		<div
			role="img"
			aria-label={`deploys: ${stripSummary(days)}`}
			className={cn('flex h-3 items-stretch gap-[2px]', className)}
		>
			{days.map((d) => (
				<span
					key={d.day}
					title={dayLabel(d)}
					className={cn('w-[5px] shrink-0 rounded-[1.5px]', TONE_CLASS[dayTone(d)])}
				/>
			))}
		</div>
	)
}

/** Bars sized by deploy count (fleet heartbeat). Height is fixed, so no shift. */
export function DeployBars({
	days,
	className,
}: {
	days: readonly DeployDay[]
	className?: string
}) {
	const max = Math.max(1, ...days.map((d) => d.ok + d.failed))
	return (
		<div
			role="img"
			aria-label={`deploys on all servers: ${stripSummary(days)}`}
			className={cn('flex h-10 items-end gap-[3px]', className)}
		>
			{days.map((d) => {
				const n = d.ok + d.failed
				const tone = dayTone(d)
				return (
					<span
						key={d.day}
						title={dayLabel(d)}
						className={cn(
							'min-w-0 flex-1 rounded-[2px]',
							tone === 'none' ? 'bg-border' : tone === 'ok' ? 'bg-success/80' : TONE_CLASS[tone],
						)}
						style={{ height: n === 0 ? '3px' : `${Math.max(14, (n / max) * 100)}%` }}
					/>
				)
			})}
		</div>
	)
}

export function StripLegend({ className }: { className?: string }) {
	return (
		<div
			className={cn(
				'flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground',
				className,
			)}
		>
			{(
				[
					['ok', 'all ok'],
					['mixed', 'some failed'],
					['failed', 'all failed'],
					['none', 'no deploys'],
				] as const
			).map(([t, label]) => (
				<span key={t} className="inline-flex items-center gap-1">
					<span className={cn('h-2 w-2 rounded-[1.5px]', TONE_CLASS[t])} aria-hidden="true" />
					{label}
				</span>
			))}
		</div>
	)
}
