'use client'

// A small tooltip pinned to an anchor rectangle (viewport coordinates, from
// getBoundingClientRect). Rendered into document.body with position: fixed, so an
// overflow-hidden table row or card cannot clip it. It sits above the anchor and
// flips below when there is no room, and its left edge is clamped to the viewport,
// so the first and last cells of a strip and a phone-width screen keep it in view.
// The arrow stays on the anchor's center even when the tooltip is clamped.
//
// Display only: the caller owns open / close (hover, focus, tap) and points
// aria-describedby at `id`.

import { cn } from '@/lib/cn'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const GAP = 8
const EDGE = 8

interface Place {
	left: number
	top: number
	arrow: number
	below: boolean
}

export function AnchoredTooltip({
	id,
	anchor,
	children,
	className,
}: {
	id: string
	anchor: DOMRect
	children: React.ReactNode
	className?: string
}) {
	const ref = useRef<HTMLDivElement>(null)
	const [place, setPlace] = useState<Place | null>(null)

	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		const w = el.offsetWidth
		const h = el.offsetHeight
		const vw = document.documentElement.clientWidth
		const center = anchor.left + anchor.width / 2
		const left = Math.min(Math.max(EDGE, center - w / 2), Math.max(EDGE, vw - w - EDGE))
		const below = anchor.top - h - GAP < EDGE
		const top = below ? anchor.bottom + GAP : anchor.top - h - GAP
		const arrow = Math.min(Math.max(10, center - left), w - 10)
		setPlace({ left, top, arrow, below })
	}, [anchor])

	return createPortal(
		<div
			ref={ref}
			id={id}
			role="tooltip"
			style={
				place
					? { left: place.left, top: place.top }
					: { left: 0, top: 0, visibility: 'hidden' }
			}
			className={cn(
				'pointer-events-none fixed z-[70] max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-popover',
				place && 'motion-safe:animate-enter',
				className,
			)}
		>
			{children}
			{place && (
				<span
					aria-hidden="true"
					className={cn(
						'absolute h-2 w-2 -translate-x-1/2 rotate-45 border-border bg-popover',
						place.below ? '-top-[5px] border-l border-t' : '-bottom-[5px] border-b border-r',
					)}
					style={{ left: place.arrow }}
				/>
			)}
		</div>,
		document.body,
	)
}

/** Open / close for one AnchoredTooltip on a button or link: shown on mouse hover
 *  and on keyboard focus, never on touch, so a tap only acts. Spread `props` on the
 *  control and render `tooltip` next to it. The tooltip ignores the pointer, so it
 *  never takes a click. */
export function useHint(text: React.ReactNode) {
	const [rect, setRect] = useState<DOMRect | null>(null)
	const id = useId()
	const open = rect !== null

	// Scroll and resize move the control away from the tooltip.
	useEffect(() => {
		if (!open) return
		const close = () => setRect(null)
		window.addEventListener('scroll', close, true)
		window.addEventListener('resize', close)
		return () => {
			window.removeEventListener('scroll', close, true)
			window.removeEventListener('resize', close)
		}
	}, [open])

	const hide = () => setRect(null)
	const props = {
		'aria-describedby': open ? id : undefined,
		onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
			if (e.pointerType === 'mouse') setRect(e.currentTarget.getBoundingClientRect())
		},
		onPointerLeave: hide,
		onFocus: (e: React.FocusEvent<HTMLElement>) => {
			if (e.currentTarget.matches(':focus-visible')) setRect(e.currentTarget.getBoundingClientRect())
		},
		onBlur: hide,
		onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
			if (e.key === 'Escape' && open) hide()
		},
	}
	const tooltip = rect ? (
		<AnchoredTooltip id={id} anchor={rect} className="max-w-64">
			{text}
		</AnchoredTooltip>
	) : null
	return { props, tooltip }
}
