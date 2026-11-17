'use client'

import { SkeletonList } from '@/components/ui/skeleton'
// Cross-fleet deploy stream, Vercel-style. Newest first. Filterable by author,
// repo, branch, status. Each row → link to /deploys/[id] for the full output.

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { EmptyState } from '@/components/ui/empty-state'
import { Input, Select } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { StatusLabel } from '@/components/ui/status'
import { cn } from '@/lib/cn'
import { ExternalLink, GitBranch, RefreshCw, Rocket, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { timeAgo } from '@/lib/format'
import { DEPLOY_STATUS, deployKindBadge, deployStatus, triggeredByLabel } from '@/lib/deploy-status'

interface DeployRow {
	id: string
	sha: string | null
	shortSha: string | null
	branch: string | null
	status: string
	queuedAt: string
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	containerName: string
	serverId: string
	appRepoId: string | null
	repoSlug: string | null
	defaultBranch: string | null
	environment: 'production' | 'preview' | 'unknown'
	kind: string
	triggeredBy: string | null
	author: string | null
	authorAvatarLogin: string | null
	commitMessage: string | null
	errorSummary: string | null
	/** Set while a queued push is held on the settle window (lib/deploy-settle.ts). */
	waiting?: string | null
}

function fmtDuration(ms: number | null): string {
	if (ms === null) return '-'
	if (ms < 1000) return `${ms}ms`
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	const rs = s % 60
	return `${m}m ${rs}s`
}

function StatusPill({ status }: { status: string }) {
	const m = deployStatus(status)
	return (
		<StatusLabel tone={m.tone} pulse={m.pulse} className="text-xs">
			{m.label}
		</StatusLabel>
	)
}

function EnvPill({ env }: { env: 'production' | 'preview' | 'unknown' }) {
	if (env === 'production') return <Badge variant="outline">production</Badge>
	if (env === 'preview') return <Badge variant="info">preview</Badge>
	return null
}

export default function DeploysPage() {
	// useSearchParams needs a Suspense boundary for static prerendering.
	return (
		<Suspense fallback={<SkeletonList />}>
			<DeploysView />
		</Suspense>
	)
}

function DeploysView() {
	const router = useRouter()
	const searchParams = useSearchParams()
	const [rows, setRows] = useState<DeployRow[] | null>(null)
	const [nextCursor, setNextCursor] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [err, setErr] = useState<string | null>(null)

	// Filter state (mirrors Vercel "All Authors / All Repositories / All Branches")
	const [author, setAuthor] = useState(() => searchParams.get('author') ?? '')
	const [repo, setRepo] = useState(() => searchParams.get('repo') ?? '')
	const [branch, setBranch] = useState(() => searchParams.get('branch') ?? '')
	const [status, setStatus] = useState(() => searchParams.get('status') ?? '')
	const [q, setQ] = useState('')

	// Keep the URL in sync with the filters so back-nav restores them.
	useEffect(() => {
		const p = new URLSearchParams()
		if (author) p.set('author', author)
		if (repo) p.set('repo', repo)
		if (branch) p.set('branch', branch)
		if (status) p.set('status', status)
		const next = p.toString()
		if (next !== searchParams.toString()) {
			router.replace(next ? `?${next}` : '?', { scroll: false })
		}
	}, [author, repo, branch, status, router, searchParams])

	const buildQuery = useCallback(
		(cursor: string | null) => {
			const p = new URLSearchParams()
			p.set('limit', '50')
			if (cursor) p.set('cursor', cursor)
			if (author.trim()) p.set('author', author.trim())
			if (repo.trim()) p.set('repo', repo.trim())
			if (branch.trim()) p.set('branch', branch.trim())
			if (status) p.set('status', status)
			return p.toString()
		},
		[author, repo, branch, status],
	)

	const load = useCallback(
		async function loadFirst() {
			setBusy(true)
			setErr(null)
			try {
				const res = await fetch(`/api/deploys-list?${buildQuery(null)}`)
				if (!res.ok) {
					setErr(`HTTP ${res.status}`)
					setBusy(false)
					return
				}
				const data = (await res.json()) as { deploys: DeployRow[]; nextCursor: string | null }
				setRows(data.deploys)
				setNextCursor(data.nextCursor)
			} catch (e) {
				setErr(e instanceof Error ? e.message : 'load failed')
			}
			setBusy(false)
		},
		[buildQuery],
	)

	async function loadMore() {
		if (!nextCursor) return
		setBusy(true)
		try {
			const res = await fetch(`/api/deploys-list?${buildQuery(nextCursor)}`)
			const data = (await res.json()) as { deploys: DeployRow[]; nextCursor: string | null }
			setRows((prev) => [...(prev ?? []), ...data.deploys])
			setNextCursor(data.nextCursor)
		} catch {
			/* ignore */
		}
		setBusy(false)
	}

	useEffect(() => {
		load()
	}, [load])

	// Dropdown options accumulate across loads so picking one filter doesn't
	// shrink the others (rows are already filtered server-side).
	const [seen, setSeen] = useState<{ authors: string[]; repos: string[]; branches: string[] }>({
		authors: [],
		repos: [],
		branches: [],
	})
	useEffect(() => {
		if (!rows) return
		setSeen((prev) => {
			const authors = new Set(prev.authors)
			const repos = new Set(prev.repos)
			const branches = new Set(prev.branches)
			for (const r of rows) {
				if (r.authorAvatarLogin) authors.add(r.authorAvatarLogin)
				if (r.containerName) repos.add(r.containerName)
				if (r.branch) branches.add(r.branch)
			}
			if (
				authors.size === prev.authors.length &&
				repos.size === prev.repos.length &&
				branches.size === prev.branches.length
			)
				return prev
			return {
				authors: [...authors].sort(),
				repos: [...repos].sort(),
				branches: [...branches].sort(),
			}
		})
	}, [rows])
	const filterOptions = useMemo(() => {
		const withSel = (list: string[], sel: string) =>
			sel && !list.includes(sel) ? [...list, sel].sort() : list
		return {
			authors: withSel(seen.authors, author),
			repos: withSel(seen.repos, repo),
			branches: withSel(seen.branches, branch),
		}
	}, [seen, author, repo, branch])

	const visibleRows = useMemo(() => {
		const needle = q.trim().toLowerCase()
		if (!rows || !needle) return rows
		return rows.filter((r) =>
			[r.containerName, r.repoSlug, r.branch, r.commitMessage, r.author, r.authorAvatarLogin]
				.filter(Boolean)
				.some((v) => (v as string).toLowerCase().includes(needle)),
		)
	}, [rows, q])

	const anyFilter = author || repo || branch || status

	return (
		<div className="space-y-5">
			<title>deploys · powder</title>
			<PageHeader
				title="deploys"
				description="every deploy on all servers, newest first. open one for the full build log."
				actions={
					<Button variant="outline" size="sm" onClick={load} disabled={busy}>
						<RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
						refresh
					</Button>
				}
			/>

			{/* Filter bar */}
			<div className="flex flex-wrap items-center gap-2">
				<Select
					selectSize="sm"
					className="max-w-[12rem]"
					aria-label="filter by author"
					value={author}
					onChange={(e) => setAuthor(e.target.value)}
				>
					<option value="">all authors</option>
					{filterOptions.authors.map((a) => (
						<option key={a} value={a}>
							{a}
						</option>
					))}
				</Select>
				<Select
					selectSize="sm"
					className="max-w-[12rem]"
					aria-label="filter by app"
					value={repo}
					onChange={(e) => setRepo(e.target.value)}
				>
					<option value="">all apps</option>
					{filterOptions.repos.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</Select>
				<Select
					selectSize="sm"
					className="max-w-[12rem]"
					aria-label="filter by branch"
					value={branch}
					onChange={(e) => setBranch(e.target.value)}
				>
					<option value="">all branches</option>
					{filterOptions.branches.map((b) => (
						<option key={b} value={b}>
							{b}
						</option>
					))}
				</Select>
				<Select
					selectSize="sm"
					className="max-w-[12rem]"
					aria-label="filter by status"
					value={status}
					onChange={(e) => setStatus(e.target.value)}
				>
					<option value="">all statuses</option>
					{(['success', 'failed', 'running', 'queued'] as const).map((k) => (
						<option key={k} value={k}>
							{DEPLOY_STATUS[k].label}
						</option>
					))}
				</Select>
				{anyFilter && (
					<button
						type="button"
						onClick={() => {
							setAuthor('')
							setRepo('')
							setBranch('')
							setStatus('')
						}}
						className={buttonVariants({ variant: 'ghost', size: 'sm' })}
					>
						clear filters
					</button>
				)}
				<div className="relative w-full sm:ml-auto sm:w-56">
					<Search
						className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						type="search"
						aria-label="filter loaded deploys"
						placeholder="filter this list"
						inputSize="sm"
						className="pl-8"
						value={q}
						onChange={(e) => setQ(e.target.value)}
					/>
				</div>
			</div>

			{err && (
				<Alert tone="destructive" title="could not load deploys">
					{err}
				</Alert>
			)}

			{rows === null ? (
				<SkeletonList />
			) : rows.length === 0 ? (
				anyFilter ? (
					<EmptyState
						compact
						title="no deploys match these filters"
						action={
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									setAuthor('')
									setRepo('')
									setBranch('')
									setStatus('')
								}}
							>
								clear filters
							</Button>
						}
					/>
				) : (
					<EmptyState
						icon={Rocket}
						title="no deploys yet"
						action={
							<Link href="/new" className={buttonVariants()}>
								new app
							</Link>
						}
					>
						every <span className="font-mono text-foreground">git push</span> to a connected app
						shows up here with its status, duration and a link to the full log.
					</EmptyState>
				)
			) : (
				<div className="space-y-3">
					{(visibleRows ?? []).length === 0 && (
						<EmptyState compact title={`nothing loaded matches "${q}"`} />
					)}
					{(visibleRows ?? []).length > 0 && (
						<ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
							{(visibleRows ?? []).map((r) => {
								const kind = deployKindBadge(r.kind)
								const by = triggeredByLabel(r.triggeredBy)
								return (
									<li key={r.id} className="relative transition-colors hover:bg-accent/40">
										<Link
											href={`/deploys/${r.id}`}
											aria-label={`open deploy ${r.shortSha ?? r.id} of ${r.containerName}`}
											className="absolute inset-0"
										/>
										<div className="pointer-events-none relative flex items-start gap-3 px-4 py-3 text-sm sm:items-center sm:gap-4">
											<div className="w-20 shrink-0 pt-0.5 sm:w-24 sm:pt-0">
												<StatusPill status={r.status} />
												<div className="mt-0.5 pl-3.5 text-2xs tabular-nums text-muted-foreground">
													{fmtDuration(r.durationMs)}
												</div>
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex min-w-0 items-center gap-2">
													<span className="truncate font-medium">{r.commitMessage ?? r.containerName}</span>
													{kind && <Badge variant="outline">{kind}</Badge>}
												</div>
												<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
													{r.commitMessage && (
														<span className="font-medium text-foreground">{r.containerName}</span>
													)}
													{r.repoSlug && r.sha ? (
														<a
															href={`https://github.com/${r.repoSlug}/commit/${r.sha}`}
															target="_blank"
															rel="noreferrer"
															className="pointer-events-auto relative -my-3 inline-flex min-h-10 items-center gap-1 font-mono hover:text-foreground sm:my-0 sm:min-h-0"
														>
															{r.shortSha}
															<ExternalLink className="h-2.5 w-2.5" />
														</a>
													) : (
														r.shortSha && <span className="font-mono">{r.shortSha}</span>
													)}
													{r.branch && (
														<span className="inline-flex items-center gap-1">
															<GitBranch className="h-3 w-3" />
															{r.branch}
														</span>
													)}
													<EnvPill env={r.environment} />
													{by && <span className="truncate sm:hidden">{by}</span>}
												</div>
												{r.waiting && <div className="mt-1.5 text-xs text-muted-foreground">{r.waiting}</div>}
												{r.status === 'failed' && r.errorSummary && (
													<div
														className="ph-no-capture mt-1.5 line-clamp-2 text-xs text-destructive"
														title={r.errorSummary}
													>
														{r.errorSummary}
													</div>
												)}
											</div>
											<div className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
												<div>{timeAgo(r.startedAt)}</div>
												{by && <div className="mt-0.5 max-w-48 truncate">{by}</div>}
											</div>
											<div className="shrink-0 text-xs text-muted-foreground sm:hidden">
												{timeAgo(r.startedAt)}
											</div>
										</div>
									</li>
								)
							})}
						</ul>
					)}

					{nextCursor && (
						<div className="text-center pt-2">
							<Button variant="outline" size="sm" onClick={loadMore} loading={busy}>
								{busy ? 'loading…' : 'load more'}
							</Button>
						</div>
					)}
				</div>
			)}
		</div>
	)
}
