import { ContactEmailLink } from '@/components/contact-email-link'
import { buttonVariants } from '@/components/ui/button-variants'
import { SignInLink } from '@/components/sign-in-link'
import { Logo } from '@/components/ui/logo'
import { publicSignInHref } from '@/lib/hosts'
import { PUBLIC_REPO_URL } from '@/lib/site'
import Link from 'next/link'
import { connection } from 'next/server'

/** One container width for every public header and footer (landing, docs,
 *  login, setup), so the logo sits in the same place on each. */
export const SITE_CHROME_WIDTH = 'max-w-6xl'

const navLink =
	'rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'

export async function SiteHeader({
	maxWidth = SITE_CHROME_WIDTH,
	signIn = true,
}: { maxWidth?: string; signIn?: boolean }) {
	// POWDER_SITE_HOST is a runtime env var: read it per request, not at build.
	// Split = no operator login link on the public site (lib/hosts.ts).
	// signIn={false} (the docs) resolves it in the browser instead
	// (components/sign-in-link.tsx), so those pages stay static.
	if (signIn) await connection()
	const signInHref = signIn ? publicSignInHref() : null
	return (
		<header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
			<div
				className={`mx-auto flex h-14 w-full ${maxWidth} items-center justify-between gap-3 px-4 sm:px-6`}
			>
				<Link href="/" aria-label="powder home" className="rounded-md">
					<Logo variant="glow" />
				</Link>
				<nav aria-label="site" className="flex items-center gap-1 sm:gap-2">
					<Link href="/docs" className={navLink}>
						Docs
					</Link>
					<a href={PUBLIC_REPO_URL} className={navLink}>
						GitHub
					</a>
					{!signIn ? (
						<SignInLink />
					) : (
						signInHref && (
							<Link
								href={signInHref}
								className={buttonVariants({ variant: 'outline', size: 'sm', className: 'ml-1' })}
							>
								Sign in
							</Link>
						)
					)}
				</nav>
			</div>
		</header>
	)
}

export function SiteFooter() {
	return (
		<footer className="border-t border-border/60 px-4 py-8 text-xs text-muted-foreground sm:px-6">
			<div
				className={`mx-auto flex ${SITE_CHROME_WIDTH} flex-col items-center justify-between gap-3 sm:flex-row`}
			>
				<span className="font-bold tracking-[-0.04em] text-foreground">powder</span>
				<div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
					<Link href="/docs" className="hover:text-foreground">
						Docs
					</Link>
					<a href={PUBLIC_REPO_URL} className="hover:text-foreground">
						GitHub
					</a>
					<ContactEmailLink />
				</div>
			</div>
		</footer>
	)
}
