'use client'

import { deployKindLabel, deployStatus } from '@/lib/deploy-status'
import { SkeletonList } from '@/components/ui/skeleton'
import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Search, Terminal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input, Select } from '@/components/ui/input'
import { formatDateTime } from '@/lib/format'

interface Result {
	id: string
	serverId: string
	containerName: string
	kind: string
	status: 'running' | 'success' | 'failed'
	startedAt: string
	gitSha: string | null
	gitBranch: string | null
	snippet: string | null
	snippetSource: 'error' | 'output'
}

export function LogsView({
	app: fixedApp,
	serverId,
	embedded,
}: { app?: string; serverId?: string; embedded?: boolean }) {
	// useSearchParams needs a Suspense boundary for static prerendering.
	return (
		<Suspense fallback={<SkeletonList />}>
			<LogsInner fixedApp={fixedApp} serverId={serverId} embedded={embedded} />
		</Suspense>
	)
}

function LogsInner({
	fixedApp,
	serverId,
	embedded,
}: { fixedApp?: string; serverId?: string; embedded?: boolean }) {
	const paramApp = useSearchParams().get('app') ?? ''
	const app = fixedApp ?? paramApp
	const [q, setQ] = useState('')
	const [status, setStatus] = useState<'' | 'success' | 'failed' | 'running'>('')
	const [sinceDays, setSinceDays] = useState(30)
	const [results, setResults] = useState<Result[] | null>(null)
	const [hint, setHint] = useState<string | null>(null)
	const [searching, setSearching] = useState(false)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current)
		if (q.trim().length < 2) {
			setResults(null)
			setHint(null)
			setSearching(false)
			return
		}
		// One AbortController per request: a newer search cancels the older one, and
		// the aborted request's response is ignored.
		const ctrl = new AbortController()
		debounceRef.current = setTimeout(async () => {
			setSearching(true)
			const params = new URLSearchParams({ q: q.trim(), sinceDays: String(sinceDays) })
			if (status) params.set('status', status)
			if (app) params.set('app', app)
			if (serverId) params.set('serverId', serverId)
			try {
				const res = await fetch(`/api/logs/search?${params}`, { signal: ctrl.signal })
				if (ctrl.signal.aborted) return
				if (!res.ok) {
					setResults([])
					setHint(`error (${res.status})`)
					setSearching(false)
					return
				}
				const data = await res.json()
				if (ctrl.signal.aborted) return
				setResults(data.results ?? [])
				setHint(data.hint ?? null)
				setSearching(false)
			} catch (e) {
				if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return
				setResults([])
				setHint('search failed')
				setSearching(false)
			}
		}, 300)
		return () => {
			ctrl.abort()
			if (debounceRef.current) clearTimeout(debounceRef.current)
		}
	}, [q, status, sinceDays, app, serverId])

	return (
		<div className="space-y-6 max-w-4xl">
			{!embedded && <title>logs · powder</title>}
			<header>
				{!embedded && <h1 className="text-2xl font-semibold tracking-tight">logs</h1>}
				<p className="mt-1 text-sm text-muted-foreground">
					full-text search across every deploy's output. up to 50 results, last 30 days by default.
				</p>
			</header>

			<div className="space-y-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="ECONNREFUSED, error, your migration name…"
						className="pl-8 font-mono"
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span className="text-2xs text-muted-foreground">filter:</span>
					<Select
						selectSize="sm"
						aria-label="filter by status"
						value={status}
						onChange={(e) => setStatus(e.target.value as typeof status)}
					>
						<option value="">any status</option>
						<option value="success">success only</option>
						<option value="failed">failed only</option>
						<option value="running">running only</option>
					</Select>
					<Select
						selectSize="sm"
						aria-label="time range"
						value={String(sinceDays)}
						onChange={(e) => setSinceDays(Number(e.target.value))}
					>
						<option value="1">last 24h</option>
						<option value="7">last 7d</option>
						<option value="30">last 30d</option>
						<option value="90">last 90d</option>
						<option value="3650">forever</option>
					</Select>
					{app && !fixedApp && (
						<span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono">
							app: {app}
							<Link
								href="/projects"
								className="text-muted-foreground hover:text-foreground"
								aria-label="clear app filter"
							>
								×
							</Link>
						</span>
					)}
					{searching && <span className="text-muted-foreground">searching…</span>}
				</div>
			</div>

			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}

			{results === null ? (
				q.trim().length === 0 ? (
					<EmptyHint />
				) : null
			) : results.length === 0 ? (
				<p className="text-sm text-muted-foreground">no matches.</p>
			) : (
				<div className="space-y-2">
					<p className="text-xs text-muted-foreground">
						{results.length} result{results.length === 1 ? '' : 's'}
					</p>
					{results.map((r) => (
						<ResultRow key={r.id} row={r} q={q.trim()} />
					))}
				</div>
			)}
		</div>
	)
}

