// The dashboard's one copy path (lib/copy-text.ts, components/ui/copy-button.tsx):
// the Clipboard API when it works; the execCommand copy, then selecting the shown text,
// when it is refused or missing; and an explicit "failed", never a silent no-op.
// A function source is only called when someone clicks.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from '../../components/ui/copy-button'
import { copyText } from '../copy-text'

interface FakeDoc {
	selected: string | null
	execResult: boolean | 'throw' | 'missing'
	appended: number
}

// A minimal document: enough for the textarea copy and the range selection.
function stubDocument(opts: { execResult: FakeDoc['execResult']; target?: string }) {
	const state: FakeDoc = { selected: null, execResult: opts.execResult, appended: 0 }
	const target = opts.target !== undefined ? { id: 'out', text: opts.target } : null
	type Range = { node: { text: string } | null; selectNodeContents: (n: { text: string }) => void }
	const selection = {
		removeAllRanges: () => {
			state.selected = null
		},
		addRange: (r: Range) => {
			state.selected = r.node?.text ?? null
		},
	}
	const doc = {
		body: {
			appendChild: () => {
				state.appended++
			},
			removeChild: () => {},
		},
		activeElement: null,
		createElement: () => ({ value: '', style: {}, setAttribute: () => {}, select: () => {} }),
		getElementById: (id: string) => (target && target.id === id ? target : null),
		createRange: (): Range => {
			const r: Range = {
				node: null,
				selectNodeContents: (n) => {
					r.node = n
				},
			}
			return r
		},
		defaultView: { getSelection: () => selection },
		...(opts.execResult === 'missing'
			? {}
			: {
					execCommand: () => {
						if (opts.execResult === 'throw') throw new Error('not allowed')
						return opts.execResult
					},
				}),
	}
	vi.stubGlobal('document', doc)
	return state
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('copyText', () => {
	it('Clipboard API resolves: copied, with exactly the text', async () => {
		const writeText = vi.fn(async () => {})
		vi.stubGlobal('navigator', { clipboard: { writeText } })
		const doc = stubDocument({ execResult: false, target: 'shown' })
		await expect(copyText('the error', { targetId: 'out' })).resolves.toBe('copied')
		expect(writeText).toHaveBeenCalledWith('the error')
		expect(doc.appended).toBe(0)
		expect(doc.selected).toBeNull()
	})

	it('Clipboard API rejects, execCommand copy works: copied', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: async () => Promise.reject(new Error('denied')) },
		})
		const doc = stubDocument({ execResult: true, target: 'shown' })
		await expect(copyText('x', { targetId: 'out' })).resolves.toBe('copied')
		expect(doc.appended).toBe(1)
		expect(doc.selected).toBeNull()
	})

	it('Clipboard API rejects and execCommand copy fails: the shown text is selected', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: async () => Promise.reject(new Error('denied')) },
		})
		const doc = stubDocument({ execResult: false, target: 'shown text' })
		await expect(copyText('x', { targetId: 'out' })).resolves.toBe('selected')
		expect(doc.selected).toBe('shown text')
	})

	it('no Clipboard API at all (plain http): falls back the same way', async () => {
		vi.stubGlobal('navigator', {})
		const doc = stubDocument({ execResult: 'throw', target: 'shown text' })
		await expect(copyText('x', { targetId: 'out' })).resolves.toBe('selected')
		expect(doc.selected).toBe('shown text')
	})

	it('navigator undefined, no execCommand, no target: failed, never "copied"', async () => {
		vi.stubGlobal('navigator', undefined)
		stubDocument({ execResult: 'missing' })
		await expect(copyText('x')).resolves.toBe('failed')
	})

	it('a function source is called once, at copy time', async () => {
		const writeText = vi.fn(async () => {})
		vi.stubGlobal('navigator', { clipboard: { writeText } })
		const source = vi.fn(() => 'big log')
		expect(source).not.toHaveBeenCalled()
		await copyText(source)
		expect(source).toHaveBeenCalledTimes(1)
		expect(writeText).toHaveBeenCalledWith('big log')
	})
})

describe('CopyButton', () => {
	it('rendering does not call a function source', () => {
		const source = vi.fn(() => 'big log')
		const html = renderToStaticMarkup(
			createElement(CopyButton, { value: source, label: 'copy output', text: 'copy' }),
		)
		expect(source).not.toHaveBeenCalled()
		expect(html).toContain('aria-label="copy output"')
		expect(html).toContain('type="button"')
		expect(html).toContain('aria-live="polite"')
		expect(html).toContain('>copy<')
	})

	it('reveal hides it only on wide hover screens, never on touch, and not while the row is hovered or focused', () => {
		const html = renderToStaticMarkup(
			createElement(CopyButton, { value: 'x', label: 'copy id', reveal: true }),
		)
		expect(html).toContain(
			'sm:[@media(hover:hover)]:not-focus-visible:not-group-hover:not-group-focus-within:opacity-0',
		)
		expect(html).not.toMatch(/(?<![:\w-])opacity-0/)
	})
})
