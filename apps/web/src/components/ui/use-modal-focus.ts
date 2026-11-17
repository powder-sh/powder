'use client'

// Keyboard focus for every modal (confirm dialogs, the command palette). While the
// modal is open:
//   - on open, the element that had focus is remembered and focus moves into the
//     panel: to its [data-autofocus] element (a typed confirmation input), else to
//     its [data-modal-cancel] control (the safe choice in a destructive dialog), else
//     to its first focusable element;
//   - Tab and Shift+Tab cycle inside the panel and never reach the page behind it;
//   - on close, focus goes back to the remembered element if it is still in the page.

import { type RefObject, useEffect } from 'react'

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Where Tab (or Shift+Tab with `back`) moves focus inside a panel whose focusable
 *  elements are `items` in order, `active` having focus now. null: leave it to the
 *  browser (the next element is still inside). Pure, so the cycle is tested without
 *  a DOM. */
export function trapTarget<T>(items: readonly T[], active: T | null, back: boolean): T | null {
	if (items.length === 0) return null
	const first = items[0] as T
	const last = items[items.length - 1] as T
	const i = active === null ? -1 : items.indexOf(active)
	if (i === -1) return back ? last : first
	if (back && i === 0) return last
	if (!back && i === items.length - 1) return first
	return null
}

function focusables(panel: HTMLElement): HTMLElement[] {
	return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
	)
}

export function useModalFocus(open: boolean, panelRef: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		if (!open) return
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
		const panel = panelRef.current
		if (panel) {
			const initial =
				panel.querySelector<HTMLElement>('[data-autofocus]') ??
				panel.querySelector<HTMLElement>('[data-modal-cancel]') ??
				focusables(panel)[0] ??
				null
			initial?.focus()
		}
		function onKey(e: KeyboardEvent) {
			if (e.key !== 'Tab') return
			const p = panelRef.current
			if (!p) return
			const items = focusables(p)
			const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
			const target = trapTarget(items, active && p.contains(active) ? active : null, e.shiftKey)
			if (items.length === 0) {
				e.preventDefault()
				return
			}
			if (target) {
				e.preventDefault()
				target.focus()
			}
		}
		document.addEventListener('keydown', onKey, true)
		return () => {
			document.removeEventListener('keydown', onKey, true)
			if (previous?.isConnected) previous.focus()
		}
	}, [open, panelRef])
}