function EmptyHint() {
	return (
		<div className="rounded-md border border-dashed border-border p-6 text-center">
			<Terminal className="mx-auto h-6 w-6 text-muted-foreground" />
			<p className="mt-2 text-sm">type at least 2 characters to search.</p>
			<p className="mt-1 text-xs text-muted-foreground">
				queries match build output + deploy errors, ILIKE-style. results link to the per-deploy log
				viewer.
			</p>
		</div>
	)
}

function ResultRow({ row, q }: { row: Result; q: string }) {
	const highlighted = useMemo(() => highlight(row.snippet ?? '', q), [row.snippet, q])
	return (
		<Link
			href={`/deploys/${row.id}`}
			className="block rounded-md border border-border px-3 py-2.5 hover:bg-accent/30"
		>
			<div className="flex items-center gap-2 text-xs">
				<StatusBadge status={row.status} />
				<span className="font-mono text-foreground">{row.containerName}</span>
				<span className="text-muted-foreground">· {deployKindLabel(row.kind)}</span>
				{row.gitSha && (
					<span className="font-mono text-2xs text-muted-foreground">
						{row.gitBranch ? `${row.gitBranch} · ` : ''}
						{row.gitSha.slice(0, 7)}
					</span>
				)}
				<span className="ml-auto font-mono text-2xs text-muted-foreground">
					{formatDateTime(row.startedAt)}
				</span>
			</div>
			{row.snippet && (
				<pre
					className={`ph-no-capture mt-2 overflow-hidden rounded-md p-2 font-mono text-2xs leading-relaxed ${
						row.snippetSource === 'error'
							? 'bg-destructive/10 text-destructive'
							: 'bg-muted/40 text-muted-foreground'
					}`}
				>
					{highlighted}
				</pre>
			)}
		</Link>
	)
}

const BADGE_FOR_TONE = {
	success: 'success',
	warning: 'warning',
	destructive: 'destructive',
	info: 'info',
	neutral: 'outline',
} as const

function StatusBadge({ status }: { status: Result['status'] }) {
	const m = deployStatus(status)
	return <Badge variant={BADGE_FOR_TONE[m.tone]}>{m.label}</Badge>
}

// Splits `text` on case-insensitive occurrences of `q` and wraps matches in <mark>.
// Works on the raw text (React escapes it), so "amp" can't break HTML entities.
function highlight(text: string, q: string): React.ReactNode[] {
	if (!q) return [text]
	const lower = text.toLowerCase()
	const needle = q.toLowerCase()
	const out: React.ReactNode[] = []
	let pos = 0
	let idx = lower.indexOf(needle, pos)
	while (idx !== -1) {
		if (idx > pos) out.push(<Fragment key={`t${pos}`}>{text.slice(pos, idx)}</Fragment>)
		out.push(
			<mark key={`m${idx}`} className="bg-powder/30 text-foreground">
				{text.slice(idx, idx + needle.length)}
			</mark>,
		)
		pos = idx + needle.length
		idx = lower.indexOf(needle, pos)
	}
	if (pos < text.length) out.push(<Fragment key={`t${pos}`}>{text.slice(pos)}</Fragment>)
	return out
}
