'use client'

import { Button } from '@/components/ui/button'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type State = 'idle' | 'copied' | 'selected'

// Copies `text` to the clipboard. Where the Clipboard API is missing or refused
// (plain http, old browsers), it selects the prompt block `targetId` instead so
// Ctrl/Cmd+C still works, and says so.
export function CopyPromptButton({
	text,
	targetId,
	label,
}: {
	text: string
	targetId: string
	label: string
}) {
	const [state, setState] = useState<State>('idle')
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current)
		},
		[],
	)

	function flash(next: State) {
		setState(next)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => setState('idle'), 2000)
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(text)
			flash('copied')
		} catch {
			const el = document.getElementById(targetId)
			const sel = window.getSelection()
			if (el && sel) {
				const range = document.createRange()
				range.selectNodeContents(el)
				sel.removeAllRanges()
				sel.addRange(range)
			}
			flash('selected')
		}
	}

	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="xs"
				onClick={copy}
				aria-label={state === 'idle' ? `Copy prompt: ${label}` : undefined}
				className="min-w-[4.75rem]"
			>
				{state === 'copied' ? (
					<Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
				) : (
					<Copy className="h-3.5 w-3.5" aria-hidden="true" />
				)}
				{state === 'copied' ? 'copied' : state === 'selected' ? 'selected' : 'copy'}
			</Button>
			<span className="sr-only" aria-live="polite">
				{state === 'copied'
					? 'Prompt copied to clipboard'
					: state === 'selected'
						? 'Prompt selected, press Ctrl+C or Cmd+C to copy'
						: ''}
			</span>
		</>
	)
}
