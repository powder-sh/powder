'use client'

import { deployKindLabel, deployStatus } from '@/lib/deploy-status'
import { Alert } from '@/components/ui/alert'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusDot, StatusLabel } from '@/components/ui/status'
import { Server as ServerIcon } from 'lucide-react'
import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, GitBranch, Plus, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AddServerCard } from '@/components/add-server-card'
import { ServerUnreachable } from '@/components/server-unreachable'
import { serverStatus } from '@/lib/server-status'

interface Container {
	name: string
	image: string
	status: string
	state: string
	ports: string
	createdAt: string
	urls: string[]
	repo: { repoUrl: string; branch: string } | null
	lastDeploy: {
		id: string
		status: 'running' | 'success' | 'failed'
		kind: string
		startedAt: string
		finishedAt: string | null
		gitSha: string | null
	} | null
}

interface Server {
	id: string
	name: string
	host: string
	hostKeyFingerprint?: string | null
	kind: 'compose' | 'raw-docker'
	proxy?: 'nginx' | 'nginx-container' | 'traefik'
	tlsMode?: 'acme' | 'origin-cert'
	baseDomain?: string | null
	status: 'pending' | 'connected' | 'unreachable'
	reachable: boolean
	error?: string
	containers: Container[]
}

export default function ServersPage() {
	const [servers, setServers] = useState<Server[]>([])
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const [showAdd, setShowAdd] = useState(false)

	async function load() {
		try {
			const res = await fetch('/api/servers/sync', { method: 'POST' })
			const data = (await res.json().catch(() => ({}))) as { servers?: Server[]; error?: string }
			if (!res.ok || !Array.isArray(data.servers)) {
				setLoadError(data.error ?? `failed to load servers (${res.status})`)
			} else {
				setServers(data.servers)
				setLoadError(null)
			}
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : 'failed to load servers')
		}
		setLoading(false)
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; load is recreated every render and only calls state setters, so listing it would refetch on every render
	useEffect(() => {
		load()
	}, [])

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

	return (
		<div className="space-y-6">
			<title>servers · powder</title>
			<PageHeader
				title="servers"
				actions={
					servers.length > 0 && (
						<>
							<Button variant="ghost" size="sm" onClick={refresh} loading={refreshing}>
								{!refreshing && <RefreshCw className="h-3.5 w-3.5" />}
								refresh
							</Button>
							{!showAdd && (
								<Button size="sm" onClick={() => setShowAdd(true)}>
									<Plus className="h-3.5 w-3.5" />
									add server
								</Button>
							)}
						</>
					)
				}
			/>

			{showAdd && <AddServerCard onClose={() => setShowAdd(false)} onAdded={load} />}

			{loading ? (
				<SkeletonList />
			) : loadError ? (
				<Alert tone="destructive" title="could not load servers">
					{loadError}
				</Alert>
			) : servers.length === 0 ? (
				showAdd ? null : (
				<EmptyState
					icon={ServerIcon}
					title="no servers yet"
					action={
						<Button onClick={() => setShowAdd(true)}>
							<Plus className="h-4 w-4" />
							add a server
						</Button>
					}
				>
					add a Linux server you can SSH into as root. powder deploys your apps there and installs Docker if it is missing.
				</EmptyState>
				)
			) : (
				<div className="space-y-4">
					{servers.map((server) => (
						<ServerCard
							key={server.id}
							server={server}
							onRetry={refresh}
						/>
					))}
				</div>
			)}

		</div>
	)
}

interface ServerStats {
	ok: boolean
	cpu?: { cores: number; load1: number; load5: number; load15: number }
	memory?: { total: number; used: number; available: number }
	disk?: { total: number; used: number; available: number }
	containers?: { running: number; total: number }
	uptimeSeconds?: number
	error?: string
}

function bytes(n: number): string {
	if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(1) + 'TB'
	if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB'
	if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + 'MB'
	return n.toString()
}

function uptimeStr(s: number): string {
	const d = Math.floor(s / 86400)
	const h = Math.floor((s % 86400) / 3600)
	if (d > 0) return `${d}d ${h}h`
	const m = Math.floor((s % 3600) / 60)
	if (h > 0) return `${h}h ${m}m`
	return `${m}m`
}

