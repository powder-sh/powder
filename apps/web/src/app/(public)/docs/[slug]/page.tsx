import { DocsCopy } from '@/components/docs-copy'
import { DocsToc } from '@/components/docs-toc'
import { type DocMeta, getDoc, listDocs } from '@/lib/docs'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

type Props = { params: Promise<{ slug: string }> }

// Unknown slugs are a 404 via notFound(). No dynamicParams = false: on a
// standalone build that turns unknown slugs into 500s on some Next versions.

export function generateStaticParams() {
	return listDocs().map((d) => ({ slug: d.slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const { slug } = await params
	const doc = getDoc(slug)
	if (!doc) return {}
	const title = `${doc.title}: powder docs`
	return {
		title,
		description: doc.description,
		alternates: { canonical: `/docs/${doc.slug}` },
		// Images come from ./opengraph-image.tsx and ./twitter-image.tsx.
		openGraph: {
			type: 'article',
			siteName: 'powder',
			title,
			description: doc.description,
			url: `/docs/${doc.slug}`,
		},
		twitter: { card: 'summary_large_image', title, description: doc.description },
	}
}

export default async function DocPage({ params }: Props) {
	const { slug } = await params
	const doc = getDoc(slug)
	if (!doc) notFound()
	const showToc = doc.toc.length >= 3
	return (
		<div className={showToc ? 'xl:grid xl:grid-cols-[minmax(0,1fr)_11rem] xl:gap-10' : undefined}>
			<article className="min-w-0 max-w-3xl">
				<p className="font-mono text-xs font-medium uppercase tracking-wider text-signal-ink">Docs</p>
				<h1 className="font-display mt-2 text-balance text-3xl font-bold sm:text-4xl">{doc.title}</h1>
				{doc.description && <p className="mt-3 text-base text-muted-foreground">{doc.description}</p>}
				<div
					className="docs-prose mt-8 border-t border-border pt-8"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is rendered at build from repo-authored markdown
					dangerouslySetInnerHTML={{ __html: doc.html }}
				/>
				<DocsCopy />
				<PrevNext prev={doc.prev} next={doc.next} />
			</article>
			{showToc && (
				<aside className="hidden xl:block">
					<div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto pb-4">
						<DocsToc toc={doc.toc} />
					</div>
				</aside>
			)}
		</div>
	)
}

// Previous and next page in the docs order (lib/docs.ts compareDocs).
function PrevNext({ prev, next }: { prev: DocMeta | null; next: DocMeta | null }) {
	if (!prev && !next) return null
	return (
		<nav
			aria-label="previous and next page"
			className="mt-12 grid grid-cols-1 gap-3 border-t border-border pt-8 sm:grid-cols-2"
		>
			{prev ? (
				<Link
					href={`/docs/${prev.slug}`}
					className="group rounded-xl border border-border p-4 transition-colors hover:border-border-strong"
				>
					<span className="flex items-center gap-1 text-xs text-muted-foreground">
						<ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" aria-hidden="true" />
						Previous
					</span>
					<span className="mt-1 block font-semibold tracking-tight">{prev.title}</span>
				</Link>
			) : (
				<span className="hidden sm:block" />
			)}
			{next && (
				<Link
					href={`/docs/${next.slug}`}
					className="group rounded-xl border border-border p-4 text-right transition-colors hover:border-border-strong"
				>
					<span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
						Next
						<ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
					</span>
					<span className="mt-1 block font-semibold tracking-tight">{next.title}</span>
				</Link>
			)}
		</nav>
	)
}
