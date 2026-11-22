'use client'

// Project shell: breadcrumb + header + tabs. Renders the active tab's content
// in the outlet. All tab routes (page, deployments, backups, settings) read
// project + deploys + crons from the ProjectProvider so we fetch once.

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { BackLink } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusLabel } from '@/components/ui/status'
import { useHint } from '@/components/ui/tooltip'
import { APP_HEALTH } from '@/lib/app-health'
import { redeployHint } from '@/lib/apps-table'
import { cn } from '@/lib/cn'
import {
	Activity,
	Clock,
	ScrollText,
	Box,
	Database,
	ExternalLink,
	GitBranch,
	Globe,
	HardDrive,
	History,
	KeyRound,
	Layout,
	RefreshCw,
	Server,
	Settings,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { use, useEffect, useRef, useState } from 'react'
import {
	ProjectProvider,
	computeProjectStatus,
	repoHttpsUrl,
	repoSlug,
	useProject,
} from './_lib/project-context'

export default function ProjectLayout({
	children,
	params,
}: {
	children: React.ReactNode
	params: Promise<{ id: string }>
}) {
	const { id } = use(params)
	return (
		<ProjectProvider id={id}>
			<Shell>{children}</Shell>
		</ProjectProvider>
	)
}

function Shell({ children }: { children: React.ReactNode }) {
	const { id, project, deploys, uptime, loading, reload } = useProject()
	const pathname = usePathname()
	const [redeploying, setRedeploying] = useState(false)
	const [redeployError, setRedeployError] = useState<string | null>(null)
	const hashHandled = useRef(false)
	const tabsRef = useRef<HTMLElement>(null)

	// Phones: keep the active tab in view inside the scrolling tab row (never the page).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the tab changes
	useEffect(() => {
		const nav = tabsRef.current
		const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
		if (!nav || !active) return
		nav.scrollLeft =
			active.getBoundingClientRect().left -
			nav.getBoundingClientRect().left +
			nav.scrollLeft -
			(nav.clientWidth - active.offsetWidth) / 2
	}, [pathname, !!project])

	type Tab = {
		href: string
		label: string
		icon: React.ComponentType<{ className?: string }>
		exact?: boolean
	}
	const tabs: Tab[] = [
		{ href: `/projects/${id}`, label: 'overview', icon: Layout, exact: true },
		{ href: `/projects/${id}/deployments`, label: 'deployments', icon: History },
		{ href: `/projects/${id}/logs`, label: 'logs', icon: ScrollText },
		{ href: `/projects/${id}/env`, label: 'env', icon: KeyRound },
		{ href: `/projects/${id}/domains`, label: 'domains', icon: Globe },
		{ href: `/projects/${id}/crons`, label: 'crons', icon: Clock },
		{ href: `/projects/${id}/backups`, label: 'backups', icon: HardDrive },
		{ href: `/projects/${id}/ci`, label: 'ci', icon: Activity },
		{ href: `/projects/${id}/settings`, label: 'settings', icon: Settings },
	]

	const activeDeploy = deploys.find((d) => d.status === 'running' || d.status === 'queued')
	// A push held on the settle window (lib/deploy-settle.ts): redeploy stays available and
	// releases it at once.
	const heldDeploy = activeDeploy?.status === 'queued' && activeDeploy.waiting ? activeDeploy : null
	const status = project ? computeProjectStatus(deploys, uptime, project.container) : 'not_deployed'
	const redeployTip = useHint(redeployHint(project?.branch, status === 'not_deployed'))

	const redeploy = async () => {
		setRedeploying(true)
		setRedeployError(null)
		try {
			const res = await fetch(`/api/projects/${id}/redeploy`, { method: 'POST' })
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string }
				setRedeployError(`redeploy failed: ${err.error ?? res.status}`)
			} else {
				setTimeout(reload, 500)
			}
		} catch (e) {
			setRedeployError(`redeploy failed: ${e instanceof Error ? e.message : 'network error'}`)
		} finally {
			setRedeploying(false)
		}
	}

	// Command palette links to /projects/<id>#redeploy: trigger once, clear the hash.
	const hasProject = !!project
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once when project first loads
	useEffect(() => {
		if (!hasProject || hashHandled.current) return
		if (window.location.hash === '#redeploy') {
			hashHandled.current = true
			history.replaceState(null, '', window.location.pathname + window.location.search)
			void redeploy()
		}
	}, [hasProject])

	if (loading && !project) {
		return (
			<div className="space-y-6" aria-busy="true">
				<Skeleton className="h-3 w-16" />
				<div className="space-y-3">
					<Skeleton className="h-7 w-48" />
					<Skeleton className="h-4 w-72" />
				</div>
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-32 w-full" />
				<span className="sr-only">loading app</span>
			</div>
		)
	}
	if (!project) {
		return (
			<div className="space-y-6">
				<BackLink href="/projects">apps</BackLink>
				<EmptyState icon={Box} title="app not found">
					it may have been removed, or the link is wrong.{' '}
					<Link href="/projects" className="text-foreground underline underline-offset-2">
						back to apps
					</Link>
				</EmptyState>
			</div>
		)
	}

	const slug = repoSlug(project.repoUrl)
	const health = APP_HEALTH[status]
	const statusLabel =
		status === 'down' && uptime?.lastStatusCode
			? `${health.label} · HTTP ${uptime.lastStatusCode}`
			: health.label

	const activeTab = tabs.find((t) =>
		t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`),
	)

	return (
		<div className="space-y-6">
			<title>{`${project.containerName} · ${activeTab?.label ?? 'project'} · powder`}</title>
			{/* Header */}
			<header className="space-y-3">
				<BackLink href="/projects">apps</BackLink>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0 space-y-2">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
							<h1 className="truncate text-2xl font-semibold tracking-tight">
								{project.containerName}
							</h1>
							<span className="inline-flex h-6 items-center rounded-full border border-border bg-card px-2.5">
								<StatusLabel tone={health.tone} pulse={health.pulse} className="text-xs">
									{statusLabel}
								</StatusLabel>
							</span>
							{project.hasPostgres && (
								<Badge variant="outline">
									<Database />
									postgres
								</Badge>
							)}
							{project.hasKv && <Badge variant="outline">kv</Badge>}
						</div>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
							<a
								href={repoHttpsUrl(project.repoUrl)}
								target="_blank"
								rel="noreferrer"
								className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground"
							>
								<GitBranch className="h-3.5 w-3.5 shrink-0" />
								<span className="truncate">{slug}</span>
								<span className="font-mono text-xs text-muted-foreground">{project.branch}</span>
								<ExternalLink className="h-3 w-3 shrink-0" />
							</a>
							<span className="text-border-strong" aria-hidden="true">
								/
							</span>
							<Link
								href={
									project.serverId && project.containerName
										? `/servers/${project.serverId}/${project.containerName}`
										: '/servers'
								}
								className="inline-flex min-h-10 items-center gap-1.5 hover:text-foreground sm:min-h-0"
							>
								<Server className="h-3.5 w-3.5" />
								{project.serverName}
							</Link>
						</div>
					</div>
					<Button
						variant="outline"
						onClick={redeploy}
						disabled={!!activeDeploy && !heldDeploy}
						loading={redeploying}
						className="self-start"
						{...redeployTip.props}
					>
						{!redeploying && (
							<RefreshCw className={cn('h-3.5 w-3.5', activeDeploy && !heldDeploy && 'animate-spin')} />
						)}
						{redeploying
							? 'starting…'
							: heldDeploy
								? 'redeploy now'
								: activeDeploy
									? activeDeploy.status === 'queued'
										? 'queued…'
										: 'deploying…'
									: 'redeploy'}
					</Button>
					{redeployTip.tooltip}
				</div>
				{heldDeploy?.waiting && <p className="text-xs text-muted-foreground">{heldDeploy.waiting}</p>}
				{redeployError && (
					<Alert tone="destructive" title="redeploy did not start">
						{redeployError}
					</Alert>
				)}
			</header>

			{/* Tabs */}
			<nav
				ref={tabsRef}
				aria-label="app sections"
				className="relative -mx-4 flex gap-0.5 overflow-x-auto border-b border-border px-4 [mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)] [scrollbar-width:none] sm:mx-0 sm:px-0 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden"
			>
				{tabs.map((tab) => {
					const isActive = tab.exact
						? pathname === tab.href
						: pathname === tab.href || pathname.startsWith(`${tab.href}/`)
					return (
						<Link
							key={tab.href}
							href={tab.href}
							aria-current={isActive ? 'page' : undefined}
							className={cn(
								'-mb-px inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm transition-colors',
								isActive
									? 'border-foreground font-medium text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground',
							)}
						>
							<tab.icon className="h-3.5 w-3.5" />
							{tab.label}
						</Link>
					)
				})}
			</nav>

			<div className="pt-2">{children}</div>
		</div>
	)
}