function ServerStatsRow({ serverId, reachable }: { serverId: string; reachable: boolean }) {
	const [stats, setStats] = useState<ServerStats | null>(null)
	useEffect(() => {
		if (!reachable) return
		fetch(`/api/servers/${serverId}/stats`)
			.then((r) => r.json())
			.then(setStats)
			.catch(() => setStats({ ok: false, error: 'fetch failed' }))
	}, [serverId, reachable])

	if (!reachable) return null
	if (!stats) {
		return (
			<div
				className="mb-4 grid grid-cols-2 gap-3 border-b border-border pb-4 md:grid-cols-4"
				aria-busy="true"
			>
				{['cpu', 'mem', 'disk', 'ctr'].map((k) => (
					<div key={k} className="space-y-1.5">
						<Skeleton className="h-2.5 w-14" />
						<Skeleton className="h-4 w-24" />
					</div>
				))}
				<span className="sr-only">loading stats</span>
			</div>
		)
	}
	if (!stats.ok || !stats.cpu || !stats.memory || !stats.disk || !stats.containers) {
		return (
			<div className="mb-4 pb-4 border-b border-border text-xs text-muted-foreground">
				stats unavailable
			</div>
		)
	}
	const memPct =
		stats.memory.total > 0 ? Math.round((stats.memory.used / stats.memory.total) * 100) : 0
	const diskPct = stats.disk.total > 0 ? Math.round((stats.disk.used / stats.disk.total) * 100) : 0
	const loadPct =
		stats.cpu.cores > 0 ? Math.min(100, Math.round((stats.cpu.load1 / stats.cpu.cores) * 100)) : 0
	const memWarn = memPct > 85
	const diskWarn = diskPct > 85
	const loadWarn = loadPct > 80

	return (
		<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 pb-4 border-b border-border">
			<Stat
				label="cpu load"
				value={`${stats.cpu.load1.toFixed(1)} / ${stats.cpu.cores}`}
				detail={`${loadPct}%`}
				warn={loadWarn}
			/>
			<Stat
				label="memory"
				value={`${bytes(stats.memory.used)} / ${bytes(stats.memory.total)}`}
				detail={`${memPct}%`}
				warn={memWarn}
			/>
			<Stat
				label="disk"
				value={`${bytes(stats.disk.used)} / ${bytes(stats.disk.total)}`}
				detail={`${diskPct}%`}
				warn={diskWarn}
			/>
			<Stat
				label="containers"
				value={`${stats.containers.running}/${stats.containers.total}`}
				detail={stats.uptimeSeconds ? `up ${uptimeStr(stats.uptimeSeconds)}` : ''}
			/>
		</div>
	)
}

function Stat({
	label,
	value,
	detail,
	warn,
}: { label: string; value: string; detail: string; warn?: boolean }) {
	return (
		<div>
			<div className="text-2xs text-muted-foreground">{label}</div>
			<div className={`mt-0.5 font-mono text-sm ${warn ? 'text-warning' : 'text-foreground'}`}>
				{value}
			</div>
			<div className="text-xs text-muted-foreground">{detail}</div>
		</div>
	)
}

const PROXY_LABEL: Record<string, string> = {
	traefik: 'Traefik',
	nginx: 'nginx on the host',
	'nginx-container': 'nginx in a container',
}

