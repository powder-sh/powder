'use client'

import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Copy, Database, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { CopyButton } from '@/components/ui/copy-button'
import { Button } from '@/components/ui/button'

interface DbRow {
	kind: 'postgres' | 'kv'
	serverId: string
	serverName: string
	containerName: string
	storeContainerName: string
	storeContainerState: string | null
	connectionString: string | null
	sizeBytes: number | null
	mode: 'sibling' | 'shared-container' | 'host' | 'unknown'
	dbName?: string | null
	appRepoId?: string
	error?: string
}

function fmtBytes(n: number | null): string {
	if (n == null) return '-'
	if (n < 1024) return `${n} B`
	const kb = n / 1024
	if (kb < 1024) return `${kb.toFixed(1)} KiB`
	const mb = kb / 1024
	if (mb < 1024) return `${mb.toFixed(1)} MiB`
	return `${(mb / 1024).toFixed(2)} GiB`
}

export default function DatabasesPage() {
	const [dbs, setDbs] = useState<DbRow[] | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	// the API strips the password; the full URL is fetched on demand
	// (reveal or copy), admin browser session only.
	const [fullUrls, setFullUrls] = useState<Map<string, string> | null>(null)

	async function load() {
		const res = await fetch('/api/databases')
		const data = await res.json()
		setFullUrls(null)
		setDbs(data.dbs ?? [])
	}

	async function fullUrlFor(row: DbRow): Promise<string | null> {
		const key = `${row.serverId}/${row.containerName}/${row.kind}`
		let m = fullUrls
		if (!m) {
			const res = await fetch('/api/databases?reveal=1')
			if (!res.ok) return null
			const data = (await res.json()) as { dbs?: DbRow[] }
			m = new Map()
			for (const r of data.dbs ?? [])
				if (r.connectionString)
					m.set(`${r.serverId}/${r.containerName}/${r.kind}`, r.connectionString)
			setFullUrls(m)
		}
		return m.get(key) ?? null
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

	if (dbs === null) {
		return (
			<div className="space-y-6">
				<Header />
				<SkeletonList />
			</div>
		)
	}

	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4">
				<Header count={dbs.length} />
				<Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
					<RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
					refresh
				</Button>
			</div>

			{dbs.length === 0 ? (
				<div className="rounded-md border border-dashed border-border p-6 text-center">
					<Database className="mx-auto h-6 w-6 text-muted-foreground" />
					<p className="mt-2 text-sm">no databases yet.</p>
					<p className="mt-1 text-xs text-muted-foreground">
						tick <span className="font-medium">add a database</span> when you{' '}
						<Link href="/new" className="underline">
							import a project
						</Link>{' '}
						and powder spins up a per-app postgres for you.
					</p>
				</div>
			) : (
				<div className="rounded-lg border border-border">
					<div className="grid grid-cols-12 gap-3 border-b border-border bg-muted/30 px-4 py-2 text-2xs font-medium text-muted-foreground">
						<div className="col-span-3">app</div>
						<div className="col-span-1">kind</div>
						<div className="col-span-2">server</div>
						<div className="col-span-1">status</div>
						<div className="col-span-1 text-right">size</div>
						<div className="col-span-4">connection string</div>
					</div>
					{dbs.map((d) => (
						<DbRow
							key={`${d.serverId}/${d.containerName}/${d.kind}`}
							row={d}
							getFull={() => fullUrlFor(d)}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function Header({ count }: { count?: number }) {
	return (
		<div>
			<title>databases · powder</title>
			<h1 className="text-2xl font-semibold tracking-tight">databases</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				{count === undefined
					? 'every postgres + redis instance powder runs for your apps.'
					: `${count} ${count === 1 ? 'store' : 'stores'} · postgres 16 + redis 7`}
			</p>
		</div>
	)
}

function DbRow({ row, getFull }: { row: DbRow; getFull: () => Promise<string | null> }) {
	return (
		<div className="group grid grid-cols-12 gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0">
			<div className="col-span-3 min-w-0">
				<Link
					href={`/servers/${row.serverId}/${row.containerName}`}
					className="block truncate font-mono text-xs hover:text-powder"
				>
					{row.containerName}
				</Link>
				<div className="mt-0.5 flex items-center gap-1 truncate text-2xs text-muted-foreground font-mono">
					<span className="truncate">{row.storeContainerName}</span>
					{row.dbName && row.mode !== 'sibling' && (
						<span className="text-muted-foreground/70">· db: {row.dbName}</span>
					)}
					<ModeBadge mode={row.mode} />
				</div>
				{row.kind === 'postgres' && row.appRepoId && (
					<Link
						href={`/projects/${row.appRepoId}/backups`}
						className="mt-0.5 inline-block text-2xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
						title="list backups, download one, restore into a new database, verify"
					>
						backups + restore
					</Link>
				)}
			</div>
			<div className="col-span-1">
				<KindBadge kind={row.kind} />
			</div>
			<div className="col-span-2 min-w-0">
				<div className="truncate text-xs">{row.serverName}</div>
			</div>
			<div className="col-span-1">
				<StateBadge state={row.storeContainerState} />
			</div>
			<div className="col-span-1 text-right">
				<span className="font-mono text-xs">{fmtBytes(row.sizeBytes)}</span>
			</div>
			<div className="col-span-4 min-w-0">
				{row.error ? (
					<span className="flex items-start gap-1">
						<span className="ph-no-capture min-w-0 text-2xs text-destructive [overflow-wrap:anywhere]">
							{row.error}
						</span>
						<CopyButton value={row.error} label="copy the error" reveal className="-my-1" />
					</span>
				) : row.connectionString ? (
					<UrlField
						url={row.connectionString}
						envName={row.kind === 'kv' ? 'REDIS_URL' : 'DATABASE_URL'}
						mode={row.mode}
						getFull={getFull}
					/>
				) : (
					<span className="text-2xs text-muted-foreground">
						no {row.kind === 'kv' ? 'REDIS_URL' : 'DATABASE_URL'} in env file
					</span>
				)}
			</div>
		</div>
	)
}

function ModeBadge({ mode }: { mode: DbRow['mode'] }) {
	if (mode === 'sibling') return null // default; no need to label
	if (mode === 'shared-container')
		return (
			<span
				className="rounded border border-warning/40 px-1 py-0.5 text-2xs text-warning"
				title="this app shares its postgres container with other apps"
			>
				shared
			</span>
		)
	if (mode === 'host')
		return (
			<span
				className="rounded border border-info/40 px-1 py-0.5 text-2xs text-info"
				title="postgres runs on the server's host OS, not in a docker container"
			>
				host pg
			</span>
		)
	return null
}

function KindBadge({ kind }: { kind: 'postgres' | 'kv' }) {
	if (kind === 'postgres') return <Badge variant="outline">postgres</Badge>
	return <Badge variant="outline">kv</Badge>
}

function UrlField({
	url,
	envName: _envName,
	mode = 'sibling',
	getFull,
}: {
	url: string
	envName?: string
	mode?: DbRow['mode']
	getFull: () => Promise<string | null>
}) {
	const [revealed, setRevealed] = useState(false)
	const [full, setFull] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const [copyError, setCopyError] = useState<string | null>(null)
	const masked = mask(url)

	async function loadFull(): Promise<string | null> {
		if (full) return full
		const f = await getFull()
		if (f) setFull(f)
		return f
	}

	async function toggle() {
		if (!revealed) await loadFull()
		setRevealed((v) => !v)
	}

	async function copy() {
		// Never copy the masked URL as if it were the real one. If the full URL
		// cannot be fetched (needs an admin browser session), say so.
		setCopyError(null)
		const f = await loadFull().catch(() => null)
		if (!f) {
			setCopyError('could not fetch the full URL (admin session needed); nothing copied')
			return
		}
		const ok = await navigator.clipboard.writeText(f).then(
			() => true,
			() => false,
		)
		if (!ok) {
			setCopyError('clipboard write failed; nothing copied')
			return
		}
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}

	const footer =
		mode === 'host'
			? 'host postgres: runs on the server OS, not in docker. ssh into the host to psql in.'
			: mode === 'shared-container'
				? 'shared postgres container: many apps in one container, each with its own db. ssh into the host first.'
				: 'internal: only your app can reach this on its per-app docker network. ssh into the host to psql in.'

	return (
		<div>
			<div className="flex items-start gap-1.5">
				<pre className="ph-no-capture flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-muted/40 px-2 py-1.5 font-mono text-2xs">
					{revealed && full ? full : masked}
				</pre>
				<button
					type="button"
					onClick={toggle}
					className="rounded-md p-1 text-muted-foreground hover:text-foreground"
					title={revealed ? 'hide' : 'reveal'}
					aria-label={revealed ? 'hide' : 'reveal'}
				>
					{revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
				</button>
				<button
					type="button"
					onClick={copy}
					className="rounded-md p-1 text-muted-foreground hover:text-foreground"
					title={copied ? 'copied' : 'copy'}
					aria-label={copied ? 'copied' : 'copy'}
				>
					{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
				</button>
			</div>
			{copyError && <div className="mt-1 text-2xs text-destructive">{copyError}</div>}
			<div className="mt-1 text-2xs text-muted-foreground">{footer}</div>
		</div>
	)
}

function StateBadge({ state }: { state: string | null }) {
	if (state === 'running') return <Badge variant="success">running</Badge>
	if (state === 'host') return <Badge variant="outline">host pg</Badge>
	if (state === 'exited' || state === 'dead') return <Badge variant="destructive">{state}</Badge>
	if (state === 'missing') return <Badge variant="warning">missing</Badge>
	if (state === 'unreachable') return <Badge variant="destructive">unreachable</Badge>
	return <Badge variant="outline">{state ?? '-'}</Badge>
}

function mask(url: string): string {
	// postgres://app:<pwd>@host:5432/db → postgres://app:•••@host:5432/db
	return url.replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1•••$2')
}
