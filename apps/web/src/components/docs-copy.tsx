'use client'

// Copy buttons on docs code blocks. lib/docs.ts renders the buttons into the
// static HTML; this one listener copies the block next to the clicked button.

import { useEffect } from 'react'

export function DocsCopy() {
	useEffect(() => {
		const onClick = (e: MouseEvent) => {
			const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-copy]')
			const code = btn?.parentElement?.querySelector('pre')
			if (!btn || !code) return
			navigator.clipboard
				.writeText(code.innerText.replace(/\n$/, ''))
				.then(() => {
					btn.textContent = 'copied'
					btn.dataset.copied = ''
					setTimeout(() => {
						btn.textContent = 'copy'
						delete btn.dataset.copied
					}, 1500)
				})
				.catch(() => {})
		}
		document.addEventListener('click', onClick)
		return () => document.removeEventListener('click', onClick)
	}, [])
	return null
}
