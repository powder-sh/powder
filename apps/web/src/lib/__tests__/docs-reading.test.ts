// The docs page: one install command shared with the landing page, copy
// buttons on fenced blocks, an on-page contents list and prev/next links.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { getDoc, listDocs, renderDoc } from '../docs'
import { INSTALL_LINES, installLines } from '../install-command'

const WEB = join(__dirname, '..', '..', '..')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

describe('docs reading', () => {
	it('the quickstart shows exactly the landing page install commands', () => {
		const version = JSON.parse(readFileSync(join(WEB, '../../package.json'), 'utf8')).version as string
		const lines = installLines(version)
		const html = getDoc('quickstart')?.html ?? ''
		expect(html).toContain(esc(lines.join('\n')))
		expect(INSTALL_LINES[0]).toMatch(/^sudo git clone --branch v\d+\.\d+\.\d+ /)
		const landing = readFileSync(join(WEB, 'src/components/install-command.tsx'), 'utf8')
		expect(landing).toContain("import { INSTALL_LINES } from '@/lib/install-command'")
	})
	it('fenced blocks get a copy button; h2 and h3 make the contents list', () => {
		const { html, toc } = renderDoc('## One\n\n### Two\n\n```bash\nls -la\n```\n')
		expect(html).toContain('<div class="code-block"><pre><code class="language-bash">ls -la</code></pre><button')
		expect(html).toContain('data-copy')
		expect(toc).toEqual([
			{ depth: 2, id: 'one', text: 'One' },
			{ depth: 3, id: 'two', text: 'Two' },
		])
	})
	it('prev and next follow the docs order', () => {
		const all = listDocs()
		const second = getDoc(all[1]?.slug ?? '')
		expect(second?.prev?.slug).toBe(all[0]?.slug)
		expect(second?.next?.slug).toBe(all[2]?.slug)
		expect(getDoc(all[0]?.slug ?? '')?.prev).toBeNull()
	})
	it('no placeholder survives rendering', () => {
		for (const d of listDocs()) expect(getDoc(d.slug)?.html, d.slug).not.toMatch(/\{\{[A-Z_]+\}\}/)
	})
	it('operator-only sections sit in the appendix at the end of self-hosting', () => {
		const md = readFileSync(join(WEB, 'content/docs/self-hosting.md'), 'utf8')
		const appendix = md.indexOf('\n## Operator appendix')
		expect(appendix).toBeGreaterThan(0)
		expect(md.slice(appendix + 5)).not.toMatch(/\n## /)
		expect(md.indexOf('### Ops endpoint reporting')).toBeGreaterThan(appendix)
		expect(md.indexOf('### A schema applied by hand')).toBeGreaterThan(appendix)
	})
	it('docs prose says server, not server', () => {
		for (const d of listDocs()) {
			const md = readFileSync(join(WEB, 'content/docs', `${d.slug}.md`), 'utf8')
			const prose = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
			expect(prose, d.slug).not.toMatch(/\bbox(es)?\b/i)
		}
	})
})
