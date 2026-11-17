import { Suspense } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { CommandPalette } from '@/components/command-palette'
import { Sidebar } from '@/components/sidebar'
import { UpdateBanner } from '@/components/update-banner'
import { Logo } from '@/components/ui/logo'
import { ToastProvider } from '@/components/ui/toast'
import { singleTenantBlocks } from '@/lib/access'
import { adminIdsConfigured } from '@/lib/admin-ids'
import { auth } from '@/lib/auth'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
	const session = await auth.api.getSession({ headers: await headers() })
	if (!session) redirect('/login')
	if (singleTenantBlocks(session.user.id)) {
		return (
			<main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
				<Logo size={28} />
				<div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-card">
					<h1 className="text-base font-semibold">This powder is single-tenant</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						Your account ({session.user.email}) does not have access to this instance.
					</p>
					{!adminIdsConfigured() && (
						<p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-left text-xs text-muted-foreground">
							No admin is configured. In the powder source dir run{' '}
							<code className="break-all font-mono text-foreground">
								sudo bin/install.sh --set-admin {session.user.id}
							</code>{' '}
							(it writes POWDER_ADMIN_USER_IDS and recreates powder and the worker; a plain restart does not
							re-read the env file).
						</p>
					)}
				</div>
			</main>
		)
	}

	return (
		<ToastProvider>
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
			>
				skip to content
			</a>
			<div className="flex h-dvh">
				<Sidebar user={{ name: session.user.name, email: session.user.email }} />
				<main id="main" className="min-w-0 flex-1 overflow-y-auto pt-14 md:pt-0">
					{/* Streamed in after the page: the (cached) update check must never block render. */}
					<Suspense fallback={null}>
						<UpdateBanner />
					</Suspense>
					<div className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6 md:pt-10 lg:px-10">
						{children}
					</div>
				</main>
			</div>
			{/* Global cmd+k. Renders nothing until invoked via keyboard. */}
			<CommandPalette />
		</ToastProvider>
	)
}
