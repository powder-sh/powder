import { PostHogProvider } from '@/components/posthog-provider'
import { siteUrl } from '@/lib/hosts'
import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'

const geistSans = localFont({
	src: './fonts/Geist-Variable.woff2',
	variable: '--font-geist-sans',
	weight: '100 900',
	display: 'swap',
})

const geistMono = localFont({
	src: './fonts/GeistMono-Variable.woff2',
	variable: '--font-geist-mono',
	weight: '100 900',
	display: 'swap',
})

const DESCRIPTION =
	'Open-source deploy platform you install on your own servers: git push, it builds on your server, health-checks the result and swaps it in.'

// No connection() here: that would make every route dynamic, the static docs
// too. Next runs this per request for dynamic routes (home, login, dashboard),
// so they get the install's own host from runtime env, and once at build for
// static ones (docs, 404), which get the build-time value: the project's
// SITE_URL unless BETTER_AUTH_URL or POWDER_SITE_HOST is set for the build.
export async function generateMetadata(): Promise<Metadata> {
	return {
		...METADATA,
		// Absolute URLs for og:image, twitter:image and canonical links.
		metadataBase: new URL(siteUrl()),
	}
}

const METADATA: Metadata = {
	title: 'powder: push to deploy on servers you own',
	description: DESCRIPTION,
	applicationName: 'powder',
	openGraph: {
		type: 'website',
		siteName: 'powder',
		title: 'powder: push to deploy on servers you own',
		description: DESCRIPTION,
		url: '/',
	},
	twitter: {
		card: 'summary_large_image',
		title: 'powder: push to deploy on servers you own',
		description: DESCRIPTION,
	},
}

// Dashboard chrome follows the OS theme. The public site, docs and login are
// dark only and override this with WIRE_VIEWPORT (lib/site.ts).
export const viewport: Viewport = {
	themeColor: [
		{ media: '(prefers-color-scheme: light)', color: '#fafafa' },
		{ media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
	],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
			<body className="min-h-full bg-background text-foreground font-sans selection:bg-powder selection:text-background">
				<PostHogProvider>{children}</PostHogProvider>
			</body>
		</html>
	)
}
