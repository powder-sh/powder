'use client'

import { cn } from '@/lib/cn'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface NavDoc {
	slug: string
	title: string
}

// Desktop: sticky list. Phone: one horizontally scrolling row of pills.
export function DocsNav({ docs }: { docs: NavDoc[] }) {
	const current = usePathname().split('/')[2]
	return (
		<nav aria-label="Docs" className="text-sm">
			<p className="mb-2 hidden px-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground lg:block">
				Docs
			</p>
			<ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0 [&::-webkit-scrollbar]:hidden">
				<li className="shrink-0">
					<Link
						href="/docs"
						aria-current={current === undefined ? 'page' : undefined}
						className={itemCls(current === undefined)}
					>
						Overview
					</Link>
				</li>
				{docs.map((d) => (
					<li key={d.slug} className="shrink-0">
						<Link
							href={`/docs/${d.slug}`}
							aria-current={d.slug === current ? 'page' : undefined}
							className={itemCls(d.slug === current)}
						>
							{d.title}
						</Link>
					</li>
				))}
			</ul>
		</nav>
	)
}

function itemCls(active: boolean) {
	return cn(
		'block whitespace-nowrap rounded-full border px-3 py-1.5 transition-colors lg:rounded-md lg:border-0 lg:px-2 lg:py-1.5 lg:whitespace-normal',
		active
			? 'border-border-strong bg-accent font-medium text-foreground'
			: 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground',
	)
}
