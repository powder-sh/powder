import { listDocs } from '@/lib/docs'
import { siteUrl } from '@/lib/hosts'
import type { MetadataRoute } from 'next'
import { connection } from 'next/server'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	// The install's own host comes from runtime env: read it per request, not at build.
	await connection()
	const base = siteUrl()
	return [{ url: `${base}/` }, { url: `${base}/docs` }, ...listDocs().map((d) => ({ url: `${base}/docs/${d.slug}` }))]
}
