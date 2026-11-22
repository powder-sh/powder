'use client'

// CI tab. First powder's own checks: the last git deploys of this app with the
// stage each one stopped at and the test gate result each deploy recorded, plus a
// notice when the last successful deploy is recorded as never tested. Then GitHub
// Actions, only for the repo's own active workflows (lib/ci-runs.ts): a run that is
// not the deployed commit is shown muted and never turns anything red. "diagnose with AI" is offered on an
// unrecognized failure of a current run only. The two parts load separately, so a
// slow or failing GitHub never holds the checks.

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { CopyButton } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionHeader } from '@/components/ui/page-header'
import { SkeletonList } from '@/components/ui/skeleton'
import { StatusLabel } from '@/components/ui/status'
import { deployDuration } from '@/lib/apps-table'
import type { CiTestGate, GateDisplay } from '@/lib/ci-checks'
import { deployKindBadge, deployStatus } from '@/lib/deploy-status'
import { formatDuration, timeAgo, timeAgoDays } from '@/lib/format'
import {
	Activity,
	CheckCircle2,
	ChevronRight,
	Circle,
	ExternalLink,
	RefreshCw,
	Rocket,
	Sparkles,
	XCircle,
} from 'lucide-react'
import Link from 'next/link'
import { use, useEffect, useState } from 'react'
import { deployListAt } from '@/lib/deploy-order'
import { summaryBeyondStep } from '@/lib/notify-text'

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
	notDeployed: boolean
}

interface CiDiagnosis {
	category: string
	oneLiner: string
	explanation: string
	action: string | null
	source: 'pattern' | 'llm' | 'unknown'
}

interface CheckRow {
	id: string
	kind: string
	status: string
	sha: string | null
	/** status failed, failed_step "superseded": lost to a newer deploy, did nothing */
	superseded: boolean
	/** when the deploy was asked for; the list orders and dates by it (lib/deploy-order.ts) */
	queuedAt?: string | null
	startedAt: string
	finishedAt: string | null
	failedStep: string | null
	exitCode: number | null
	errorSummary: string | null
	testGate: CiTestGate
	/** from the route (lib/ci-checks.ts gateDisplay): the gate badge and the failed stage */
	gateBadge: GateDisplay['badge']
	failedAt: GateDisplay['failedAt']
}

interface Checks {
	rows: CheckRow[]
	summary: string
	noTestGate: boolean
	deployedSha: string | null
}

interface GithubPart {
	connected: boolean
	commitMessages?: Record<string, string>
	reason?: string
	owner?: string
	repo?: string
	branch?: string
	workflows?: 'known' | 'unknown'
	activeWorkflows?: number
	droppedRuns?: number
	runs: CiRun[]
	latestFailedRunId?: number | null
	latestFailureDiagnosis?: CiDiagnosis | null
}

function durationOf(startedAt: string | null, finishedAt: string): string | null {
	if (!startedAt) return null
	const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
	if (ms <= 0) return null
	return formatDuration(ms)
}

// The GitHub part when its request failed: the same line as unreadable workflows.
const GITHUB_UNREADABLE: GithubPart = { connected: true, workflows: 'unknown', runs: [] }

export default function CiPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = use(params)
	const [checks, setChecks] = useState<Checks | null>(null)
	const [github, setGithub] = useState<GithubPart | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)

	async function loadChecks() {
		try {
			const res = await fetch(`/api/projects/${id}/ci?part=checks`)
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				setError(body.error ?? `HTTP ${res.status}`)
				return
			}
			setChecks(((await res.json()) as { checks: Checks }).checks)
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'fetch failed')
		}
	}

	async function loadGithub() {
		try {
			const res = await fetch(`/api/projects/${id}/ci?part=github`)
			setGithub(res.ok ? ((await res.json()) as GithubPart) : GITHUB_UNREADABLE)
		} catch {
			setGithub(GITHUB_UNREADABLE)
		}
	}

	async function load() {
		await Promise.all([loadChecks(), loadGithub()])
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
	if (!checks) return <SkeletonList />

	return (
		<div className="space-y-8">
			<ChecksSection
				projectId={id}
				checks={checks}
				commitMessages={github?.commitMessages ?? {}}
				actions={
					<Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
						<RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
						refresh
					</Button>
				}
			/>
			{github ? (
				<GithubSection projectId={id} data={github} />
			) : (
				<section className="space-y-3">
					<SectionHeader title="GitHub Actions" />
					<SkeletonList />
				</section>
			)}
		</div>
	)
}

