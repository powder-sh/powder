// Every internal link to a docs anchor must land on a heading that exists, so a
// renamed heading cannot leave the update notice, the agent prompts, the FAQ or a
// docs page pointing at nothing. Covers `/docs/<slug>#<id>` in code and docs,
// `doc('<slug>', '#<id>')` in the agent prompts, and same-page `](#<id>)` links in
// each docs page.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { docHref, getDoc, listDocs, renderDoc } from '../docs'

const WEB = resolve(__dirname, '../../..')

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (e === 'node_modules' || e === '__tests__' || e.startsWith('.')) continue
		const p = join(dir, e)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (/\.(ts|tsx|md)$/.test(e)) out.push(p)
	}
	return out
}

function ids(slug: string): Set<string> {
	const html = getDoc(slug)?.html ?? ''
	return new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] as string))
}

describe('docs anchor links', () => {
	it('every /docs/<slug>#<id> and doc(slug, #id) link resolves to a heading', () => {
		const slugs = new Set(listDocs().map((d) => d.slug))
		const bad: string[] = []
		let seen = 0
		for (const f of [...walk(join(WEB, 'src')), ...walk(join(WEB, 'content'))]) {
			const text = readFileSync(f, 'utf8')
			const links = [
				...[...text.matchAll(/\/docs\/([a-z0-9-]+)#([a-z0-9-]+)/g)].map((m) => [m[1], m[2]]),
				...[...text.matchAll(/doc\('([a-z0-9-]+)',\s*'#([a-z0-9-]+)'\)/g)].map((m) => [m[1], m[2]]),
			] as Array<[string, string]>
			for (const [slug, id] of links) {
				seen++
				if (!slugs.has(slug) || !ids(slug).has(id))
					bad.push(`${f.slice(WEB.length + 1)}: /docs/${slug}#${id}`)
			}
		}
		expect(seen).toBeGreaterThan(3)
		expect(bad).toEqual([])
	})

	it('repo-root and docs/ markdown links to docs pages resolve too', () => {
		const ROOT = resolve(WEB, '../..')
		const slugs = new Set(listDocs().map((d) => d.slug))
		const files = [
			...readdirSync(ROOT).filter((f) => f.endsWith('.md')).map((f) => join(ROOT, f)),
			...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join(ROOT, 'docs', f)),
		]
		const bad: string[] = []
		let seen = 0
		for (const f of files) {
			const text = readFileSync(f, 'utf8')
			const links = [
				...[...text.matchAll(/content\/docs\/([a-z0-9-]+)\.md#([a-z0-9-]+)/g)].map((m) => [m[1], m[2]]),
				...[...text.matchAll(/\/docs\/([a-z0-9-]+)#([a-z0-9-]+)/g)].map((m) => [m[1], m[2]]),
			] as Array<[string, string]>
			for (const [slug, id] of links) {
				seen++
				if (!slugs.has(slug) || !ids(slug).has(id)) bad.push(`${f.slice(ROOT.length + 1)}: ${slug}#${id}`)
			}
		}
		expect(seen).toBeGreaterThan(0)
		expect(bad).toEqual([])
	})

	it('repo-root and docs/ markdown links are relative paths that exist (a /docs/ site path does not resolve on GitHub)', () => {
		const ROOT = resolve(WEB, '../..')
		const files = [
			...readdirSync(ROOT).filter((f) => f.endsWith('.md')).map((f) => join(ROOT, f)),
			...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join(ROOT, 'docs', f)),
		]
		const bad: string[] = []
		let seen = 0
		for (const f of files) {
			const text = readFileSync(f, 'utf8')
			for (const m of text.matchAll(/\]\((\/docs\/[^)\s]*)\)/g)) bad.push(`${f.slice(ROOT.length + 1)}: site path ${m[1]}`)
			for (const m of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+\.md)(?:#[^)\s]*)?\)/g)) {
				seen++
				if (!existsSync(resolve(dirname(f), m[1] as string))) bad.push(`${f.slice(ROOT.length + 1)}: ${m[1]}`)
			}
		}
		expect(seen).toBeGreaterThan(0)
		expect(bad).toEqual([])
	})

	it('same-page #anchor links inside each docs page resolve', () => {
		const bad: string[] = []
		for (const { slug } of listDocs()) {
			const md = readFileSync(join(WEB, 'content/docs', `${slug}.md`), 'utf8')
			const own = ids(slug)
			for (const m of md.matchAll(/\]\(#([a-z0-9-]+)\)/g))
				if (!own.has(m[1] as string)) bad.push(`${slug}#${m[1]}`)
		}
		expect(bad).toEqual([])
	})

	it('docs pages link each other as <slug>.md (works on GitHub), and every one resolves', () => {
		const slugs = new Set(listDocs().map((d) => d.slug))
		const bad: string[] = []
		let seen = 0
		for (const { slug } of listDocs()) {
			const md = readFileSync(join(WEB, 'content/docs', `${slug}.md`), 'utf8')
			// a site path only resolves on the docs site, not on GitHub
			for (const m of md.matchAll(/\]\((\/docs\/[^)]*)\)/g)) bad.push(`${slug}: site path ${m[1]}`)
			for (const m of md.matchAll(/\]\(([a-z0-9-]+)\.md(?:#([a-z0-9-]+))?\)/g)) {
				seen++
				const [, target, id] = m as unknown as [string, string, string | undefined]
				if (!slugs.has(target) || (id && !ids(target).has(id))) bad.push(`${slug}: ${target}.md${id ? `#${id}` : ''}`)
			}
		}
		expect(seen).toBeGreaterThan(30)
		expect(bad).toEqual([])
	})

	it('the renderer maps <slug>.md links to /docs/<slug>', () => {
		expect(docHref('upgrading.md')).toBe('/docs/upgrading')
		expect(docHref('self-hosting.md#install-script-options')).toBe('/docs/self-hosting#install-script-options')
		expect(docHref('./faq.md')).toBe('/docs/faq')
		for (const h of ['https://x.example.com/a.md', '../../docs/SECURITY-COMPOSE.md', '#local', '/docs/faq', 'README.md'])
			expect(docHref(h)).toBe(h)
		const { html } = renderDoc('See [upgrading](upgrading.md#the-schema) and [x](https://example.com/y.md).')
		expect(html).toContain('href="/docs/upgrading#the-schema"')
		expect(html).toContain('href="https://example.com/y.md"')
		expect(html).not.toContain('upgrading.md')
	})
})
