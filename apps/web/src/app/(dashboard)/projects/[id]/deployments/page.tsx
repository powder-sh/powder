'use client'

// Full deploys list with expand-to-see-output. SSE-streams live output for
// running deploys. The hash anchor (#dep_xxx) on entry expands that row so
// linking from elsewhere "jumps" to a specific deploy.

import { CopyButton } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusLabel } from '@/components/ui/status'
import { cn } from '@/lib/cn'
import { ChevronRight, Rocket } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { deployKindLabel, deployStatus } from '@/lib/deploy-status'
import { failedDeployCopyFromRow } from '@/lib/deploy-copy'
import Link from 'next/link'
import {
	REVOKED_MESSAGE,
	STREAM_EXPIRED,
	STREAM_REVOKED,
	deployEndStatus,
	deployStreamUrl,
	streamChars,
	STREAM_OFFSET,
	streamOffset,
} from '@/lib/stream-events'
import { type Deploy, timeAgo, useProject } from '../_lib/project-context'
import { formatDateTime, waitedLabel } from '@/lib/format'
import { deployCommitLabel } from '@/lib/deploy-commit'
import { deployListAt } from '@/lib/deploy-order'
import { summaryBeyondStep } from '@/lib/notify-text'

export default function DeploymentsPage() {
	const { deploys, reload, project } = useProject()
	const [expandedDeploy, setExpandedDeploy] = useState<string | null>(null)

	// Auto-expand from #dep_xxx URL hash on first render.
	useEffect(() => {
		const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
		if (hash) setExpandedDeploy(hash)
	}, [])

	if (deploys.length === 0) {
		return (
			<EmptyState icon={Rocket} title="no deploys yet">
				push to the configured branch to trigger one, or use redeploy above.
			</EmptyState>
		)
	}

	return (
		<ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
			{deploys.map((d) => {
				const expanded = expandedDeploy === d.id
				return (
					<li key={d.id} id={d.id} className="scroll-mt-24">
						<button
							type="button"
							aria-expanded={expanded}
							onClick={() => setExpandedDeploy(expanded ? null : d.id)}
							className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40"
						>
							<ChevronRight
								className={cn(
									'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
									expanded && 'rotate-90',
								)}
								aria-hidden="true"
							/>
							<StatusLabel
								tone={deployStatus(d.status).tone}
								pulse={deployStatus(d.status).pulse}
								className="w-20 shrink-0 text-xs sm:w-24"
							>
								{deployStatus(d.status).label}
							</StatusLabel>
							<span className="font-mono text-xs">{deployCommitLabel(d) ?? '-'}</span>
							{d.gitBranch && (
								<span className="hidden truncate text-xs text-muted-foreground sm:inline">
									{d.gitBranch}
								</span>
							)}
							<span className="ml-auto shrink-0 text-right text-xs text-muted-foreground">
								{timeAgo(String(deployListAt(d)))}
							</span>
							<span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:inline">
								{deployKindLabel(d.kind)}
							</span>
						</button>
						{expanded && (
							<DeployBody deploy={d} reload={reload} app={project?.containerName ?? ''} />
						)}
					</li>
				)
			})}
		</ul>
	)
}