// ── powder checks ────────────────────────────────────────────────────────────

function ChecksSection({
	projectId,
	checks,
	commitMessages,
	actions,
}: {
	projectId: string
	checks: Checks
	commitMessages: Record<string, string>
	actions: React.ReactNode
}) {
	return (
		<section className="space-y-3">
			<SectionHeader title="powder checks" description={checks.summary} actions={actions} />
			{checks.noTestGate && (
				<Alert tone="warning" title="no test gate">
					the last successful deploy had no <span className="font-mono">.powder/test.sh</span>:
					nothing tests or typechecks a commit before it replaces the running app.{' '}
					<Link
						href="/docs/deploys#steps-in-order"
						className="underline underline-offset-2 hover:text-foreground"
					>
						how the test gate works
					</Link>
				</Alert>
			)}
			{checks.rows.length === 0 ? (
				<EmptyState icon={Rocket} title="no deploys yet" compact>
					push to the configured branch to trigger one. every deploy shows up here with the stage it
					reached.
				</EmptyState>
			) : (
				<ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
					{checks.rows.map((r) => (
						<CheckRowItem
							key={r.id}
							projectId={projectId}
							row={r}
							commitMessage={r.sha ? (commitMessages[r.sha] ?? null) : null}
							deployedSha={checks.deployedSha}
						/>
					))}
				</ul>
			)}
		</section>
	)
}

const isFailure = (row: CheckRow) => row.failedAt !== null

// The recorded gate (deploys.test_gate) as a badge; the route decided which one.
function gateBadge(row: CheckRow): React.ReactNode {
	if (row.gateBadge === 'passed') return <Badge variant="success">test gate passed</Badge>
	if (row.gateBadge === 'failed') return <Badge variant="destructive">test gate failed</Badge>
	if (row.gateBadge === 'none') return <Badge variant="warning">no test gate</Badge>
	return null
}

