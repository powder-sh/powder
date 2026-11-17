import { CompareTable } from '@/components/compare-table'
import { DashboardDemo } from '@/components/dashboard-demo'
import { DeployReplay } from '@/components/deploy-replay'
import { InstallCommand } from '@/components/install-command'
import { LandingPrompts } from '@/components/landing-prompts'
import { SiteFooter, SiteHeader } from '@/components/site-chrome'
import { buttonVariants } from '@/components/ui/button-variants'
import { getCurrentUser, singleTenantBlocks } from '@/lib/access'
import { isHostSplit, isSiteHostRequest } from '@/lib/hosts'
import { PUBLIC_REPO_URL, WIRE_VIEWPORT } from '@/lib/site'
import {
	Clock,
	DatabaseBackup,
	Hammer,
	HeartPulse,
	KeyRound,
	type LucideIcon,
	Undo2,
} from 'lucide-react'
import { headers } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'

const QUICKSTART_URL = '/docs/quickstart'

// Dark only, like the rest of the public site (globals.css .theme-wire).
export const viewport = WIRE_VIEWPORT

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
	{
		icon: Hammer,
		title: 'Builds on your server',
		body: 'No CI service or registry required.',
	},
	{
		icon: HeartPulse,
		title: 'Health-checked swaps',
		body: 'A bad build leaves the old version running.',
	},
	{
		icon: Undo2,
		title: 'One-click rollback',
		body: 'The previous image stays on the server.',
	},
	{
		icon: KeyRound,
		title: 'Encrypted env vars',
		body: 'Audit trail and rollback of every change.',
	},
	{
		icon: DatabaseBackup,
		title: 'Postgres backups to S3',
		body: 'Per app, encrypted, to any S3-compatible store, with retention.',
	},
	{
		icon: Clock,
		title: 'Crons, uptime and logs',
		body: 'For all your servers in one dashboard.',
	},
]

const STEPS: { title: string; body: string }[] = [
	{
		title: 'Install on one server',
		body: 'bin/install.sh asks for your domain and GitHub app, then starts powder with Docker Compose.',
	},
	{
		title: 'Add servers over SSH',
		body: 'Paste one command on each server to authorize powder. The server check installs what is missing.',
	},
	{
		title: 'Push to main',
		body: 'Import a repo once. Every push builds, health-checks and swaps in the new version.',
	},
]

