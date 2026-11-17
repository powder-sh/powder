// The install's public URL (metadataBase, sitemap) comes from its own configured
// host, never the project's site, unless nothing is configured.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { siteUrl } from '../hosts'
import { SITE_URL } from '../site'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('siteUrl', () => {
	it('uses the first POWDER_SITE_HOST when the hosts are split', () => {
		expect(siteUrl({ POWDER_SITE_HOST: 'Www.Example.COM:443, example.com', BETTER_AUTH_URL: 'https://deploy.example.com' })).toBe(
			'https://www.example.com',
		)
	})
	it('uses the BETTER_AUTH_URL origin when not split', () => {
		expect(siteUrl({ BETTER_AUTH_URL: 'https://deploy.example.org/some/path' })).toBe('https://deploy.example.org')
	})
	it('falls back to the project site only when nothing is configured', () => {
		expect(siteUrl({})).toBe(SITE_URL)
		expect(siteUrl({ BETTER_AUTH_URL: 'not a url' })).toBe(SITE_URL)
	})
	it('the sitemap lists the configured host', async () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		vi.stubEnv('BETTER_AUTH_URL', 'https://deploy.example.net')
		vi.doMock('server-only', () => ({}))
		vi.doMock('next/server', () => ({ connection: async () => {} }))
		const { default: sitemap } = await import('../../app/sitemap')
		const urls = (await sitemap()).map((e) => e.url)
		expect(urls[0]).toBe('https://deploy.example.net/')
		expect(urls.every((u) => u.startsWith('https://deploy.example.net/'))).toBe(true)
	})
})

// The docs are static (rendered at build). connection() in the root layout or in
// the docs' header would make every docs page render per request again.
describe('static docs', () => {
	const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
	it('the root layout reads metadataBase without connection()', () => {
		const src = read('../../app/layout.tsx')
		expect(src).not.toMatch(/await connection\(\)/)
		expect(src).toContain('metadataBase: new URL(siteUrl())')
	})
	it('the docs layout uses the header without the runtime sign-in link', () => {
		expect(read('../../app/(public)/layout.tsx')).toContain('<SiteHeader signIn={false} />')
		expect(read('../../components/site-chrome.tsx')).toContain('if (signIn) await connection()')
	})
})
