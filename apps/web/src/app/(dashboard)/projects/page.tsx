'use client'

// Apps: the dashboard home. One table, one row per app. Status, counters,
// filters and sorting come from lib/apps-table.ts (unit-tested). Deploy and
// Restart call the existing routes, which keep their own auth checks.

import { SetupChecklistCard } from '@/components/setup-checklist-card'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, fieldClasses } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonList } from '@/components/ui/skeleton'
import { StatusDot, StatusLabel } from '@/components/ui/status'
import { TBody, THead, Table, TableFrame, Td, Th, Tr } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/toast'
import { DeployBars, DeployStrip, stripEmpty, stripSummary } from '@/components/deploy-strip'
import {
	type AppRow,
	type StatusFilter,
	countStatuses,
	deployDuration,
	appRowHealth,
	deriveStatus,
	filterApps,
	fleetHeartbeat,
	parseStatusFilter,
	shortSha,
	sortApps,
} from '@/lib/apps-table'
import { APP_HEALTH, APP_STATE, APP_STATES, type AppState } from '@/lib/app-health'
import { cn } from '@/lib/cn'
import { deployStatus } from '@/lib/deploy-status'
import { emptyDays, sumDeployDays } from '@/lib/deploy-days'
import { timeAgoDays } from '@/lib/format'
import { Activity, Box, KeyRound, Plus, RotateCw, Search, Upload } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'

const ROW_DAYS = 14

export default function AppsPage() {
	return (
		<Suspense fallback={<SkeletonList rows={5} label="loading apps" />}>
			<Apps />
		</Suspense>
	)
}

