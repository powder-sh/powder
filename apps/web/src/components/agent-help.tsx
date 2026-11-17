'use client'

import { CopyPromptButton } from '@/components/copy-prompt-button'
import { cn } from '@/lib/cn'
import { Bot, ChevronRight } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'

// "ask your agent": a contextual, ready-to-paste prompt for Claude Code, Cursor
// or any agent with a shell. Collapsed by default to one quiet line; opens to
// the prompt and a copy button. Prompts come from lib/agent-help-prompts.ts and
// carry only what is on screen, never secrets.
export function AgentHelp({
	title,
	description,
	prompt,
	note,
	className,
}: {
	/** What the prompt does, lowercase: "prepare this server for powder". */
	title: string
	/** One line under the title when open. */
	description?: ReactNode
	prompt: string
	/** Extra line under the prompt, e.g. "secrets in the log are masked". */
	note?: ReactNode
	className?: string
}) {
	const [open, setOpen] = useState(false)
	const uid = useId()
	const panelId = `agent-help-${uid}`
	const bodyId = `agent-help-body-${uid}`

	return (
		<div className={cn('min-w-0', className)}>
			<button
				type="button"
				data-agent-help-toggle
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					'group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-dashed border-border-strong px-2 text-xs text-muted-foreground transition-colors',
					'hover:border-solid hover:bg-accent hover:text-foreground',
					'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
					open && 'border-solid bg-accent text-foreground',
				)}
			>
				<Bot aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-powder" />
				<span className="shrink-0 font-medium">ask your agent</span>
				<span aria-hidden="true" className="shrink-0 text-border-strong">
					·
				</span>
				<span className="truncate">{title}</span>
				<ChevronRight
					aria-hidden="true"
					className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
				/>
			</button>
			{open && (
				<section
					id={panelId}
					aria-label={`agent prompt: ${title}`}
					className="mt-2 min-w-0 rounded-lg border border-border bg-muted/40 p-3"
				>
					<div className="flex items-start justify-between gap-3">
						<h3 className="min-w-0 pt-1 text-sm font-medium text-foreground">{title}</h3>
						{/* CopyPromptButton is shared with the public site (sentence case);
						    the dashboard is lowercase, so case it here. */}
						<span className="shrink-0 [&_button]:lowercase">
							<CopyPromptButton text={prompt} targetId={bodyId} label={title} />
						</span>
					</div>
					<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
						{description ?? 'paste into Claude Code, Cursor or any agent with a shell.'}
					</p>
					<pre
						id={bodyId}
						className="ph-no-capture mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2.5 font-mono text-2xs leading-relaxed text-foreground sm:text-xs"
					>
						{prompt}
					</pre>
					<p className="mt-2 text-2xs text-muted-foreground">
						{note ?? 'built from what is on this page. no secrets included.'}
					</p>
				</section>
			)}
		</div>
	)
}
