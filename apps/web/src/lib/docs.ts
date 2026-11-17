import 'server-only'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { Marked } from 'marked'
import { PUBLIC_REPO_URL } from './site'

const DOCS_DIR = join(process.cwd(), 'content', 'docs')

export interface DocMeta {
	slug: string
	title: string
	order: number
	description: string
}

export interface TocEntry {
	depth: 2 | 3
	id: string
	text: string
}

export interface Doc extends DocMeta {
	html: string
	/** h2 and h3 of the page, in order, for the on-page contents rail. */
	toc: TocEntry[]
	prev: DocMeta | null
	next: DocMeta | null
}

/** Placeholders a docs page may use; swapped before rendering. */
const DOC_PLACEHOLDERS: Record<string, () => string> = {
	'{{REPO_URL}}': () => PUBLIC_REPO_URL,
}

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/<[^>]+>/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'section'
	)
}

function plain(html: string): string {
	return html
		.replace(/<[^>]+>/g, '')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
}

/** A link to a sibling docs page as written in content/docs (`upgrading.md`,
 *  `self-hosting.md#install-script-options`, so it also works on GitHub) becomes the
 *  site path (`/docs/upgrading`, `/docs/self-hosting#install-script-options`). Any
 *  other href is returned as it is. Pure. */
export function docHref(href: string): string {
	const m = /^(?:\.\/)?([a-z0-9-]+)\.md(#[A-Za-z0-9_-]*)?$/.exec(href)
	return m ? `/docs/${m[1]}${m[2] ?? ''}` : href
}

export function renderDoc(md: string): { html: string; toc: TocEntry[] } {
	const used = new Map<string, number>()
	const toc: TocEntry[] = []
	const marked = new Marked({ gfm: true })
	marked.use({
		walkTokens(token) {
			if (token.type === 'link') token.href = docHref(token.href)
		},
		renderer: {
			heading({ tokens, depth, text }) {
				const inner = this.parser.parseInline(tokens)
				let id = slugify(text)
				const n = used.get(id) ?? 0
				used.set(id, n + 1)
				if (n > 0) id = `${id}-${n}`
				if (depth === 2 || depth === 3) toc.push({ depth, id, text: plain(inner) })
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${depth}>\n`
			},
			// Every fenced block gets a copy button; components/docs-copy.tsx wires
			// the clicks, so the page stays static HTML.
			code({ text, lang }) {
				const cls = lang ? ` class="language-${esc(lang)}"` : ''
				return `<div class="code-block"><pre><code${cls}>${esc(text)}</code></pre><button type="button" class="code-copy" data-copy aria-label="copy">copy</button></div>\n`
			},
			table(token) {
				const head = token.header
					.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`)
					.join('')
				const body = token.rows
					.map(
						(r) =>
							`<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`,
					)
					.join('')
				return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`
			},
		},
	})
	let src = md
	// A multi-line value keeps the indentation of its placeholder line, so it
	// stays inside a fenced block nested in a list item.
	for (const [k, v] of Object.entries(DOC_PLACEHOLDERS)) {
		const value = v()
		if (!value.includes('\n')) {
			src = src.replaceAll(k, value)
			continue
		}
		src = src.replace(
			new RegExp(`^([ \\t]*)(.*?)${k.replace(/[{}]/g, '\\$&')}`, 'gm'),
			(_m, indent: string, before: string) =>
				`${indent}${before}${value.split('\n').join(`\n${indent}`)}`,
		)
	}
	const html = marked.parse(src, { async: false }) as string
	return { html, toc }
}

function files(): string[] {
	try {
		return readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))
	} catch {
		return []
	}
}

export function listDocs(): DocMeta[] {
	return files()
		.map((f) => {
			const { data } = matter(readFileSync(join(DOCS_DIR, f), 'utf8'))
			return {
				slug: f.replace(/\.md$/, ''),
				title: String(data.title ?? f),
				order: Number(data.order ?? 100),
				description: String(data.description ?? ''),
			}
		})
		.sort(compareDocs)
}

/** Docs that lead the list whatever their `order` (quickstart first). A slug
 *  without a file is simply absent: the list is built from the files on disk. */
const LEADING_DOC_SLUGS = ['quickstart'] as const

/** Nav order: the leading slugs first, then frontmatter `order`, then slug. Pure. */
export function compareDocs(a: Pick<DocMeta, 'slug' | 'order'>, b: Pick<DocMeta, 'slug' | 'order'>): number {
	const lead = (s: string) => {
		const i = (LEADING_DOC_SLUGS as readonly string[]).indexOf(s)
		return i === -1 ? LEADING_DOC_SLUGS.length : i
	}
	return lead(a.slug) - lead(b.slug) || a.order - b.order || a.slug.localeCompare(b.slug)
}

export function getDoc(slug: string): Doc | null {
	const all = listDocs()
	const i = all.findIndex((d) => d.slug === slug)
	const meta = all[i]
	if (!meta) return null
	const { content } = matter(readFileSync(join(DOCS_DIR, `${meta.slug}.md`), 'utf8'))
	return { ...meta, ...renderDoc(content), prev: all[i - 1] ?? null, next: all[i + 1] ?? null }
}