function Apps() {
	const router = useRouter()
	const pathname = usePathname()
	const params = useSearchParams()
	const toast = useToast()
	const [apps, setApps] = useState<AppRow[] | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [restartApp, setRestartApp] = useState<AppRow | null>(null)

	const status = parseStatusFilter(params.get('status'))
	const server = params.get('server') ?? ''
	const q = params.get('q') ?? ''
	// Local text so typing never waits on the URL round trip; re-synced when q
	// changes from outside (clear filters, back/forward).
	const [qText, setQText] = useState(q)
	useEffect(() => setQText(q), [q])

	const load = useCallback(() => {
		fetch('/api/projects')
			.then((r) => r.json())
			.then((d) => setApps(d.projects ?? []))
			.catch(() => setApps((prev) => prev ?? []))
	}, [])

	useEffect(() => {
		load()
	}, [load])

	const anyDeploying = apps?.some((a) => deriveStatus(a) === 'deploying') ?? false
	useEffect(() => {
		if (!anyDeploying) return
		const t = setInterval(load, 10_000)
		return () => clearInterval(t)
	}, [anyDeploying, load])

	const setParam = (key: string, value: string) => {
		const next = new URLSearchParams(params.toString())
		if (value && value !== 'all') next.set(key, value)
		else next.delete(key)
		const qs = next.toString()
		router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
	}
	const hrefFor = (s: StatusFilter) => {
		const next = new URLSearchParams(params.toString())
		if (s === 'all') next.delete('status')
		else next.set('status', s)
		const qs = next.toString()
		return qs ? `${pathname}?${qs}` : pathname
	}

	const counters = useMemo(() => countStatuses(apps ?? []), [apps])
	const servers = useMemo(() => {
		const m = new Map<string, string>()
		for (const a of apps ?? []) m.set(a.serverId, a.serverName)
		return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
	}, [apps])
	const rows = useMemo(
		() => sortApps(filterApps(apps ?? [], { status, server, q })),
		[apps, status, server, q],
	)

	async function act(app: AppRow, kind: 'deploy' | 'restart') {
		setBusy(`${app.id}:${kind}`)
		try {
			const url =
				kind === 'deploy'
					? `/api/projects/${app.id}/redeploy`
					: `/api/servers/${encodeURIComponent(app.serverId)}/containers/${encodeURIComponent(app.containerName)}/restart`
			const res = await fetch(url, { method: 'POST' })
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string }
				toast.error(`${kind} failed: ${err.error ?? res.status}`)
			} else {
				toast.success(
					kind === 'deploy'
						? `deploy started: ${app.containerName}`
						: `restarted ${app.containerName}`,
				)
			}
		} catch (e) {
			toast.error(`${kind} failed: ${e instanceof Error ? e.message : 'network error'}`)
		} finally {
			setBusy(null)
			setRestartApp(null)
			load()
		}
	}

	return (
		<div className="space-y-6">
			<title>apps · powder</title>
			<PageHeader
				title="apps"
				description={
					apps && apps.length > 0
						? `${apps.length} app${apps.length === 1 ? '' : 's'} on ${servers.length} server${servers.length === 1 ? '' : 's'}. failed and down first, then most recently deployed.`
						: 'every app powder deploys, across all your servers.'
				}
				actions={
					<Link href="/new" className={buttonVariants()}>
						<Plus className="h-4 w-4" />
						new app
					</Link>
				}
			/>

			{apps !== null && <SetupChecklistCard quiet={apps.length > 0} />}

			{apps === null ? (
				<SkeletonList rows={5} label="loading apps" />
			) : apps.length === 0 ? (
				<EmptyState
					icon={Box}
					title="no apps yet"
					action={
						<Link href="/new" className={buttonVariants({ variant: 'outline' })}>
							<Plus className="h-4 w-4" />
							new app
						</Link>
					}
				>
					import a GitHub repo and pick a server. powder builds it there on every push.
				</EmptyState>
			) : (
				<>
					<FleetSummary
						apps={apps}
						counters={counters}
						status={status}
						hrefFor={hrefFor}
					/>

					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<div className="flex flex-1 gap-2">
							<Select
								aria-label="filter by server"
								value={server}
								onChange={(e) => setParam('server', e.target.value)}
								className="max-w-[45%] sm:max-w-none"
							>
								<option value="">all servers</option>
								{servers.map(([id, name]) => (
									<option key={id} value={id}>
										{name}
									</option>
								))}
							</Select>
							<div className="relative min-w-0 flex-1">
								<Search
									className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
									aria-hidden="true"
								/>
								<input
									type="search"
									aria-label="search apps"
									value={qText}
									onChange={(e) => {
										setQText(e.target.value)
										setParam('q', e.target.value)
									}}
									placeholder="search apps"
									className={cn(fieldClasses, 'h-10 pl-8 pr-3 sm:h-9')}
								/>
							</div>
						</div>
					</div>

					{rows.length === 0 ? (
						<EmptyState
							compact
							title="no apps match these filters"
							action={
								<Link
									href={pathname}
									className={buttonVariants({ variant: 'outline', size: 'sm' })}
								>
									clear filters
								</Link>
							}
						/>
					) : (
						<>
							{/* Phones: one card per app. */}
							<ul className="space-y-2 md:hidden" aria-label="apps">
								{rows.map((a) => (
									<MobileRow
										key={a.id}
										app={a}
										busy={busy}
										onDeploy={() => act(a, 'deploy')}
										onRestart={() => setRestartApp(a)}
									/>
								))}
							</ul>
							<TableFrame className="hidden md:block">
								<Table>
									<caption className="sr-only">
										apps, failed and down first, then most recently deployed
									</caption>
									<THead>
										<tr>
											<Th>app</Th>
											<Th>server</Th>
											<Th>status</Th>
											<Th className="hidden lg:table-cell">last deploy</Th>
											<Th className="text-right">
												<span className="sr-only">actions</span>
											</Th>
										</tr>
									</THead>
									<TBody>
										{rows.map((a) => (
											<Row
												key={a.id}
												app={a}
												busy={busy}
												onDeploy={() => act(a, 'deploy')}
												onRestart={() => setRestartApp(a)}
											/>
										))}
									</TBody>
								</Table>
							</TableFrame>
						</>
					)}
				</>
			)}

			<ConfirmDialog
				open={restartApp !== null}
				title={`Restart ${restartApp?.containerName ?? ''}?`}
				description="The container restarts in place. No rebuild."
				confirmLabel="restart"
				loading={busy !== null}
				onConfirm={() => restartApp && act(restartApp, 'restart')}
				onClose={() => setRestartApp(null)}
			/>
		</div>
	)
}

