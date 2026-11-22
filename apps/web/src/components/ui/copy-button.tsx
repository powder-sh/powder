'use client'

// The dashboard's one copy control: an error, a log, a command, an id. A quiet
// ghost icon button (optionally with a short text) that copies `value` and
// shows "copied" with a check for about 2 s, announced to screen readers.
// Where the Clipboard API is missing or refused it falls back (lib/copy-text.ts)
// and says what happened: copied anyway, the text on the page selected so
// Ctrl/Cmd+C works (`targetId`), or that nothing was copied.
//
// `value` may be a function: it is only called on click, so a large log is not
// turned into a string on every render.
//
// In a dense row pass `reveal` and put `group` on the row: the control then shows
// on row hover and on keyboard focus, and is always visible below the sm width
// and on any device without hover (touch). Never place it inside another button
// or link.

import { cn } from '@/lib/cn'
import { type CopyOutcome, type CopySource, copyText } from '@/lib/copy-text'
import { Check, Copy, TextSelect, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { buttonVariants } from './button-variants'
import { useHint } from './tooltip'

type State = 'idle' | CopyOutcome

const SIZE = {
	// table rows, dense meta lines
	xs: 'h-9 min-w-9 gap-1 px-1.5 text-2xs sm:h-6 sm:min-w-6 sm:px-1',
	// section headers, toolbars
	sm: 'h-10 min-w-10 gap-1.5 px-2 text-xs sm:h-7 sm:min-w-7 sm:px-1.5',
	// inside running text: the negative margin keeps the line at the text's height
	inline: 'h-6 min-w-6 -my-1.5 gap-1 px-1 align-middle text-2xs',
} as const

const ICON = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', inline: 'h-3 w-3' } as const

// How long each outcome stays on screen: a selection needs time to read the hint.
const HOLD_MS: Record<CopyOutcome, number> = { copied: 2000, selected: 5000, failed: 5000 }

const VISIBLE: Record<CopyOutcome, string> = {
	copied: 'copied',
	selected: 'selected: press Ctrl/Cmd+C',
	failed: 'copy failed',
}

export function CopyButton({
	value,
	label,
	text,
	targetId,
	size = 'xs',
	variant = 'ghost',
	reveal = false,
	className,
}: {
	/** What to copy, or a function returning it (called on click only). */
	value: CopySource
	/** Accessible name and hover hint, e.g. "copy error". */
	label: string
	/** Optional short visible text next to the icon, e.g. "copy". */
	text?: string
	/** Element to select when the clipboard cannot be written. */
	targetId?: string
	size?: keyof typeof SIZE
	/** ghost by default; outline where it stands among outline buttons (page actions). */
	variant?: 'ghost' | 'outline'
	/** Hidden until row hover or keyboard focus on wide screens (needs a `group` parent). */
	reveal?: boolean
	className?: string
}) {
	const [state, setState] = useState<State>('idle')
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const hint = useHint(label)

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current)
		},
		[],
	)

	async function onClick(e: React.MouseEvent<HTMLButtonElement>) {
		// a copy control inside a clickable card must not trigger the card
		e.stopPropagation()
		let outcome: CopyOutcome
		try {
			outcome = await copyText(value, { targetId })
		} catch {
			outcome = 'failed'
		}
		setState(outcome)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => setState('idle'), HOLD_MS[outcome])
	}

	const Icon =
		state === 'copied' ? Check : state === 'selected' ? TextSelect : state === 'failed' ? X : Copy
	const shown = state === 'idle' ? text : VISIBLE[state]

	return (
		<>
			<button
				type="button"
				{...hint.props}
				onClick={onClick}
				aria-label={label}
				className={cn(
					buttonVariants({ variant, size: 'xs' }),
					SIZE[size],
					'font-sans font-normal',
					// hidden only on a wide screen with a hovering pointer, and only while
					// the row is not hovered or focused: touch screens of any width see it
					reveal &&
						state === 'idle' &&
						'sm:[@media(hover:hover)]:not-focus-visible:not-group-hover:not-group-focus-within:opacity-0',
					state === 'copied' && 'text-success hover:text-success',
					state === 'failed' && 'text-destructive hover:text-destructive',
					className,
				)}
			>
				<Icon className={ICON[size]} aria-hidden="true" />
				{shown && <span>{shown}</span>}
			</button>
			{hint.tooltip}
			<span className="sr-only" aria-live="polite">
				{state === 'copied'
					? 'Copied to clipboard'
					: state === 'selected'
						? 'Text selected, press Ctrl+C or Cmd+C to copy'
						: state === 'failed'
							? 'Copy failed, select the text and copy it by hand'
							: ''}
			</span>
		</>
	)
}
