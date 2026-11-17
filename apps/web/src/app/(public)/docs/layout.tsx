import { DocsNav } from '@/components/docs-nav'
import { listDocs } from '@/lib/docs'

export default function DocsLayout({ children }: { children: React.ReactNode }) {
	const docs = listDocs().map(({ slug, title }) => ({ slug, title }))
	return (
		<div className="mx-auto grid w-full max-w-[69rem] grid-cols-1 gap-6 pb-20 pt-6 sm:pt-10 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10 xl:gap-12">
			<aside className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto">
				<DocsNav docs={docs} />
			</aside>
			<div className="min-w-0">{children}</div>
		</div>
	)
}