// One strip above the table. The counters are the status filter: one per app
// state (lib/app-health.ts), clicking the active one clears it. Then the latest
// deploy, how many apps have an uptime check, and deploys per day.
function FleetSummary({
	apps,
	counters,
	status,
	hrefFor,
}: {
	apps: AppRow[]
	counters: ReturnType<typeof countStatuses>
	status: StatusFilter
	hrefFor: (s: StatusFilter) => string
}) {
	const h = useMemo(() => fleetHeartbeat(apps), [apps])
	const days = useMemo(() => sumDeployDays(apps.map((a) => a.deployDays ?? emptyDays())), [apps])
	const lastMeta = h.last ? deployStatus(h.last.status) : null
	const checked = h.up + h.down
	return (
		<section
			aria-label="summary of all apps"
			className="grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-card shadow-card lg:grid-cols-[auto_minmax(0,1fr)]"
		>
			<nav
				aria-label="filter apps by state"
				className="grid grid-cols-5 divide-x divide-border border-b border-border lg:border-b-0 lg:border-r"
			>
				{APP_STATES.map((s) => (
					<Counter
						key={s}
						state={s}
						n={counters[s]}
						href={hrefFor(status === s ? 'all' : s)}
						active={status === s}
					/>
				))}
			</nav>
			<div className="flex min-w-0 flex-col justify-center gap-3 px-4 py-3 md:flex-row md:items-center md:gap-6">
				<div className="min-w-0 space-y-1 text-xs text-muted-foreground md:w-60 md:shrink-0">
					<div className="truncate">
						{h.last && lastMeta ? (
							<>
								last deploy {timeAgoDays(h.last.startedAt)}:{' '}
								<span className="font-medium text-foreground">{h.last.app}</span>{' '}
								<span className={cn(lastMeta.tone === 'destructive' && 'text-destructive')}>
									{lastMeta.label}
								</span>
							</>
						) : (
							'no deploys yet'
						)}
					</div>
					<div className="flex items-center gap-1.5">
						<Activity className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						{checked === apps.length
							? 'uptime checked on every app'
							: `uptime checked on ${checked} of ${apps.length} apps`}
					</div>
				</div>
				<div className="hidden min-w-0 flex-1 md:block">
					<DeployBars days={days} className="h-8" />
					<div className="mt-1 text-2xs text-muted-foreground">{stripSummary(days)}</div>
				</div>
			</div>
		</section>
	)
}

function Counter(props: { state: AppState; n: number; href: string; active: boolean }) {
	const m = APP_STATE[props.state]
	return (
		<Link
			href={props.href}
			aria-current={props.active ? 'true' : undefined}
			aria-label={`${props.n} ${m.label}${props.active ? ', showing only these; select to show all' : ''}`}
			className={cn(
				'relative flex min-w-0 flex-col justify-center px-2.5 py-2.5 transition-colors hover:bg-accent/40 sm:px-4 sm:py-3 lg:min-w-26',
				props.active && 'bg-accent/70',
				props.n === 0 && !props.active && 'text-muted-foreground',
			)}
		>
			<span
				className={cn(
					'text-lg font-semibold tabular-nums tracking-tight sm:text-xl',
					props.n > 0 && m.tone === 'destructive' && 'text-destructive',
				)}
			>
				{props.n}
			</span>
			<span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground sm:text-xs">
				<StatusDot tone={props.n > 0 ? m.tone : 'neutral'} className="hidden sm:inline-flex" />
				<span className="truncate">{m.label}</span>
			</span>
			{props.active && (
				<span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground" />
			)}
		</Link>
	)
}

function HealthLabel({ app, className }: { app: AppRow; className?: string }) {
	const m = APP_HEALTH[appRowHealth(app)]
	return (
		<StatusLabel tone={m.tone} pulse={m.pulse} className={className}>
			{m.label}
		</StatusLabel>
	)
}