function ServerCard({ server, onRetry }: { server: Server; onRetry: () => Promise<void> }) {
	const facts = [
		PROXY_LABEL[server.proxy ?? 'nginx'],
		server.proxy === 'traefik' ? (server.tlsMode === 'origin-cert' ? 'origin certificate' : "Let's Encrypt") : null,
		server.baseDomain ? `*.${server.baseDomain}` : server.proxy === 'traefik' ? 'no base domain' : null,
	].filter(Boolean)
	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
					<div className="flex min-w-0 items-center gap-2.5">
						<CardTitle className="truncate text-base">
							<Link href={`/servers/${server.id}`} className="underline-offset-2 hover:underline">
								{server.name}
							</Link>
						</CardTitle>
						<StatusBadge status={server.status} />
						{server.kind === 'raw-docker' && <Badge variant="outline">watch only</Badge>}
					</div>
					<div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
						<span className="font-mono">{server.host}</span>
						<Link
							href={`/servers/${server.id}`}
							className="inline-flex h-10 items-center font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground sm:h-auto"
						>
							settings
						</Link>
					</div>
				</div>
				{facts.length > 0 && (
					<p className="text-xs text-muted-foreground">{facts.join(' · ')}</p>
				)}
			</CardHeader>
			<CardContent>
				<ServerStatsRow serverId={server.id} reachable={server.reachable} />
				{!server.reachable ? (
					<ServerUnreachable
						serverId={server.id}
						serverName={server.name}
						error={server.error}
						what="what runs on it"
						onRetry={onRetry}
						openServer={false}
						className="border-dashed shadow-none"
					/>
				) : server.containers.length === 0 ? (
					<EmptyState compact title="no app containers on this server">
						import a repo from{' '}
						<Link href="/new" className="text-foreground underline underline-offset-2">
							new app
						</Link>{' '}
						to deploy here.
					</EmptyState>
				) : (
					<div className="divide-y divide-border">
						<div className="hidden grid-cols-12 gap-3 pb-2 text-xs font-medium text-muted-foreground md:grid">
							<div className="col-span-3">name</div>
							<div className="col-span-3">url</div>
							<div className="col-span-3">git</div>
							<div className="col-span-2">last deploy</div>
							<div className="col-span-1 text-right">state</div>
						</div>
						{server.containers.map((c) => (
							<div
								key={c.name}
								className="relative -mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2.5 text-sm transition-colors hover:bg-accent/40 md:grid-cols-12"
							>
								<div className="min-w-0 md:col-span-3">
									<Link
										href={`/servers/${server.id}/${c.name}`}
										className="block after:absolute after:inset-0 after:content-['']"
									>
										<div className="truncate font-mono text-xs">{c.name}</div>
										<div className="truncate font-mono text-2xs text-muted-foreground">
											{c.image}
										</div>
									</Link>
								</div>
								<div className="hidden min-w-0 md:col-span-3 md:block">
									{c.urls.length === 0 ? (
										<span className="text-xs text-muted-foreground">-</span>
									) : (
										<div className="flex flex-col gap-0.5">
											{c.urls.slice(0, 2).map((u) => (
												<button
													key={u}
													type="button"
													onClick={(e) => {
														window.open(u, '_blank', 'noopener')
													}}
													className="relative z-10 inline-flex items-center gap-1 truncate text-left text-xs text-foreground hover:underline"
												>
													<span className="truncate">{u.replace(/^https?:\/\//, '')}</span>
													<ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
												</button>
											))}
										</div>
									)}
								</div>
								<div className="hidden min-w-0 md:col-span-3 md:block">
									{c.repo ? (
										<div className="flex items-center gap-1.5 text-xs">
											<GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
											<span className="truncate font-mono">{prettyRepo(c.repo.repoUrl)}</span>
											<span className="shrink-0 font-mono text-2xs text-muted-foreground">
												{c.repo.branch}
											</span>
										</div>
									) : (
										<span className="text-2xs text-muted-foreground">not connected</span>
									)}
								</div>
								<div className="hidden min-w-0 md:col-span-2 md:block">
									<DeployStatus deploy={c.lastDeploy} />
								</div>
								<div className="text-right md:col-span-1">
									<StateBadge state={c.state} />
								</div>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	)
}

const BADGE_TONE = { success: 'success', warning: 'warning', destructive: 'destructive', neutral: 'outline', info: 'info' } as const

function StatusBadge({ status }: { status: 'pending' | 'connected' | 'unreachable' }) {
	const m = serverStatus(status)
	return <Badge variant={BADGE_TONE[m.tone]}>{m.label}</Badge>
}

function StateBadge({ state }: { state: string }) {
	const label = state || 'unknown'
	const tone =
		state === 'running'
			? 'success'
			: state === 'exited' || state === 'dead'
				? 'destructive'
				: 'neutral'
	return (
		<StatusLabel tone={tone} className="justify-end text-xs">
			{label}
		</StatusLabel>
	)
}

function DeployStatus({ deploy }: { deploy: Container['lastDeploy'] }) {
	if (!deploy) return <span className="text-2xs text-muted-foreground">-</span>
	const ago = (() => {
		try {
			const ms = Date.now() - new Date(deploy.startedAt).getTime()
			const s = Math.floor(ms / 1000)
			if (s < 60) return `${s}s ago`
			const m = Math.floor(s / 60)
			if (m < 60) return `${m}m ago`
			const h = Math.floor(m / 60)
			if (h < 48) return `${h}h ago`
			const d = Math.floor(h / 24)
			return `${d}d ago`
		} catch {
			return ''
		}
	})()
	const m = deployStatus(deploy.status)
	return (
		<div className="flex items-center gap-1.5 text-2xs">
			<StatusDot tone={m.tone} pulse={m.pulse} className="h-1.5 w-1.5" />
			<span className="sr-only">{m.label}</span>
			<span className="truncate text-muted-foreground">{deployKindLabel(deploy.kind)}</span>
			<span className="shrink-0 text-muted-foreground/70">· {ago}</span>
		</div>
	)
}

function prettyRepo(url: string): string {
	const ssh = url.match(/^git@[^:]+:([^/]+)\/(.+?)(\.git)?$/)
	if (ssh) return `${ssh[1]}/${ssh[2]}`
	const https = url.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(\.git)?\/?$/)
	if (https) return `${https[1]}/${https[2]}`
	return url
}
