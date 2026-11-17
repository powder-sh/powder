import { getDoc, listDocs } from '@/lib/docs'
import { HERO_LINE, OG_CONTENT_TYPE, OG_SIZE, renderCard } from '@/lib/og-card'
import { notFound } from 'next/navigation'

export const alt = 'powder docs'
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE


export function generateStaticParams() {
	return listDocs().map((d) => ({ slug: d.slug }))
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params
	const doc = getDoc(slug)
	if (!doc) notFound()
	return renderCard({
		eyebrow: 'Docs',
		title: doc.title,
		sub: doc.description || HERO_LINE,
	})
}