function LastDeploy({ app }: { app: AppRow }) {
	const d = app.lastDeploy
	if (!d) return <span className="text-muted-foreground">never deployed</span>
	const sha = shortSha(d.gitSha)
	const dur = deployDuration(d)
	const branch = d.gitBranch ?? app.branch
	return (
		<div className="space-y-0.5 text-xs text-muted-foreground">
			<div className="flex items-center gap-1.5">
				{sha && <span className="font-mono text-foreground">{sha}</span>}
				{branch && <span className="truncate">{branch}</span>}
			</div>
			<div>
				{timeAgoDays(d.startedAt)}
				{dur ? ` · took ${dur}` : ''}
			</div>
		</div>
	)
}

function RowActions(props: {
	app: AppRow
	busy: string | null
	onDeploy: () => void
	onRestart: () => void
	className?: string
}) {
	const a = props.app
	const s = deriveStatus(a)
	const rowBusy = props.busy?.startsWith(`${a.id}:`) ?? false
	const deploying = props.busy === `${a.id}:deploy`
	return (
		<div className={cn('flex items-center gap-1.5', props.className)}>
			<Button
				size="sm"
				variant="outline"
				disabled={rowBusy || s === 'deploying'}
				loading={deploying}
				onClick={props.onDeploy}
				aria-label={`deploy ${a.containerName}`}
			>
				{!deploying && <Upload className="h-3.5 w-3.5" />}
				deploy
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={rowBusy || s === 'deploying'}
				onClick={props.onRestart}
				aria-label={`restart ${a.containerName}`}
			>
				<RotateCw className="h-3.5 w-3.5" />
				restart
			</Button>
			<Link
				href={`/projects/${a.id}/env`}
				aria-label={`env vars for ${a.containerName}`}
				className={buttonVariants({ variant: 'ghost', size: 'sm' })}
			>
				<KeyRound className="h-3.5 w-3.5" />
				env
				{a.envCount > 0 && (
					<span className="tabular-nums text-muted-foreground">{a.envCount}</span>
				)}
			</Link>
		</div>
	)
}

// Last two weeks of deploys under the name; nothing when there were none.
function RowStrip({ app, className }: { app: AppRow; className?: string }) {
	const days = (app.deployDays ?? emptyDays()).slice(-ROW_DAYS)
	if (stripEmpty(days)) return null
	return <DeployStrip days={days} className={className} />
}

function Row(props: {
	app: AppRow
	busy: string | null
	onDeploy: () => void
	onRestart: () => void
}) {
	const a = props.app
	return (
		<Tr className="align-middle">
			<Td className="max-w-[18rem]">
				<Link
					href={`/projects/${a.id}`}
					className="font-medium hover:underline focus-visible:underline"
				>
					{a.containerName}
				</Link>
				{a.domain && <div className="truncate text-xs text-muted-foreground">{a.domain}</div>}
				<RowStrip app={a} className="mt-1.5" />
			</Td>
			<Td className="text-muted-foreground">{a.serverName}</Td>
			<Td>
				<HealthLabel app={a} />
			</Td>
			<Td className="hidden lg:table-cell">
				<LastDeploy app={a} />
			</Td>
			<Td>
				<RowActions {...props} className="justify-end" />
			</Td>
		</Tr>
	)
}

function MobileRow(props: {
	app: AppRow
	busy: string | null
	onDeploy: () => void
	onRestart: () => void
}) {
	const a = props.app
	return (
		<li className="rounded-lg border border-border bg-card shadow-card">
			<Link href={`/projects/${a.id}`} className="block rounded-t-lg px-4 pb-2 pt-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="truncate font-medium">{a.containerName}</div>
						<div className="truncate text-xs text-muted-foreground">
							{a.domain ? `${a.domain} · ${a.serverName}` : a.serverName}
						</div>
					</div>
					<HealthLabel app={a} className="shrink-0 text-xs" />
				</div>
				<div className="mt-2">
					<LastDeploy app={a} />
				</div>
				<RowStrip app={a} className="mt-2.5 [&>span]:flex-1" />
			</Link>
			<div className="border-t border-border px-2 py-1.5">
				<RowActions {...props} />
			</div>
		</li>
	)
}
