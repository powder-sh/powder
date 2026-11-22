// The one copy path for the dashboard (components/ui/copy-button.tsx renders it).
// Order: the Clipboard API; when it is missing or refused (plain http, an old
// browser, a denied permission), the execCommand copy through a hidden
// textarea; when that fails too, select the target element on the page so
// Ctrl/Cmd+C works, and report it. Never a silent no-op: the caller always gets
// an outcome to show.
//
// `source` may be a function so a large log is only turned into a string when
// someone clicks, not on every render.

export type CopySource = string | (() => string)

export type CopyOutcome = 'copied' | 'selected' | 'failed'

export function resolveCopySource(source: CopySource): string {
	return typeof source === 'function' ? source() : source
}

function execCommandCopy(doc: Document, text: string): boolean {
	if (typeof doc.execCommand !== 'function' || !doc.body) return false
	const ta = doc.createElement('textarea')
	ta.value = text
	ta.setAttribute('readonly', '')
	ta.style.position = 'fixed'
	ta.style.top = '0'
	ta.style.left = '0'
	ta.style.opacity = '0'
	// select() moves focus into the textarea: give it back so a keyboard user
	// stays on the button.
	const focused = doc.activeElement as HTMLElement | null
	doc.body.appendChild(ta)
	try {
		ta.select()
		return doc.execCommand('copy')
	} catch {
		return false
	} finally {
		doc.body.removeChild(ta)
		focused?.focus?.()
	}
}

function selectTarget(doc: Document, targetId: string | undefined): boolean {
	if (!targetId) return false
	const el = doc.getElementById(targetId)
	const sel = doc.defaultView?.getSelection?.()
	if (!el || !sel) return false
	const range = doc.createRange()
	range.selectNodeContents(el)
	sel.removeAllRanges()
	sel.addRange(range)
	return true
}

export async function copyText(
	source: CopySource,
	opts: { targetId?: string } = {},
): Promise<CopyOutcome> {
	const text = resolveCopySource(source)
	const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
	if (clipboard && typeof clipboard.writeText === 'function') {
		try {
			await clipboard.writeText(text)
			return 'copied'
		} catch {
			// refused: fall through to the fallbacks
		}
	}
	if (typeof document === 'undefined') return 'failed'
	if (execCommandCopy(document, text)) return 'copied'
	if (selectTarget(document, opts.targetId)) return 'selected'
	return 'failed'
}