export default async function Home() {
	// Split (lib/hosts.ts): the site host always shows the landing page and never
	// touches the session; the dashboard host has no landing page.
	const onSite = isSiteHostRequest(await headers())
	if (!onSite) {
		// Signed-in admins skip the landing page and go straight to their projects.
		const u = await getCurrentUser()
		if (u && !singleTenantBlocks(u.id)) redirect('/projects')
		if (isHostSplit()) redirect('/login')
	}
	return (
		<div className="theme-wire flex min-h-screen flex-col overflow-x-clip">
			<SiteHeader />

			<main className="flex-1 px-4 sm:px-6">
				<section className="mx-auto max-w-5xl pt-14 text-center sm:pt-24">
					<a
						href={PUBLIC_REPO_URL}
						className="inline-flex items-center gap-2 rounded-full border border-border-strong px-3 py-1.5 font-mono text-xs font-medium text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
					>
						<span className="wire-dot h-1.5 w-1.5 rounded-full" aria-hidden="true" />
						Open source, AGPL-3.0-or-later · Beta
					</a>
					<h1 className="mx-auto mt-6 max-w-[12ch] text-balance text-[clamp(2.75rem,11.5vw,6.4rem)] font-extrabold leading-[0.95] tracking-[-0.055em]">
						Push to deploy on servers <span className="wire-glow whitespace-nowrap">you own.</span>
					</h1>
					<p className="mx-auto mt-6 max-w-xl text-pretty text-[1.0625rem] leading-relaxed text-muted-foreground sm:text-lg">
						An open-source deploy platform. Push to GitHub and powder builds on your server,
						health-checks the new version and swaps it in.
					</p>
					<InstallCommand className="mx-auto mt-8 max-w-3xl" />
					<div className="mt-4 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
						<Link
							href={QUICKSTART_URL}
							className={buttonVariants({
								variant: 'outline',
								size: 'lg',
								className:
									'rounded-[10px] bg-transparent text-[0.9375rem] font-semibold hover:border-muted-foreground hover:bg-transparent',
							})}
						>
							Read the quickstart
						</Link>
						<a
							href={PUBLIC_REPO_URL}
							className={buttonVariants({
								variant: 'ghost',
								size: 'lg',
								className: 'rounded-[10px] text-[0.9375rem] font-semibold',
							})}
						>
							View on GitHub
						</a>
					</div>
					<div className="wire mt-6" aria-hidden="true" />
				</section>

				<section className="mx-auto max-w-2xl" aria-label="A deploy, replayed">
					<DeployReplay />
				</section>

				<section className="mx-auto max-w-5xl pt-20 sm:pt-28" aria-labelledby="dashboard">
					<h2
						id="dashboard"
						className="font-display text-center text-[clamp(1.9rem,7vw,2.8rem)] font-bold leading-[1.05]"
					>
						The dashboard
					</h2>
					<DashboardDemo />
				</section>

				<section className="mx-auto max-w-5xl pt-20 sm:pt-28" aria-labelledby="features">
					<h2 id="features" className="sr-only">
						Features
					</h2>
					<div className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
						{FEATURES.map((f) => (
							<div key={f.title} className="bg-background px-5 py-6 sm:px-6 sm:py-7">
								<f.icon
									className="h-[22px] w-[22px] text-signal"
									strokeWidth={2}
									aria-hidden="true"
								/>
								<h3 className="mt-4 text-[1.0625rem] font-semibold tracking-[-0.01em]">
									{f.title}
								</h3>
								<p className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted-foreground">
									{f.body}
								</p>
							</div>
						))}
					</div>
				</section>

				<section className="mx-auto max-w-5xl pt-20 sm:pt-28" aria-labelledby="how">
					<h2
						id="how"
						className="font-display text-center text-[clamp(1.9rem,7vw,2.8rem)] font-bold leading-[1.05]"
					>
						How it works
					</h2>
					<ol className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
						{STEPS.map((s, i) => (
							<li key={s.title} className="rounded-[14px] border border-border bg-card p-5 sm:p-6">
								<span className="flex h-8 w-8 items-center justify-center rounded-full border border-signal/60 font-mono text-sm font-semibold text-signal shadow-[0_0_14px_-2px_rgb(62_230_255/0.45)]">
									{i + 1}
								</span>
								<h3 className="mt-4 text-[0.9375rem] font-semibold tracking-tight">{s.title}</h3>
								<p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
							</li>
						))}
					</ol>
					<p className="mt-6 text-center text-sm text-muted-foreground">
						What you need: a Linux server with root, a GitHub repo and a domain.
					</p>
				</section>

				<section className="mx-auto max-w-5xl pt-20 sm:pt-28" aria-labelledby="compare">
					<h2
						id="compare"
						className="font-display text-center text-[clamp(1.9rem,7vw,2.8rem)] font-bold leading-[1.05]"
					>
						How it compares
					</h2>
					<div className="mt-8">
						<CompareTable />
					</div>
				</section>

				<LandingPrompts />

				<section className="mx-auto max-w-5xl pb-20 pt-20 sm:pb-28 sm:pt-28">
					<div className="wire-panel relative overflow-hidden rounded-[14px] border border-border-strong bg-card p-6 sm:p-10">
						<div className="relative space-y-6">
							<div>
								<h2 className="font-display text-[1.75rem] font-bold leading-tight sm:text-4xl">
									Install powder
								</h2>
								<Link
									href={QUICKSTART_URL}
									className="mt-2 inline-block text-sm text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground"
								>
									Read the quickstart
								</Link>
							</div>
							<InstallCommand />
						</div>
					</div>
				</section>
			</main>

			<SiteFooter />
		</div>
	)
}
