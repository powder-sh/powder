// Two agent prompts on the landing page, folded. The full set lives in
// components/agent-prompts.tsx; the docs and llms.txt carry the rest.

import { AGENT_PROMPTS } from '@/components/agent-prompts'
import { CopyPromptButton } from '@/components/copy-prompt-button'
import { ChevronRight } from 'lucide-react'

const SHOWN = ['app-ready', 'debug']

export function LandingPrompts() {
	const prompts = AGENT_PROMPTS.filter((p) => SHOWN.includes(p.id))
	return (
		<section className="mx-auto max-w-3xl pt-20 sm:pt-28" aria-labelledby="agent-prompts">
			<h2
				id="agent-prompts"
				className="font-display text-center text-[clamp(1.9rem,7vw,2.8rem)] font-bold leading-[1.05]"
			>
				Prompts for your coding agent
			</h2>
			<ul className="mt-8 space-y-3">
				{prompts.map((p) => {
					const bodyId = `prompt-${p.id}`
					return (
						<li key={p.id}>
							<details className="group rounded-[12px] border border-border bg-card">
								<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 sm:px-5 [&::-webkit-details-marker]:hidden">
									<ChevronRight
										className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
										aria-hidden="true"
									/>
									<span className="min-w-0 flex-1 text-[0.9375rem] font-semibold tracking-tight">
										{p.title}
									</span>
								</summary>
								<div className="border-t border-border px-4 pb-4 pt-3 sm:px-5">
									<div className="flex justify-end">
										<CopyPromptButton text={p.prompt} targetId={bodyId} label={p.title} />
									</div>
									<pre
										id={bodyId}
										className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground"
									>
										{p.prompt}
									</pre>
								</div>
							</details>
						</li>
					)
				})}
			</ul>
			<p className="mt-5 text-center text-sm text-muted-foreground">
				More prompts and the full docs for agents:{' '}
				<a
					href="/llms.txt"
					className="font-mono text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
				>
					/llms.txt
				</a>
			</p>
		</section>
	)
}