function DeployBody({ deploy, reload, app }: { deploy: Deploy; reload: () => void; app: string }) {
	const [liveOutput, setLiveOutput] = useState('')
	const [liveStatus, setLiveStatus] = useState<string | null>(null)
	// an `expired` stream reconnects (streamKey) and resumes after the
	// characters already received; `revoked` stops with a sign-in note.
	const [streamKey, setStreamKey] = useState(0)
	const receivedRef = useRef(0)

	// biome-ignore lint/correctness/useExhaustiveDependencies: streamKey re-opens the stream on purpose
	useEffect(() => {
		if (deploy.status !== 'running' && deploy.status !== 'queued') return
		const es = new EventSource(deployStreamUrl(deploy.id, receivedRef.current))
		es.addEventListener('chunk', (e) => {
			const data = JSON.parse((e as MessageEvent).data) as string
			receivedRef.current += streamChars(data)
			setLiveOutput((prev) => prev + data)
		})
		// chunks are masked; resume from the raw offset the server reports.
		es.addEventListener(STREAM_OFFSET, (e) => {
			const n = streamOffset((e as MessageEvent).data)
			if (n !== null) receivedRef.current = n
		})
		es.addEventListener(STREAM_EXPIRED, () => {
			es.close()
			setStreamKey((k) => k + 1)
		})
		es.addEventListener(STREAM_REVOKED, () => {
			es.close()
			setLiveOutput((prev) => `${prev}\n[stream] ${REVOKED_MESSAGE}`)
		})
		es.addEventListener('end', (e) => {
			setLiveStatus(deployEndStatus((e as MessageEvent).data) ?? 'done')
			es.close()
			reload()
		})
		es.addEventListener('error', (e) => {
			try {
				setLiveOutput(
					(prev) =>
						`${prev}\n[error] ${JSON.parse((e as MessageEvent).data ?? '"connection lost"')}`,
				)
			} catch {
				// EventSource error events without data - silently ignore.
			}
			es.close()
		})
		return () => es.close()
	}, [deploy.id, deploy.status, reload, streamKey])

	const active = deploy.status === 'running' || deploy.status === 'queued'
	// Keep live output on screen until the reload returns a finished deploy.
	const isLive = active
	// A failure shows its summary, step and exit code, then the END of its log, where the
	// cause is (the API sends only that tail); the full log is on the deploy page.
	const isFailure = !isLive && deploy.status === 'failed'
	const showText = isLive
		? liveOutput ||
			(liveStatus ? 'finishing…' : deploy.status === 'queued' ? (deploy.waiting ?? 'queued…') : 'connecting…')
		: isFailure
			? deploy.logTail || 'no log recorded'
			: (deploy.outputPreview ?? (liveOutput || 'no output recorded'))
	// Copy only real text: never a placeholder like "connecting…".
	const copyable = isFailure || (isLive ? !!liveOutput : !!(deploy.outputPreview ?? liveOutput))
	const textId = `deploy-text-${deploy.id}`
	// the tail opens scrolled to its end: the cause is in the last lines
	const preRef = useRef<HTMLPreElement | null>(null)
	useEffect(() => {
		if (isFailure && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
	}, [isFailure])

	// a summary that already names the step ("failed during: <step>") is not followed by
	// "failed at: <step>" as well
	const stepShown =
		deploy.failedStep && (!deploy.errorSummary || summaryBeyondStep(deploy.failedStep, deploy.errorSummary) === deploy.errorSummary.trim())
			? deploy.failedStep
			: null
	return (
		<div className="border-t border-border bg-muted/40 px-4 py-3 font-mono text-xs">
			{isFailure && (deploy.errorSummary || deploy.failedStep || deploy.exitCode != null) && (
				<div className="mb-3 space-y-0.5 font-sans">
					{deploy.errorSummary && (
						<p className="ph-no-capture break-words text-sm font-medium text-destructive">{deploy.errorSummary}</p>
					)}
					{(stepShown || deploy.exitCode != null) && (
						<p className="ph-no-capture font-mono text-2xs text-muted-foreground">
							{stepShown && <>failed at: {stepShown}</>}
							{stepShown && deploy.exitCode != null && ' · '}
							{deploy.exitCode != null && <>exit code {deploy.exitCode}</>}
						</p>
					)}
				</div>
			)}
			<div className="space-y-1">
				<div className="flex min-h-6 items-center justify-between gap-2">
					<span className={`font-medium ${isFailure ? 'text-destructive' : 'text-muted-foreground'}`}>
						{isLive
							? liveStatus
								? 'output'
								: 'live output'
							: isFailure
								? deploy.logCut
									? 'end of the log'
									: 'log'
								: 'output (preview)'}
					</span>
					<span className="flex items-center gap-2">
						{isFailure && (
							<Link
								href={`/deploys/${deploy.id}`}
								className="font-sans text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
							>
								full log
							</Link>
						)}
						{copyable && (
							<CopyButton
								value={() => (isFailure ? failedDeployCopyFromRow(app, deploy) : showText)}
								label={isFailure ? 'copy error with app, deploy, commit and failed step' : 'copy output'}
								text="copy"
								targetId={textId}
								size="xs"
							/>
						)}
					</span>
				</div>
				<pre
					id={textId}
					ref={preRef}
					className="ph-no-capture max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 leading-relaxed text-foreground/90"
				>
					{showText}
				</pre>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
				{deploy.queuedAt && <span>queued {formatDateTime(deploy.queuedAt)}</span>}
				{deploy.status !== 'queued' && <span>started {formatDateTime(deploy.startedAt)}</span>}
				{deploy.status !== 'queued' && waitedLabel(deploy.queuedAt, deploy.startedAt) && (
					<span>{waitedLabel(deploy.queuedAt, deploy.startedAt)}</span>
				)}
				{deploy.finishedAt && <span>finished {formatDateTime(deploy.finishedAt)}</span>}
				{deploy.imageTag && <span className="truncate">image: {deploy.imageTag}</span>}
			</div>
		</div>
	)
}
