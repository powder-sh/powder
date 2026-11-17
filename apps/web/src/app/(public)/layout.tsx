import { SiteFooter, SiteHeader } from '@/components/site-chrome'
import { WIRE_VIEWPORT } from '@/lib/site'

export const viewport = WIRE_VIEWPORT

// Public pages (the docs): no auth, same header and footer as the landing page.
// The sign-in link depends on runtime env, so the browser resolves it after load
// (signIn={false}). That keeps /docs and /docs/[slug] static: rendered once at
// build, not per request.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
	return (
		<div className="theme-wire flex min-h-screen flex-col overflow-x-clip">
			<SiteHeader signIn={false} />
			<main className="flex-1 px-4 sm:px-6">{children}</main>
			<SiteFooter />
		</div>
	)
}
