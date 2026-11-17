'use client'

import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronRight, Globe, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button-variants'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { formatDateTime } from '@/lib/format'

interface CustomRedirect {
	from: string
	to: string
	status?: 301 | 302
}

interface DomainRow {
	serverId: string
	serverName: string
	containerName: string
	hostname: string
	urls: string[]
	proxyKind: 'nginx-host' | 'nginx-container' | 'traefik' | 'unknown'
	wwwMode: 'none' | 'apex' | 'www'
	custom: CustomRedirect[]
	appliedAt: string | null
	appliedError: string | null
	existingRedirect: 'apex' | 'www' | null
}

interface ServerRow {
	id: string
	name: string
	proxy: string | null
}

// The nginx domain manager: www and custom redirects written into nginx on
// servers routed by nginx. Apps on a Traefik server manage their domains on the
// app's own domains tab (projects/[id]/domains), so this page lists only nginx
// servers' hostnames and says so when there are none.
function isNginxServer(s: Pick<ServerRow, 'proxy'>): boolean {
	return s.proxy !== 'traefik'
}

export default function DomainsPage() {
	const searchParams = useSearchParams()
	const appFilter = searchParams.get('app')?.trim() || null

	const [nginxServers, setNginxServers] = useState<ServerRow[] | null>(null)
	const [rows, setRows] = useState<DomainRow[] | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const [expanded, setExpanded] = useState<string | null>(null)

	async function load() {
		setLoadError(null)
		const sres = await fetch('/api/servers/list').catch(() => null)
		if (!sres?.ok) {
			setLoadError(`could not list servers (${sres?.status ?? 'network error'})`)
			setNginxServers([])
			setRows([])
			return
		}
		const sdata = (await sres.json()) as { servers: ServerRow[] }
		const nginx = sdata.servers.filter(isNginxServer)
		setNginxServers(nginx)
		if (nginx.length === 0) {
			setRows([])
			return
		}
		// ?app=name scopes to one app: single server SSH instead of fan-out.
		const url = appFilter ? `/api/domains?app=${encodeURIComponent(appFilter)}` : '/api/domains'
		const res = await fetch(url)
		const data = (await res.json().catch(() => ({}))) as { domains?: DomainRow[] }
		const ids = new Set(nginx.map((x) => x.id))
		setRows((data.domains ?? []).filter((r) => ids.has(r.serverId)))
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the ?app filter changes; load is recreated every render and reads appFilter itself
	useEffect(() => {
		load()
	}, [appFilter])

	async function refresh() {
		setRefreshing(true)
		try {
			await load()
		} catch {
			// load keeps the last list on screen
		} finally {
			setRefreshing(false)
		}
	}

	if (rows === null || nginxServers === null) {
		return (
			<div className="space-y-6">
				<Header />
				<SkeletonList />
			</div>
		)
	}

	if (nginxServers.length === 0) {
		return (
			<div className="space-y-6">
				<Header />
				{loadError && <Alert tone="destructive">{loadError}</Alert>}
				<EmptyState
					icon={Globe}
					title="no nginx servers"
					action={
						<Link href="/projects" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
							open apps
						</Link>
					}
				>
					this page manages redirects on servers routed by nginx. on a Traefik server each app has
					its own domains tab: open the app, then domains.
				</EmptyState>
			</div>
		)
	}

	return (
		<div className="space-y-6">
			<Header
				count={rows.length}
				actions={
					<Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
						<RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
						refresh
					</Button>
				}
			/>

			<p className="text-xs text-muted-foreground">
				nginx servers:{' '}
				<span className="font-mono">{nginxServers.map((x) => x.name).join(', ')}</span>. apps on
				Traefik servers manage domains on their own domains tab.
			</p>

			{rows.length === 0 ? (
				<EmptyState icon={Globe} title="no domains found" compact>
					no nginx site on these servers routes to a powder app yet.
				</EmptyState>
			) : (
				<div className="rounded-lg border border-border">
					<div className="grid grid-cols-12 gap-3 border-b border-border bg-muted/30 px-3 py-2 text-2xs font-medium text-muted-foreground">
						<div className="col-span-1" />
						<div className="col-span-5">domain</div>
						<div className="col-span-3">app</div>
						<div className="col-span-3">redirect</div>
					</div>
					{rows.map((r) => {
						const key = `${r.serverId}/${r.containerName}/${r.hostname}`
						const isOpen = expanded === key
						return (
							<div key={key}>
								<button
									type="button"
									onClick={() => setExpanded(isOpen ? null : key)}
									aria-expanded={isOpen}
									className="grid w-full grid-cols-12 gap-3 border-b border-border px-3 py-2.5 text-left text-sm hover:bg-accent/30 last:border-b-0"
								>
									<div className="col-span-1 flex items-center text-muted-foreground">
										{isOpen ? (
											<ChevronDown className="h-3 w-3" />
										) : (
											<ChevronRight className="h-3 w-3" />
										)}
									</div>
									<div className="col-span-5 min-w-0 truncate font-mono text-xs">{r.hostname}</div>
									<div className="col-span-3 min-w-0 truncate text-xs text-muted-foreground">
										{r.containerName}
									</div>
									<div className="col-span-3">
										<RedirectChip
											wwwMode={r.wwwMode}
											existingRedirect={r.existingRedirect}
											hostname={r.hostname}
										/>
									</div>
								</button>
								{isOpen && (
									<div className="border-b border-border bg-muted/10 px-3 py-3">
										<DomainEditor row={r} onSaved={load} />
									</div>
								)}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}

function Header({ count, actions }: { count?: number; actions?: React.ReactNode }) {
	return (
		<PageHeader
			title={
				<>
					domains
					<Badge variant="outline">nginx servers</Badge>
				</>
			}
			description={
				count === undefined
					? 'www and custom redirects for apps on nginx servers. apps on Traefik servers set domains on their own domains tab.'
					: `${count} ${count === 1 ? 'domain' : 'domains'} on nginx servers. click a row to set redirect rules.`
			}
			actions={actions}
		/>
	)
}

function RedirectChip({
	wwwMode,
	existingRedirect,
	hostname,
}: {
	wwwMode: DomainRow['wwwMode']
	existingRedirect: 'apex' | 'www' | null
	hostname: string
}) {
	const apex = hostname.replace(/^www\./, '')
	// "Already handled" trumps stored config: what nginx actually does is the truth.
	if (existingRedirect === 'apex') {
		return (
			<span className="rounded bg-success/15 border border-success/20 px-1.5 py-0.5 font-mono text-2xs text-success">
				✓ www → {apex}
			</span>
		)
	}
	if (existingRedirect === 'www') {
		return (
			<span className="rounded bg-success/15 border border-success/20 px-1.5 py-0.5 font-mono text-2xs text-success">
				✓ {apex} → www
			</span>
		)
	}
	if (wwwMode === 'apex') {
		return (
			<span className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
				www → {apex}
			</span>
		)
	}
	if (wwwMode === 'www') {
		return (
			<span className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
				{apex} → www
			</span>
		)
	}
	return <span className="text-2xs text-muted-foreground">-</span>
}

function DomainEditor({ row, onSaved }: { row: DomainRow; onSaved: () => void }) {
	const [wwwMode, setWwwMode] = useState(row.wwwMode)
	const [custom, setCustom] = useState<CustomRedirect[]>(row.custom)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [applied, setApplied] = useState(false)
	const apex = row.hostname.replace(/^www\./, '')
	const isTraefik = row.proxyKind === 'traefik'
	const alreadyHandled = row.existingRedirect !== null
	const matchesExisting =
		(row.existingRedirect === 'apex' && wwwMode === 'apex') ||
		(row.existingRedirect === 'www' && wwwMode === 'www')

	async function apply() {
		setBusy(true)
		try {
			setError(null)
			setApplied(false)
			const res = await fetch(
				`/api/domains/${row.serverId}/${row.containerName}/${encodeURIComponent(row.hostname)}`,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ wwwMode, custom, apply: true }),
				},
			)
			if (!res.ok) {
				const d = await res.json().catch(() => ({}))
				setError(d.error ?? `failed (${res.status})`)
				return
			}
			setApplied(true)
			onSaved()
		} catch {
			setError('failed: network error')
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="space-y-3">
			{alreadyHandled && (
				<div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-2xs text-success">
					✓ already handled by an existing nginx config (
					{row.existingRedirect === 'apex' ? `www.${apex} → ${apex}` : `${apex} → www.${apex}`}
					). no apply needed.
				</div>
			)}
			<div>
				<div className="text-2xs text-muted-foreground mb-1">primary</div>
				<div className="flex flex-wrap gap-2">
					<Pill on={wwwMode === 'apex'} onClick={() => setWwwMode('apex')}>
						{apex} <span className="text-2xs text-muted-foreground">(www → apex)</span>
					</Pill>
					<Pill on={wwwMode === 'www'} onClick={() => setWwwMode('www')}>
						www.{apex} <span className="text-2xs text-muted-foreground">(apex → www)</span>
					</Pill>
					<Pill on={wwwMode === 'none'} onClick={() => setWwwMode('none')}>
						both
					</Pill>
				</div>
			</div>

			<details className="group">
				<summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-2xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
					<ChevronRight
						aria-hidden="true"
						className="h-3 w-3 transition-transform group-open:rotate-90"
					/>
					path redirects {custom.length > 0 ? `· ${custom.length}` : ''}
				</summary>
				<div className="mt-2 space-y-1">
					{custom.map((r, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: redirect rows have no id; from/to are edited in place and may be empty or duplicate, so the position is the identity
						<div key={i} className="flex items-center gap-1.5">
							<Input
								value={r.from}
								onChange={(e) =>
									setCustom((c) => c.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))
								}
								placeholder="/old"
								aria-label="redirect from path"
								className="min-w-0 flex-1 font-mono"
							/>
							<span className="text-xs text-muted-foreground">→</span>
							<Input
								value={r.to}
								onChange={(e) =>
									setCustom((c) => c.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))
								}
								placeholder="/new"
								aria-label="redirect to path"
								className="min-w-0 flex-1 font-mono"
							/>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={() => setCustom((c) => c.filter((_, j) => j !== i))}
								aria-label="remove redirect"
								title="remove redirect"
								className="hover:text-destructive"
							>
								×
							</Button>
						</div>
					))}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setCustom((c) => [...c, { from: '/', to: '/', status: 301 }])}
					>
						+ add
					</Button>
				</div>
			</details>

			{error && <p className="text-xs text-destructive">{error}</p>}
			{applied && <p className="text-xs text-success">applied · nginx reloaded.</p>}

			<div className="flex items-center justify-between">
				<div className="text-2xs text-muted-foreground">
					{isTraefik
						? "Traefik server: manage this domain on the app's domains tab"
						: row.appliedAt
							? `last applied ${formatDateTime(row.appliedAt)}`
							: 'not applied'}
					<Link href={`/servers/${row.serverId}/${row.containerName}`} className="ml-2 underline">
						{row.containerName}
					</Link>
				</div>
				<Button size="sm" onClick={apply} disabled={busy || isTraefik || matchesExisting}>
					{busy ? 'applying…' : matchesExisting ? 'no change needed' : 'apply'}
				</Button>
			</div>
		</div>
	)
}

function Pill({
	on,
	onClick,
	children,
}: {
	on: boolean
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`rounded-md border px-3 py-1.5 text-xs font-mono ${
				on
					? 'border-foreground bg-accent/40'
					: 'border-border text-muted-foreground hover:text-foreground'
			}`}
		>
			{children}
		</button>
	)
}