function CheckRowItem({
	projectId,
	row,
	commitMessage,
	deployedSha,
}: {
	projectId: string
	row: CheckRow
	commitMessage: string | null
	deployedSha: string | null
}) {
	const st = deployStatus(row.status)
	const dur = deployDuration(row)
	const kindBadge = deployKindBadge(row.kind)
	const isDeployed = row.sha !== null && row.sha === deployedSha && row.status === 'success'
	const gate = gateBadge(row)
	// the second line: badges and the failed step; on a phone it also carries the duration
	const meta = !!kindBadge || isDeployed || !!gate || isFailure(row)
	const failureText = isFailure(row)
		? [
				`${row.sha ? `${row.sha.slice(0, 7)} ` : ''}failed at ${row.failedAt}${row.exitCode !== null ? ` (exit ${row.exitCode})` : ''}`,
				summaryBeyondStep(row.failedAt, row.errorSummary),
			]
				.filter(Boolean)
				.join('\n')
		: null
	return (
		// the copy control is a sibling of the row link (no button inside a link)
		<li className="group relative">
			<Link
				href={`/projects/${projectId}/deployments#${row.id}`}
				className="flex flex-col gap-1.5 px-4 py-3 text-sm transition-colors hover:bg-accent/40"
			>
				<div className="flex min-w-0 items-center gap-3">
					{row.superseded ? (
						// lost to a newer deploy and did nothing: not a failure, never red
						<StatusLabel tone="neutral" className="w-20 shrink-0 text-xs sm:w-24">
							superseded
						</StatusLabel>
					) : (
						<StatusLabel tone={st.tone} pulse={st.pulse} className="w-20 shrink-0 text-xs sm:w-24">
							{st.label}
						</StatusLabel>
					)}
					<span className="shrink-0 font-mono text-xs">{row.sha ? row.sha.slice(0, 7) : '-'}</span>
					<span className="min-w-0 flex-1 truncate text-muted-foreground">
						{commitMessage ?? ''}
					</span>
					<span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
						{dur ?? ''}
					</span>
					<span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
						{timeAgo(String(deployListAt(row)))}
					</span>
					<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
				</div>
				{(meta || dur) && (
					<div
						// a failed row keeps room for the copy button placed over its bottom-right corner
						className={`flex flex-wrap items-center gap-1.5 text-xs sm:pl-[6.75rem] ${meta ? '' : 'sm:hidden'} ${failureText ? 'pr-10 sm:pr-8' : ''}`}
					>
						{kindBadge && <Badge variant="outline">{kindBadge}</Badge>}
						{isDeployed && <Badge variant="powder">deployed</Badge>}
						{gate}
						{isFailure(row) && (
							<span className="ph-no-capture text-destructive">
								failed at {row.failedAt}
								{row.exitCode !== null && (
									<span className="text-muted-foreground"> (exit {row.exitCode})</span>
								)}
							</span>
						)}
						{dur && <span className="text-muted-foreground tabular-nums sm:hidden">{dur}</span>}
					</div>
				)}
				{/* the summary beyond the step: "failed at <step>" is on the line above */}
				{isFailure(row) && summaryBeyondStep(row.failedAt, row.errorSummary) && (
					<p className="ph-no-capture line-clamp-2 break-words pr-10 text-xs text-muted-foreground sm:pl-[6.75rem] sm:pr-8">
						{summaryBeyondStep(row.failedAt, row.errorSummary)}
					</p>
				)}
			</Link>
			{failureText && (
				<CopyButton
					value={failureText}
					label="copy the failed step and error summary"
					reveal
					className="absolute bottom-1.5 right-2 sm:bottom-2 sm:right-3"
				/>
			)}
		</li>
	)
}

// ── GitHub Actions ───────────────────────────────────────────────────────────

function GithubSection({ projectId, data }: { projectId: string; data: GithubPart }) {
	if (!data.connected) {
		return (
			<section className="space-y-3">
				<SectionHeader title="GitHub Actions" />
				{data.reason === 'not_github' ? (
					<EmptyState icon={Activity} title="GitHub Actions need a GitHub repo" compact>
						this app's repo is not on GitHub, so there are no GitHub Actions runs to show.
					</EmptyState>
				) : (
					<EmptyState
						icon={Activity}
						title="connect GitHub to see GitHub Actions runs"
						compact
						action={
							<Link href="/integrations" className={buttonVariants({ size: 'sm' })}>
								open integrations
							</Link>
						}
					>
						powder reads GitHub Actions runs with the GitHub account of whoever created this app.
						that account is not connected to powder (or its token expired).
					</EmptyState>
				)}
			</section>
		)
	}

	const repoLink = (
		<a
			href={`https://github.com/${data.owner}/${data.repo}/actions`}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1 hover:text-foreground"
		>
			{data.owner}/{data.repo}
			<ExternalLink className="h-3 w-3" />
		</a>
	)

	// No active workflow (or GitHub did not list them): old runs are not shown at all.
	if (data.workflows !== 'known' || (data.activeWorkflows ?? 0) === 0) {
		return (
			<p className="flex flex-wrap items-center gap-x-1.5 border-t border-border pt-4 text-xs text-muted-foreground">
				<Activity className="h-3.5 w-3.5" aria-hidden />
				{data.workflows === 'known'
					? 'no GitHub Actions workflows in'
					: 'could not read the GitHub Actions workflows of'}{' '}
				{repoLink}
			</p>
		)
	}

	const notDeployed = data.runs.filter((r) => r.notDeployed).length
	return (
		<section className="space-y-3">
			<SectionHeader
				title="GitHub Actions"
				description={
					<>
						{repoLink} · branch <span className="font-mono">{data.branch}</span> ·{' '}
						{data.activeWorkflows} {data.activeWorkflows === 1 ? 'workflow' : 'workflows'} ·{' '}
						{data.runs.length} runs
						{notDeployed > 0 && `, ${notDeployed} not the deployed commit`}
					</>
				}
			/>

			{data.latestFailureDiagnosis && data.latestFailedRunId != null && (
				<FailureBanner
					projectId={projectId}
					runId={data.latestFailedRunId}
					diagnosis={data.latestFailureDiagnosis}
				/>
			)}

			{data.runs.length === 0 ? (
				<EmptyState icon={Activity} title="no recent runs of an active workflow" compact>
					the latest runs on <span className="font-mono">{data.branch}</span> belong to workflows
					that were deleted or disabled or to GitHub's built-in ones, or there are none yet.
				</EmptyState>
			) : (
				<ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
					{data.runs.map((r) => (
						<RunRow key={r.id} run={r} />
					))}
				</ul>
			)}
		</section>
	)
}

