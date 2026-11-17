'use client'

import { Alert } from '@/components/ui/alert'
import { SkeletonList } from '@/components/ui/skeleton'
// CI tab: last few GitHub Actions runs for this project's repo, with the
// latest failure translated into something a normal person can read. Click
// "diagnose with AI" on an unrecognized failure for an LLM-driven take.

import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { EmptyState } from '@/components/ui/empty-state'
import Link from 'next/link'
import {
	Activity,
	CheckCircle2,
	ChevronRight,
	Circle,
	ExternalLink,
	RefreshCw,
	Sparkles,
	XCircle,
} from 'lucide-react'
import { use, useEffect, useState } from 'react'
import { timeAgoDays } from '@/lib/format'

interface CiRun {
	id: number
	name: string
	displayTitle: string
	status: string
	conclusion: string | null
	htmlUrl: string
	headSha: string
	headBranch: string | null
	runNumber: number
	event: string
	createdAt: string
	runStartedAt: string | null
	updatedAt: string
}

interface CiDiagnosis {
	category: string
	oneLiner: string
	explanation: string
	action: string | null
	source: 'pattern' | 'llm' | 'unknown'
}

interface CiResponse {
	connected: boolean
	reason?: string
	owner?: string
	repo?: string
	branch?: string
	runs: CiRun[]
	latestFailedRunId: number | null
	latestFailureDiagnosis: CiDiagnosis | null
}

function durationOf(startedAt: string | null, finishedAt: string): string | null {
	if (!startedAt) return null
	const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
	if (ms <= 0) return null
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	return `${Math.floor(s / 60)}m ${s % 60}s`
}

export default function CiPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = use(params)
	const [data, setData] = useState<CiResponse | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)

	async function load() {
		try {
			const res = await fetch(`/api/projects/${id}/ci`)
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				setError(body.error ?? `HTTP ${res.status}`)
				return
			}
			setData((await res.json()) as CiResponse)
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'fetch failed')
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the project id changes; load is recreated every render and reads id itself
	useEffect(() => {
		load()
	}, [id])

	async function refresh() {
		setRefreshing(true)
		try {
			await load()
		} catch {
			// load keeps the last state on screen
		} finally {
			setRefreshing(false)
		}
	}

	if (error)
		return (
			<Alert tone="destructive" title="could not load">
				{error}
			</Alert>
		)
	if (!data) return <SkeletonList />
	if (!data.connected) {
		return data.reason === 'not_github' ? (
			<EmptyState icon={Activity} title="CI runs need a GitHub repo">
				this app's repo is not on GitHub, so there are no GitHub Actions runs to show.
			</EmptyState>
		) : (
			<EmptyState
				icon={Activity}
				title="connect GitHub to see CI runs"
				action={
					<Link href="/integrations" className={buttonVariants({ size: 'sm' })}>
						open integrations
					</Link>
				}
			>
				powder reads GitHub Actions runs with the GitHub account of whoever created this app. that
				account is not connected to powder (or its token expired).
			</EmptyState>
		)
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-base font-semibold tracking-tight">GitHub Actions</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						<a
							href={`https://github.com/${data.owner}/${data.repo}/actions`}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 hover:text-foreground"
						>
							{data.owner}/{data.repo}
							<ExternalLink className="h-3 w-3" />
						</a>{' '}
						· branch <span className="font-mono">{data.branch}</span> · {data.runs.length} runs
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
					<RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
					refresh
				</Button>
			</div>

			{data.latestFailureDiagnosis && data.latestFailedRunId !== null && (
				<FailureBanner
					projectId={id}
					runId={data.latestFailedRunId}
					diagnosis={data.latestFailureDiagnosis}
				/>
			)}

			{data.runs.length === 0 ? (
				<div className="rounded-md border border-dashed border-border p-6 text-sm">
					<p className="font-medium">No workflow runs yet</p>
					<p className="mt-1 text-muted-foreground">
						Push a commit to <span className="font-mono">{data.branch}</span> to trigger one, or
						check that the repo has a workflow file.
					</p>
				</div>
			) : (
				<div className="overflow-hidden rounded-md border border-border">
					{data.runs.map((r) => (
						<RunRow key={r.id} run={r} />
					))}
				</div>
			)}
		</div>
	)
}

