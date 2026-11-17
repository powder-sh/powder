import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import * as og from '@/app/(public)/docs/[slug]/opengraph-image'
import * as page from '@/app/(public)/docs/[slug]/page'
import * as tw from '@/app/(public)/docs/[slug]/twitter-image'
import { listDocs } from '@/lib/docs'

// Only known slugs have a /docs/<slug>/opengraph-image: rendering a card on demand
// for any slug would be a satori render per attacker-chosen slug.
describe('docs/[slug] OG + twitter images', () => {
	for (const [name, mod] of [
		['opengraph-image', og],
		['twitter-image', tw],
	] as const) {
		it(`${name}: unknown slug is notFound() and dynamicParams is not set`, async () => {
			expect('dynamicParams' in mod).toBe(false)
			await expect(
				mod.default({ params: Promise.resolve({ slug: 'no-such-doc-xyz' }) }),
			).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
		})

		it(`${name}: every known doc slug is still prerendered`, () => {
			const slugs = mod.generateStaticParams().map((p) => p.slug)
			expect(slugs.length).toBeGreaterThan(0)
			expect(slugs).toEqual(listDocs().map((d) => d.slug))
		})
	}

	it('the docs page does not set dynamicParams (nextjs-patterns 2b)', () => {
		expect('dynamicParams' in page).toBe(false)
	})
})
