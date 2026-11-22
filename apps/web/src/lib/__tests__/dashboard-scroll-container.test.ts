import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// A layout that scrolls inside an element (the dashboard shell: an h-dvh flex box with
// <main> as the scroller) must make that element positioned. An absolutely positioned
// descendant (Tailwind's sr-only: live regions, table captions) takes the nearest
// positioned ancestor as its containing block. If the scroller is not positioned, that
// ancestor is the page: the element is laid out at its unscrolled offset, far below
// the viewport on a long list, and stretches the window's scroll area into blank
// space below the shell. With the scroller positioned, it scrolls and clips with the
// content instead.

const appDir = resolve(__dirname, '../../app')
const SCROLLS = /(^|:)overflow(-[xy])?-(auto|scroll)$/
const POSITIONED = /(^|:)(relative|absolute|fixed|sticky)$/

type Scroller = { file: string; line: number; id: string | null; classes: string[] }

function layoutFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name)
		if (e.isDirectory()) return layoutFiles(p)
		return e.name === 'layout.tsx' ? [p] : []
	})
}

/** Every JSX element in the file whose className carries an overflow auto/scroll utility. */
function scrollers(file: string): Scroller[] {
	const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
	const out: Scroller[] = []
	const visit = (node: ts.Node) => {
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			let classes: string[] = []
			let id: string | null = null
			for (const attr of node.attributes.properties) {
				if (!ts.isJsxAttribute(attr) || !attr.initializer) continue
				const name = attr.name.getText(src)
				// every string literal in the attribute (plain string, or cn(...) arguments)
				const strings: string[] = []
				const collect = (n: ts.Node) => {
					if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.push(n.text)
					ts.forEachChild(n, collect)
				}
				collect(attr.initializer)
				if (name === 'className') classes = strings.join(' ').split(/\s+/).filter(Boolean)
				if (name === 'id') id = strings[0] ?? null
			}
			if (classes.some((c) => SCROLLS.test(c))) {
				const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
				out.push({ file: relative(appDir, file), line, id, classes })
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(src)
	return out
}

const all = layoutFiles(appDir).flatMap(scrollers)

describe('layout scroll containers', () => {
	it('finds the dashboard scroller (the check is not vacuous)', () => {
		const main = all.filter((s) => s.file === join('(dashboard)', 'layout.tsx') && s.id === 'main')
		expect(main).toHaveLength(1)
		expect(main[0].classes).toContain('overflow-y-auto')
	})

	it('the dashboard <main> scroller is the containing block of its descendants', () => {
		const main = all.find((s) => s.id === 'main')
		expect(main?.classes).toContain('relative')
	})

	it('every scroll container in a layout is positioned', () => {
		const unpositioned = all
			.filter((s) => !s.classes.some((c) => POSITIONED.test(c)))
			.map((s) => `${s.file}:${s.line}`)
		expect(unpositioned).toEqual([])
	})
})
