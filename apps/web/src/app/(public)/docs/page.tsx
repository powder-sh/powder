import { listDocs } from '@/lib/docs'
import type { Metadata } from 'next'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'

export const metadata: Metadata = {
	title: 'Docs: powder',
	description:
		'Documentation for powder: self-hosting, how deploys run, domains, env vars, backups, crons and uptime.',
	alternates: { canonical: '/docs' },
	openGraph: {
		type: 'website',
		siteName: 'powder',
		title: 'Docs: powder',
		description:
			'Documentation for powder: self-hosting, how deploys run, domains, env vars, backups, crons and uptime.',
		url: '/docs',
	},
	twitter: { card: 'summary_large_image', title: 'Docs: powder' },
}

export default function DocsIndex() {
	const docs = listDocs()
	return (
		<article className="max-w-3xl">
			<h1 className="font-display text-3xl font-bold sm:text-4xl">Docs</h1>
			<p className="mt-3 text-base text-muted-foreground">
				Powder is an open-source deploy platform you install on your own servers. Start with the{' '}
				<Link href="/docs/quickstart" className="underline underline-offset-4 hover:text-foreground">
					quickstart
				</Link>
				.
			</p>
			<ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
				{docs.map((d) => (
					<li key={d.slug}>
						<Link
							href={`/docs/${d.slug}`}
							className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 shadow-card transition-colors hover:border-border-strong"
						>
							<span className="flex items-center justify-between gap-2 text-sm font-semibold tracking-tight">
								{d.title}
								<ArrowRight
									className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
									aria-hidden="true"
								/>
							</span>
							<span className="mt-1.5 block text-sm leading-relaxed text-muted-foreground">
								{d.description}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</article>
	)
}
