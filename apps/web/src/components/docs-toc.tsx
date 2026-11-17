'use client'

// On-page contents rail for wide screens: the page's h2 and h3, with the
// section in view highlighted.

import { cn } from '@/lib/cn'
import { useEffect, useState } from 'react'

interface Entry {
	depth: 2 | 3
	id: string
	text: string
}

export function DocsToc({ toc }: { toc: Entry[] }) {
	const [active, setActive] = useState<string | null>(toc[0]?.id ?? null)
	// The active entry is the last heading above the fold line; scroll and
	// jumps (anchor links, restored scroll) both update it.
	useEffect(() => {
		const els = toc
			.map((t) => document.getElementById(t.id))
			.filter((e): e is HTMLElement => !!e)
		if (els.length === 0) return
		let frame = 0
		const update = () => {
			frame = 0
			let current = els[0]?.id ?? null
			for (const el of els) if (el.getBoundingClientRect().top < 120) current = el.id
			setActive(current)
		}
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(update)
		}
		update()
		window.addEventListener('scroll', onScroll, { passive: true })
		return () => {
			window.removeEventListener('scroll', onScroll)
			if (frame) cancelAnimationFrame(frame)
		}
	}, [toc])
	return (
		<nav aria-label="on this page" className="text-sm">
			<p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
				On this page
			</p>
			<ul className="space-y-0.5 border-l border-border">
				{toc.map((t) => (
					<li key={t.id}>
						<a
							href={`#${t.id}`}
							aria-current={active === t.id ? 'location' : undefined}
							className={cn(
								'-ml-px block border-l py-1 leading-snug transition-colors',
								t.depth === 3 ? 'pl-6 text-xs' : 'pl-3 text-[0.8125rem]',
								active === t.id
									? 'border-signal-ink text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground',
							)}
						>
							{t.text}
						</a>
					</li>
				))}
			</ul>
		</nav>
	)
}