function ConclusionIcon({ status, conclusion }: { status: string; conclusion: string | null }) {
	if (status !== 'completed') {
		return <Circle className="h-3.5 w-3.5 animate-pulse text-warning" />
	}
	if (conclusion === 'success') return <CheckCircle2 className="h-3.5 w-3.5 text-success" />
	if (conclusion === 'failure' || conclusion === 'timed_out')
		return <XCircle className="h-3.5 w-3.5 text-destructive" />
	if (conclusion === 'cancelled') return <Circle className="h-3.5 w-3.5 text-muted-foreground" />
	return <Circle className="h-3.5 w-3.5 text-muted-foreground" />
}

function RunRow({ run }: { run: CiRun }) {
	const dur = durationOf(run.runStartedAt, run.updatedAt)
	const label = run.status !== 'completed' ? run.status : (run.conclusion ?? 'unknown')
	return (
		<a
			href={run.htmlUrl}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 text-sm last:border-b-0 hover:bg-accent/30"
		>
			<ConclusionIcon status={run.status} conclusion={run.conclusion} />
			<span className="font-medium">#{run.runNumber}</span>
			<span className="truncate text-muted-foreground flex-1">{run.displayTitle}</span>
			<span className="font-mono text-2xs text-muted-foreground">{run.headSha.slice(0, 7)}</span>
			<span className="text-xs text-muted-foreground tabular-nums">{label}</span>
			{dur && <span className="text-xs text-muted-foreground tabular-nums">{dur}</span>}
			<span className="text-xs text-muted-foreground tabular-nums">
				{timeAgoDays(run.updatedAt)}
			</span>
			<ChevronRight className="h-3 w-3 text-muted-foreground" />
		</a>
	)
}

function FailureBanner({
	projectId,
	runId,
	diagnosis,
}: {
	projectId: string
	runId: number
	diagnosis: CiDiagnosis
}) {
	const [enhanced, setEnhanced] = useState<CiDiagnosis | null>(null)
	const [diagnosing, setDiagnosing] = useState(false)
	const [logTail, setLogTail] = useState<string | null>(null)
	const [showLog, setShowLog] = useState(false)

	const current = enhanced ?? diagnosis
	const isUnknown = current.source === 'unknown'

	async function runAiDiagnosis() {
		setDiagnosing(true)
		try {
			const res = await fetch(`/api/projects/${projectId}/ci/${runId}/diagnose`, {
				method: 'POST',
			})
			if (!res.ok) return
			const body = (await res.json()) as { diagnosis: CiDiagnosis; logTail: string }
			setEnhanced(body.diagnosis)
			setLogTail(body.logTail)
		} finally {
			setDiagnosing(false)
		}
	}

	return (
		<div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
			<div className="flex items-start gap-3">
				<XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex items-center gap-2 flex-wrap">
						<p className="font-medium text-foreground">{current.oneLiner}</p>
						<span className="rounded border border-border bg-background/40 px-1.5 py-0.5 text-2xs text-muted-foreground">
							{current.source === 'pattern'
								? 'known pattern'
								: current.source === 'llm'
									? 'AI diagnosis (model-generated, verify before running)'
									: 'unrecognized'}
						</span>
					</div>
					<p className="text-sm text-muted-foreground">{current.explanation}</p>
					{current.action &&
						(current.source === 'llm' ? (
							<p className="text-sm text-foreground/90">
								<span className="mr-1.5 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-2xs text-warning">
									model-generated, verify before running
								</span>
								{typeof current.action === 'string' ? current.action : ''}
							</p>
						) : (
							<p className="rounded bg-background/60 px-2 py-1 font-mono text-xs text-foreground/90">
								{current.action}
							</p>
						))}
					<div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
						{isUnknown && (
							<Button size="sm" variant="outline" onClick={runAiDiagnosis} disabled={diagnosing}>
								<Sparkles className="h-3 w-3" />
								{diagnosing ? 'thinking…' : 'diagnose with AI'}
							</Button>
						)}
						{logTail && (
							<Button size="sm" variant="ghost" onClick={() => setShowLog((v) => !v)}>
								{showLog ? 'hide log' : 'show log tail'}
							</Button>
						)}
					</div>
					{showLog && logTail && (
						<pre className="ph-no-capture max-h-80 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-2xs leading-snug whitespace-pre-wrap">
							{logTail}
						</pre>
					)}
				</div>
			</div>
		</div>
	)
}
