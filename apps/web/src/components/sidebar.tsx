'use client'

import { OPEN_PALETTE_EVENT } from '@/components/command-palette'
import { Kbd } from '@/components/ui/kbd'
import { Logo } from '@/components/ui/logo'
import { signOut } from '@/lib/auth-client'
import { cn } from '@/lib/cn'
import { PUBLIC_REPO_URL } from '@/lib/site'
import {
	Activity,
	BookOpen,
	Box,
	LogOut,
	Menu,
	Plus,
	Rocket,
	Search,
	Server,
	Settings,
	X,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

// Sidebar: five entries; the footer links the docs and the changelog. Apps is the dashboard home (one table of
// apps). Pages that lost their entry (env vars, logs, domains, databases, crons,
// integrations, admin users) stay reachable by URL; Settings links to
// the account-level ones. `match` lists extra path prefixes that keep an entry
// highlighted.
interface NavItem {
	name: string
	href: string
	icon: React.ComponentType<{ className?: string }>
	match: readonly string[]
}

const nav: readonly NavItem[] = [
	{ name: 'apps', href: '/projects', icon: Box, match: ['/projects', '/new'] },
	{ name: 'deploys', href: '/deploys', icon: Rocket, match: ['/deploys'] },
	{ name: 'servers', href: '/servers', icon: Server, match: ['/servers'] },
	{ name: 'activity', href: '/activity', icon: Activity, match: ['/activity'] },
	{
		name: 'settings',
		href: '/settings',
		icon: Settings,
		match: ['/settings', '/integrations', '/admin'],
	},
]

function NavSection({ items, pathname }: { items: readonly NavItem[]; pathname: string }) {
	return (
		<ul className="space-y-0.5">
			{items.map((item) => {
				const isActive = item.match.some((m) => pathname === m || pathname.startsWith(`${m}/`))
				return (
					<li key={item.name}>
						<Link
							href={item.href}
							aria-current={isActive ? 'page' : undefined}
							className={cn(
								'group flex h-10 items-center gap-2.5 rounded-md px-2.5 md:h-9 text-sm font-medium transition-colors',
								isActive
									? 'bg-accent text-foreground'
									: 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
							)}
						>
							<item.icon
								className={cn(
									'h-4 w-4 transition-colors',
									isActive
										? 'text-foreground'
										: 'text-muted-foreground group-hover:text-foreground',
								)}
							/>
							{item.name}
						</Link>
					</li>
				)
			})}
		</ul>
	)
}

function openPalette() {
	window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))
}

interface SidebarProps {
	user: { name: string; email: string }
}

export function Sidebar({ user }: SidebarProps) {
	const router = useRouter()
	const pathname = usePathname()
	const [drawerOpen, setDrawerOpen] = useState(false)
	const [mac, setMac] = useState(true)

	useEffect(() => {
		setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))
	}, [])

	// Close the mobile drawer on route change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
	useEffect(() => {
		setDrawerOpen(false)
	}, [pathname])

	// Esc closes the drawer.
	useEffect(() => {
		if (!drawerOpen) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setDrawerOpen(false)
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [drawerOpen])

	async function handleSignOut() {
		await signOut()
		router.replace('/login')
		router.refresh()
	}

	const initial = (user.name || user.email).trim().charAt(0).toUpperCase() || '?'

	return (
		<>
			{/* Phone top bar */}
			<div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur md:hidden">
				<Link href="/projects" aria-label="powder: apps">
					<Logo size={22} />
				</Link>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={openPalette}
						aria-label="search"
						className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<Search className="h-4.5 w-4.5" />
					</button>
					<button
						type="button"
						onClick={() => setDrawerOpen((v) => !v)}
						aria-label={drawerOpen ? 'close menu' : 'open menu'}
						aria-expanded={drawerOpen}
						aria-controls="dashboard-sidebar"
						className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						{drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
					</button>
				</div>
			</div>
			{drawerOpen && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop; Esc is handled on document
				<div
					className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden"
					onClick={() => setDrawerOpen(false)}
				/>
			)}
			<aside
				id="dashboard-sidebar"
				className={cn(
					'z-50 flex h-full w-60 shrink-0 flex-col border-r border-border bg-background',
					'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-popover max-md:transition-transform max-md:duration-200',
					drawerOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
				)}
			>
				<div className="flex h-14 items-center px-4">
					<Link href="/projects" aria-label="powder: apps" className="rounded-md">
						<Logo size={22} />
					</Link>
				</div>

				<div className="space-y-2 px-3 pb-2">
					<button
						type="button"
						onClick={openPalette}
						className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
					>
						<Search className="h-4 w-4" />
						<span className="flex-1 text-left">jump to…</span>
						<span className="hidden items-center gap-0.5 md:flex">
							<Kbd>{mac ? '⌘' : 'ctrl'}</Kbd>
							<Kbd>K</Kbd>
						</span>
					</button>
				</div>

				<nav aria-label="main" className="flex-1 overflow-y-auto px-3 py-2">
					<NavSection items={nav} pathname={pathname} />
					<div className="mt-4 border-t border-border pt-4">
						<Link
							href="/new"
							className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
						>
							<Plus className="h-4 w-4" />
							new app
						</Link>
					</div>
				</nav>

				<div className="border-t border-border p-3">
					<div className="flex items-center gap-2.5 rounded-md px-1.5 py-1">
						<span
							aria-hidden="true"
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-strong bg-muted text-xs font-semibold"
						>
							{initial}
						</span>
						<div className="min-w-0 flex-1 text-xs">
							<div className="truncate font-medium">{user.name || user.email}</div>
							{user.name && <div className="truncate text-muted-foreground">{user.email}</div>}
						</div>
						<button
							type="button"
							onClick={handleSignOut}
							aria-label="sign out"
							title="sign out"
							className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:h-8 md:w-8"
						>
							<LogOut className="h-4 w-4" />
						</button>
					</div>
					<div className="flex items-center gap-1 pt-1.5 text-2xs text-muted-foreground">
						<Link
							href="/docs"
							className="inline-flex h-10 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-accent/60 hover:text-foreground md:h-7"
						>
							<BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
							docs
						</Link>
						<span aria-hidden="true" className="text-border-strong">
							·
						</span>
						<a
							href={`${PUBLIC_REPO_URL}/blob/main/CHANGELOG.md`}
							target="_blank"
							rel="noreferrer"
							title="changelog on GitHub"
							className="inline-flex h-10 items-center rounded-md px-1.5 font-mono transition-colors hover:bg-accent/60 hover:text-foreground md:h-7"
						>
							powder v{process.env.NEXT_PUBLIC_POWDER_VERSION}
						</a>
					</div>
				</div>
			</aside>
		</>
	)
}
