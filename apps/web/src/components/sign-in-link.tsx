'use client'

// "Sign in" for static pages (the docs): resolved after load from
// /api/sign-in-link, so the page itself needs no runtime env. Remembered for the
// tab's session, so moving between docs pages does not ask again.

import { buttonVariants } from '@/components/ui/button-variants'
import Link from 'next/link'
import { useEffect, useState } from 'react'

const KEY = 'powder:sign-in-href'

export function SignInLink() {
	const [href, setHref] = useState<string | null>(null)
	useEffect(() => {
		let cached: string | null = null
		try {
			cached = sessionStorage.getItem(KEY)
		} catch {
			// storage blocked: ask every time
		}
		if (cached !== null) {
			setHref(cached || null)
			return
		}
		let live = true
		fetch('/api/sign-in-link')
			.then((r) => (r.ok ? (r.json() as Promise<{ href: string | null }>) : { href: null }))
			.then(({ href: h }) => {
				const safe = typeof h === 'string' && h.startsWith('/') && !h.startsWith('//') ? h : null
				try {
					sessionStorage.setItem(KEY, safe ?? '')
				} catch {}
				if (live) setHref(safe)
			})
			.catch(() => {})
		return () => {
			live = false
		}
	}, [])
	if (!href) return null
	return (
		<Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm', className: 'ml-1' })}>
			Sign in
		</Link>
	)
}
