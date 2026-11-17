import { SITE_CHROME_WIDTH } from '@/components/site-chrome'
import { Logo } from '@/components/ui/logo'
import { WIRE_VIEWPORT } from '@/lib/site'
import Link from 'next/link'

export const viewport = WIRE_VIEWPORT

export default function AuthLayout({ children }: { children: React.ReactNode }) {
	return (
		<div className="theme-wire flex min-h-dvh flex-col">
			{/* Same container, height and logo position as the landing header (SiteHeader). */}
			<header className="border-b border-border/60">
				<div
					className={`mx-auto flex h-14 w-full ${SITE_CHROME_WIDTH} items-center justify-between gap-3 px-4 sm:px-6`}
				>
					<Link href="/" aria-label="powder home" className="rounded-md">
						<Logo variant="glow" />
					</Link>
					<Link
						href="/docs/self-hosting"
						className="rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						Docs
					</Link>
				</div>
			</header>
			<main className="flex flex-1 items-start justify-center px-4 pb-16 pt-[12vh] sm:items-center sm:pt-0">
				<div className="w-full max-w-sm">{children}</div>
			</main>
		</div>
	)
}
