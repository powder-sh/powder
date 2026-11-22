// The servers list shows every URL of a container: the first ones directly, the rest
// in the DOM behind a "+N" toggle that controls them (aria-controls), never cut off.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContainerUrls, splitUrls } from '../../components/container-urls'

const render = (urls: string[], limit: number) => renderToStaticMarkup(createElement(ContainerUrls, { urls, limit }))

const FIVE = [
	'https://a.example.com',
	'https://b.example.com',
	'https://*.c.example.com',
	'https://d.example.com',
	'http://e.example.com',
]

describe('ContainerUrls', () => {
	it('splits after the limit, keeping every URL', () => {
		for (const n of [0, 1, 2, 3, 5]) {
			const urls = FIVE.slice(0, n)
			for (const limit of [1, 2]) {
				const { shown, rest } = splitUrls(urls, limit)
				expect([...shown, ...rest]).toEqual(urls)
				expect(shown.length).toBe(Math.min(n, limit))
			}
		}
	})

	it('renders every URL: the first ones visible, the rest in the region the toggle controls', () => {
		for (const n of [1, 2, 3, 5]) {
			for (const limit of [1, 2]) {
				const urls = FIVE.slice(0, n)
				const html = render(urls, limit)
				for (const u of urls) {
					const label = u.replace(/^https?:\/\//, '')
					expect(html).toContain(label)
					if (!u.includes('*')) expect(html).toContain(`href="${u}"`)
				}
				const hiddenCount = Math.max(0, n - limit)
				if (hiddenCount === 0) {
					expect(html).not.toContain('aria-controls')
					expect(html).not.toContain(' hidden=')
					continue
				}
				const id = /aria-controls="([^"]+)"/.exec(html)?.[1]
				expect(id).toBeTruthy()
				expect(html).toContain('aria-expanded="false"')
				expect(html).toContain(`>+${hiddenCount}</button>`)
				// the controlled region holds exactly the URLs after the limit
				const region = html.slice(html.indexOf(`id="${id}"`))
				expect(region.startsWith(`id="${id}" hidden=""`)).toBe(true)
				for (const u of urls.slice(limit)) expect(region).toContain(u.replace(/^https?:\/\//, ''))
				for (const u of urls.slice(0, limit)) expect(region).not.toContain(`>${u.replace(/^https?:\/\//, '')}<`)
			}
		}
	})

	it('a wildcard host is text, not a link; no URL renders a dash', () => {
		const html = render(['https://*.c.example.com'], 2)
		expect(html).not.toContain('<a ')
		expect(html).toContain('*.c.example.com')
		expect(render([], 2)).toContain('>-</span>')
	})

	it('URLs from the domain record carry the quiet note; discovered ones do not', () => {
		expect(render(['https://a.example.com'], 2)).not.toContain('not found in the proxy config')
		const html = renderToStaticMarkup(
			createElement(ContainerUrls, { urls: ['https://a.example.com'], limit: 2, notInProxy: true }),
		)
		expect(html).toContain('href="https://a.example.com"')
		expect(html).toContain('>not found in the proxy config</span>')
	})

	it('links and the toggle sit above the row link and open safely', () => {
		const html = render(FIVE, 2)
		for (const a of html.match(/<a [^>]*>/g) ?? []) {
			expect(a).toContain('relative z-10')
			expect(a).toContain('rel="noopener noreferrer"')
			expect(a).toContain('target="_blank"')
		}
		expect(html).toMatch(/<button type="button" aria-expanded="false" aria-controls="[^"]+" aria-label="show 3 more URLs" class="relative z-10 /)
	})

	it('the servers page renders every URL through ContainerUrls, also below md', () => {
		const src = readFileSync(join(__dirname, '../../app/(dashboard)/servers/page.tsx'), 'utf8')
		expect(src).not.toContain('urls.slice(')
		expect(src).toContain("<ContainerUrls urls={c.urls} limit={2} notInProxy={c.urlSource === 'app-domains'} />")
		expect(src).toMatch(/md:hidden">\s*<ContainerUrls urls=\{c\.urls\} limit=\{1\} notInProxy=\{c\.urlSource === 'app-domains'\} \/>/)
	})
})
