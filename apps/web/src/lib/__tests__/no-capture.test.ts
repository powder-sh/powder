import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// PostHog session recording must not capture deploy output, errors,
// summaries, cron errors or container logs. Per element, not per file: every
// <pre>, and the element directly around every rendered deploy/cron text field,
// carries `ph-no-capture`. (A count-based check would pass with one deploy
// output block missing it.)
const SRC = join(__dirname, '..', '..')

// <pre> blocks that only ever show static text (docs, setup commands, prompts
// with no log in them). Shrink-only.
const STATIC_PRE = new Set([
	'components/add-server-card.tsx',
	'components/install-command.tsx',
	'components/landing-prompts.tsx',
])

// `{x.errorSummary}`, `{d.output}`, `{deploy.error}`, `{summary}`, `{e.detail}` ...
// as JSX children (not attribute values, not template literals).
const TEXT_EXPR =
	/(?<![=$])\{\s*(?:[A-Za-z_][\w.?!]*\.(?:errorSummary|output|outputPreview|failedStep|snippet|lastRunError|detail)|(?:deploy|liveDeploy|d)\.error|summary|output|errorSummary|log|logTail)\s*(?:\?\?[^{}]*)?\}/g
const OPEN_TAG = /<([A-Za-z][\w.]*)(?=[\s>/])/g

function tsxFiles(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (name === '__tests__' || name === 'node_modules') continue
		if (statSync(p).isDirectory()) out.push(...tsxFiles(p))
		else if (name.endsWith('.tsx')) out.push(p)
	}
	return out
}

// The opening tag text starting at `at`, up to the `>` that closes it (a `>`
// inside `=>` or a `{...}` attribute value does not count).
function tagText(src: string, at: number): string {
	let depth = 0
	for (let i = at; i < src.length; i++) {
		const c = src[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(at, i + 1)
	}
	return src.slice(at)
}

const files = [...tsxFiles(join(SRC, 'app')), ...tsxFiles(join(SRC, 'components'))]
const rel = (f: string) => relative(SRC, f)

describe('ph-no-capture, per element', () => {
	it('every <pre> that can show runtime text is marked', () => {
		const bad: string[] = []
		for (const f of files) {
			if (STATIC_PRE.has(rel(f))) continue
			const src = readFileSync(f, 'utf8')
			for (const m of src.matchAll(/<pre\b/g)) {
				if (!tagText(src, m.index).includes('ph-no-capture')) {
					bad.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`)
				}
			}
		}
		expect(bad).toEqual([])
	})

	it('the element around every rendered deploy/cron text field is marked', () => {
		const bad: string[] = []
		for (const f of files) {
			const src = readFileSync(f, 'utf8')
			for (const m of src.matchAll(TEXT_EXPR)) {
				const opens = [...src.slice(0, m.index).matchAll(OPEN_TAG)]
				const parent = opens.at(-1)
				if (!parent) continue
				if (!tagText(src, parent.index).includes('ph-no-capture')) {
					bad.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length} ${m[0]}`)
				}
			}
		}
		expect(bad).toEqual([])
	})

	it('the static <pre> allowlist has no stale entries', () => {
		for (const f of STATIC_PRE) {
			expect(readFileSync(join(SRC, f), 'utf8')).toMatch(/<pre\b/)
		}
	})
})
