'use client'

// The install commands (lib/install-command.ts, the quickstart shows the same
// lines), copyable in one click.

import { INSTALL_LINES } from '@/lib/install-command'
import { cn } from '@/lib/cn'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'


export function InstallCommand({ className }: { className?: string }) {
	const [copied, setCopied] = useState(false)
	async function copy() {
		try {
			await navigator.clipboard.writeText(INSTALL_LINES.join('\n'))
			setCopied(true)
			setTimeout(() => setCopied(false), 1600)
		} catch {
			// clipboard blocked: the text stays selectable
		}
	}
	return (
		<div
			className={cn(
				'wire-panel overflow-hidden rounded-[12px] border border-border-strong bg-card text-left',
				className,
			)}
		>
			<div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
				<span className="font-mono text-xs text-muted-foreground">on a fresh Linux server</span>
				<button
					type="button"
					onClick={copy}
					aria-label="copy the install commands"
					className="wire-cta inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
					{copied ? 'copied' : 'copy'}
				</button>
			</div>
			{/* Long lines wrap with a hanging indent: "$ " stays in the gutter and the
			    rest of the command lines up under its first character. */}
			<pre className="px-4 py-3.5 font-mono text-xs leading-relaxed sm:text-[0.8125rem] text-foreground">
				{INSTALL_LINES.map((l) => (
					<span
						key={l}
						className="block whitespace-pre-wrap pl-[2ch] [text-indent:-2ch] [overflow-wrap:anywhere]"
					>
						<span className="select-none text-muted-foreground">$ </span>
						{l}
					</span>
				))}
			</pre>
		</div>
	)
}
