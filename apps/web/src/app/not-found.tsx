import { SiteFooter, SiteHeader } from '@/components/site-chrome'
import { buttonVariants } from '@/components/ui/button-variants'
import Link from 'next/link'

export const metadata = { title: 'not found · powder' }

// Global 404: unknown URLs land here, mostly from outside links, so it wears the
// public site's look. A notFound() inside the dashboard has its own page.
export default function NotFound() {
	return (
		<div className="theme-wire flex min-h-dvh flex-col overflow-x-clip">
			<SiteHeader signIn={false} />
			<main className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
				<p className="font-mono text-sm text-signal">404</p>
				<h1 className="font-display mt-3 text-[clamp(2rem,8vw,3.25rem)] font-bold leading-[1.05] tracking-[-0.03em]">
					Nothing lives here.
				</h1>
				<p className="mt-3 max-w-md text-pretty text-muted-foreground">
					The link may be old, or the page moved.
				</p>
				<div className="mt-8 flex flex-col gap-3 sm:flex-row">
					<Link
						href="/"
						className={buttonVariants({
							size: 'lg',
							className: 'wire-cta rounded-[10px] text-[0.9375rem] font-semibold',
						})}
					>
						Go home
					</Link>
					<Link
						href="/docs"
						className={buttonVariants({
							variant: 'outline',
							size: 'lg',
							className:
								'rounded-[10px] bg-transparent text-[0.9375rem] font-semibold hover:border-muted-foreground hover:bg-transparent',
						})}
					>
						Read the docs
					</Link>
				</div>
			</main>
			<SiteFooter />
		</div>
	)
}