function ConclusionIcon({ run }: { run: CiRun }) {
	// a run that is not the deployed commit is never red or green: it says nothing about what runs
	if (run.notDeployed) return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
	if (run.status !== 'completed') {
		return <Circle className="h-3.5 w-3.5 shrink-0 animate-pulse text-warning" />
	}
	if (run.conclusion === 'success')
		return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
	if (run.conclusion === 'failure' || run.conclusion === 'timed_out')
		return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
	return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
}

function RunRow({ run }: { run: CiRun }) {
	const dur = durationOf(run.runStartedAt, run.updatedAt)
	const label = run.status !== 'completed' ? run.status : (run.conclusion ?? 'unknown')
	return (
		<li>
			<a
				href={run.htmlUrl}
				target="_blank"
				rel="noreferrer"
				className="flex flex-col gap-1.5 px-4 py-3 text-sm transition-colors hover:bg-accent/40"
			>
				<div className="flex min-w-0 items-center gap-3">
					<ConclusionIcon run={run} />
					<span
						className={`shrink-0 font-medium ${run.notDeployed ? 'text-muted-foreground' : ''}`}
					>
						#{run.runNumber}
					</span>
					<span className="min-w-0 flex-1 truncate text-muted-foreground">{run.displayTitle}</span>
					<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
						{timeAgoDays(run.updatedAt)}
					</span>
					<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
				</div>
				<div className="flex flex-wrap items-center gap-1.5 pl-[1.625rem] text-xs text-muted-foreground">
					<span className="font-mono text-2xs">{run.headSha.slice(0, 7)}</span>
					{run.notDeployed ? (
						<Badge variant="secondary" title={`this run: ${label}`}>
							not the deployed commit
						</Badge>
					) : (
						<span className="tabular-nums">{label}</span>
					)}
					{dur && <span className="tabular-nums">{dur}</span>}
				</div>
			</a>
		</li>
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
						<p className="ph-no-capture font-medium text-foreground">{current.oneLiner}</p>
						<span className="rounded border border-border bg-background/40 px-1.5 py-0.5 text-2xs text-muted-foreground">
							{current.source === 'pattern'
								? 'known pattern'
								: current.source === 'llm'
									? 'AI diagnosis (model-generated, verify before running)'
									: 'unrecognized'}
						</span>
						<CopyButton
							value={[current.oneLiner, current.explanation].filter(Boolean).join('\n')}
							label="copy the failure summary"
						/>
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
							<div className="flex items-start gap-1">
								<p className="min-w-0 flex-1 break-words rounded bg-background/60 px-2 py-1 font-mono text-xs text-foreground/90">
									{current.action}
								</p>
								{current.action && (
									<CopyButton value={current.action} label="copy the suggested fix" />
								)}
							</div>
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
						{showLog && logTail && (
							<CopyButton
								value={logTail}
								label="copy the log tail"
								text="copy log"
								targetId={`ci-log-${runId}`}
								size="sm"
							/>
						)}
					</div>
					{showLog && logTail && (
						<pre
							id={`ci-log-${runId}`}
							className="ph-no-capture max-h-80 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-2xs leading-snug whitespace-pre-wrap">
							{logTail}
						</pre>
					)}
				</div>
			</div>
		</div>
	)
}
