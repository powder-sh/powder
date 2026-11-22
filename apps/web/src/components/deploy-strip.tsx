// Deploy history strips for the dashboard: one cell per UTC day, last 30
// days, colored by what the deploys table recorded that day. powder keeps no
// uptime history, so this is labeled as deploys, never as uptime.
//
// Each day answers right away on hover, on keyboard focus (arrow keys move between
// days) and on tap: weekday, full UTC date and the counts, in one AnchoredTooltip
// per strip. No native title, so there is never a second, slower tooltip.

'use client'

import { AnchoredTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import {
	type DeployDay,
	dayCounts,
	dayLabel,
	dayTitle,
	dayTone,
	summarizeDays,
} from '@/lib/deploy-days'
import { useEffect, useId, useRef, useState } from 'react'

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

interface Tip {
	i: number
	rect: DOMRect
}

/** Open / close and keyboard for one strip. The cells are the strip's direct
 *  children, in day order; the strip itself is the one tab stop. */
function useDayTip(days: readonly DeployDay[], focusable: boolean) {
	const ref = useRef<HTMLDivElement>(null)
	const [tip, setTip] = useState<Tip | null>(null)
	const lastPointer = useRef('mouse')
	const tipId = useId()
	const open = tip !== null

	const show = (i: number) => {
		const cell = ref.current?.children[i]
		if (!cell || i < 0 || i >= days.length) return
		setTip({ i, rect: cell.getBoundingClientRect() })
	}
	const hide = () => setTip(null)

	// Scroll and resize move the cell away from the tooltip; a tap elsewhere closes it.
	useEffect(() => {
		if (!open) return
		const close = () => setTip(null)
		const outside = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setTip(null)
		}
		window.addEventListener('scroll', close, true)
		window.addEventListener('resize', close)
		document.addEventListener('pointerdown', outside)
		return () => {
			window.removeEventListener('scroll', close, true)
			window.removeEventListener('resize', close)
			document.removeEventListener('pointerdown', outside)
		}
	}, [open])

	const cellIndex = (target: EventTarget): number | null => {
		const el = target instanceof Element ? target.closest('[data-day-i]') : null
		if (!el || !ref.current?.contains(el)) return null
		return Number(el.getAttribute('data-day-i'))
	}

	const frame = {
		ref,
		tabIndex: focusable ? 0 : undefined,
		'aria-describedby': open ? tipId : undefined,
		onPointerDown: (e: React.PointerEvent) => {
			lastPointer.current = e.pointerType
		},
		onPointerMove: (e: React.PointerEvent) => {
			if (e.pointerType === 'touch') return
			const i = cellIndex(e.target)
			// In the gap between two cells, keep the day already shown.
			if (i !== null && i !== tip?.i) show(i)
		},
		onPointerLeave: (e: React.PointerEvent) => {
			if (e.pointerType !== 'touch') hide()
		},
		onClick: (e: React.MouseEvent) => {
			if (lastPointer.current !== 'touch') return
			const i = cellIndex(e.target)
			if (i === null) return
			// A tap only shows the day: it neither follows a link the strip sits in nor
			// reaches a button or row handler around it.
			e.preventDefault()
			e.stopPropagation()
			if (tip?.i === i) hide()
			else show(i)
		},
		onFocus: (e: React.FocusEvent<HTMLDivElement>) => {
			if (e.currentTarget.matches(':focus-visible') && !open) show(days.length - 1)
		},
		onBlur: hide,
		onKeyDown: (e: React.KeyboardEvent) => {
			const cur = tip?.i ?? days.length - 1
			const next =
				e.key === 'ArrowLeft'
					? Math.max(0, cur - 1)
					: e.key === 'ArrowRight'
						? Math.min(days.length - 1, cur + 1)
						: e.key === 'Home'
							? 0
							: e.key === 'End'
								? days.length - 1
								: null
			if (next !== null) {
				e.preventDefault()
				show(next)
			} else if (e.key === 'Escape' && open) {
				e.preventDefault()
				hide()
			}
		},
	}

	const day = tip ? days[tip.i] : undefined
	const tooltip =
		tip && day ? (
			<AnchoredTooltip id={tipId} anchor={tip.rect}>
				<div className="whitespace-nowrap font-medium">{dayTitle(day)}</div>
				<div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-muted-foreground"
				>
					<span
						aria-hidden="true"
						className={cn('h-2 w-2 shrink-0 rounded-[1.5px]', TONE_CLASS[dayTone(day)])}
					/>
					{dayCounts(day)}
				</div>
			</AnchoredTooltip>
		) : null

	// Mounted for the strip's whole life (outside role="img", whose children are
	// presentational), so a screen reader announces the first day too, not only the
	// changes after it. Only the text changes.
	const live = (
		<span className="sr-only" aria-live="polite">
			{day ? dayLabel(day) : ''}
		</span>
	)

	return { frame, active: tip?.i ?? null, tooltip, live }
}

/** Highlight for the day under the pointer or keyboard; the rest dim a little. */
function cellState(i: number, active: number | null): string {
	if (active === null) return ''
	return i === active
		? 'outline outline-1 outline-offset-1 outline-foreground/50'
		: 'opacity-60'
}

const FRAME_FOCUS =
	'rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

/** One small cell per day. For table rows and cards. `focusable={false}` inside a
 *  link or button, so the strip is not a focusable control nested in it (hover and
 *  tap still work; a tap opens the tooltip only). */
export function DeployStrip({
	days,
	className,
	focusable = true,
}: {
	days: readonly DeployDay[]
	className?: string
	focusable?: boolean
}) {
	const { frame, active, tooltip, live } = useDayTip(days, focusable)
	return (
		<>
			<div
				{...frame}
				role="img"
				aria-label={`deploys: ${stripSummary(days)}`}
				className={cn('flex h-3 items-stretch gap-[2px]', FRAME_FOCUS, className)}
			>
				{days.map((d, i) => (
					<span
						key={d.day}
						data-day-i={i}
						className={cn(
							'w-[5px] shrink-0 rounded-[1.5px] transition-opacity duration-100',
							TONE_CLASS[dayTone(d)],
							cellState(i, active),
						)}
					/>
				))}
			</div>
			{tooltip}
			{live}
		</>
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
	const { frame, active, tooltip, live } = useDayTip(days, true)
	const max = Math.max(1, ...days.map((d) => d.ok + d.failed))
	return (
		<>
			<div
				{...frame}
				role="img"
				aria-label={`deploys on all servers: ${stripSummary(days)}`}
				className={cn('flex h-10 items-end gap-[3px]', FRAME_FOCUS, className)}
			>
				{days.map((d, i) => {
					const n = d.ok + d.failed
					const tone = dayTone(d)
					return (
						<span
							key={d.day}
							data-day-i={i}
							className={cn(
								'min-w-0 flex-1 rounded-[2px] transition-opacity duration-100',
								tone === 'none' ? 'bg-border' : tone === 'ok' ? 'bg-success/80' : TONE_CLASS[tone],
								cellState(i, active),
							)}
							style={{ height: n === 0 ? '3px' : `${Math.max(14, (n / max) * 100)}%` }}
						/>
					)
				})}
			</div>
			{tooltip}
			{live}
		</>
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
