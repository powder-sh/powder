'use client'

import { Alert } from '@/components/ui/alert'
import { BackLink, PageHeader } from '@/components/ui/page-header'
import { StatusDot } from '@/components/ui/status'
import { SkeletonList } from '@/components/ui/skeleton'
import { use, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Download,
	RefreshCw,
	Undo2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/toast'
import { stripFailMarkers } from '@/lib/deploy-log'
import { deployKindLabel, deployStatus, triggeredByLabel } from '@/lib/deploy-status'
import { useRouter } from 'next/navigation'
import { AgentHelp } from '@/components/agent-help'
import { debugDeployPrompt } from '@/lib/agent-help-prompts'
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
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/cn'

interface Deploy {
	id: string
	serverId: string
	containerName: string
	kind: string
	status: 'queued' | 'running' | 'success' | 'failed'
	startedAt: string
	finishedAt: string | null
	output: string | null
	error: string | null
	triggeredBy: string | null
	gitSha: string | null
	gitBranch: string | null
	imageTag: string | null
	rolledBackFromId: string | null
	failedStep: string | null
	exitCode: number | null
	errorSummary: string | null
}

export default function DeployDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const { id: deployId } = use(params)
	// Keyed by the id: a redeploy or rollback navigates here with a new id, and every
	// piece of state (the deploy, an error, the stream, the open log section) starts over.
	return <DeployDetail key={deployId} deployId={deployId} />
}

function DeployDetail({ deployId }: { deployId: string }) {
	const [deploy, setDeploy] = useState<Deploy | null>(null)
	const [next, setNext] = useState<NextSteps>({
		appId: null,
		isLatest: false,
		lastGood: null,
		activeDeployId: null,
	})
	const [error, setError] = useState<string | null>(null)
	const [liveOutput, setLiveOutput] = useState<string>('')
	const [streamKey, setStreamKey] = useState(0)
	const sseRef = useRef<EventSource | null>(null)
	// characters received on this stream, and where the next connection
	// resumes (> 0 only after an `expired` event; other reconnects replay from 0).
	const receivedRef = useRef(0)
	const resumeRef = useRef(0)
	const [streamNote, setStreamNote] = useState<string | null>(null)

	// One load at a time: a newer one aborts the older, so a slow answer never
	// overwrites a newer one; leaving the page aborts the one in flight.
	const loadRef = useRef<AbortController | null>(null)
	async function load(): Promise<Deploy | null> {
		loadRef.current?.abort()
		const ctrl = new AbortController()
		loadRef.current = ctrl
		try {
			const res = await fetch(`/api/deploys/${deployId}`, { signal: ctrl.signal })
			if (!res.ok) {
				if (!ctrl.signal.aborted) setError(`failed to load (${res.status})`)
				return null
			}
			const data = (await res.json()) as { deploy: Deploy } & Partial<NextSteps>
			if (ctrl.signal.aborted) return null
			setError(null)
			setDeploy(data.deploy)
			setNext({
				appId: data.appId ?? null,
				isLatest: data.isLatest === true,
				lastGood: data.lastGood ?? null,
				activeDeployId: data.activeDeployId ?? null,
			})
			return data.deploy
		} catch {
			if (!ctrl.signal.aborted) setError('failed to load: network error')
			return null
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: the component is keyed by deployId; load is recreated every render and reads deployId itself
	useEffect(() => {
		void load()
		return () => loadRef.current?.abort()
	}, [deployId])

	// Subscribe to live SSE while the deploy is in flight. In worker mode a deploy
	// starts 'queued' (worker claims it within ~2s) then flips to 'running', so we
	// open the stream for both: the stream route holds the connection warm while
	// queued and starts emitting once the worker begins. Keyed on `active` (not the
	// deploy object) so a refetch doesn't tear down and re-open the stream.
	const active = deploy?.status === 'running' || deploy?.status === 'queued'
	// biome-ignore lint/correctness/useExhaustiveDependencies: load is stable enough, re-run only on stream lifecycle changes
	useEffect(() => {
		if (!active) return
		const from = resumeRef.current
		resumeRef.current = 0
		const es = new EventSource(deployStreamUrl(deployId, from))
		sseRef.current = es
		// A fresh stream replays from the start in worker mode, so start from a clean
		// buffer; a resumed one (after `expired`) continues the buffer it has.
		if (from === 0) {
			setLiveOutput('')
			receivedRef.current = 0
		} else receivedRef.current = from
		es.addEventListener('chunk', (e) => {
			const text = decodeChunk((e as MessageEvent).data)
			receivedRef.current += streamChars(text)
			setLiveOutput((curr) => curr + text)
		})
		// chunks are masked; resume from the raw offset the server reports.
		es.addEventListener(STREAM_OFFSET, (e) => {
			const n = streamOffset((e as MessageEvent).data)
			if (n !== null) receivedRef.current = n
		})
		// The stream hit its lifetime cap: the deploy is still running. Reconnect and
		// resume after what we have.
		es.addEventListener(STREAM_EXPIRED, () => {
			es.close()
			sseRef.current = null
			resumeRef.current = receivedRef.current
			setStreamKey((k) => k + 1)
		})
		es.addEventListener(STREAM_REVOKED, () => {
			es.close()
			sseRef.current = null
			setStreamNote(REVOKED_MESSAGE)
		})
		// On end, refetch: the reloaded row's `output` is the canonical full log. Keep
		// the streamed buffer on screen until the refetch lands so the log doesn't flash.
		es.addEventListener('end', (e) => {
			es.close()
			sseRef.current = null
			const final = deployEndStatus((e as MessageEvent).data)
			void load().then((d) => {
				if (d && (d.status === 'running' || d.status === 'queued') && final) {
					setDeploy({ ...d, status: final })
				}
				setLiveOutput('')
			})
		})
		// 'error' fires both for a server-sent error payload (has data) and for a
		// dropped connection (no data). Either way close, refetch, and if the deploy
		// is still in flight reconnect shortly.
		es.addEventListener('error', () => {
			es.close()
			sseRef.current = null
			void load().then((d) => {
				if (d && (d.status === 'running' || d.status === 'queued')) {
					setTimeout(() => setStreamKey((k) => k + 1), 2000)
				} else {
					setLiveOutput('')
				}
			})
		})
		return () => {
			es.close()
			sseRef.current = null
		}
	}, [active, deployId, streamKey])

	if (error) {
		return (
			<div className="space-y-4">
				<BackLink href="/deploys">deploys</BackLink>
				<Alert tone="destructive" title="could not load this deploy">
					{error}
				</Alert>
			</div>
		)
	}
	if (!deploy) {
		return <SkeletonList />
	}

	// While in flight show the streamed buffer (it replays from the start), falling back
	// to the stored partial output; never both, or the log doubles.
	const body = active ? liveOutput || (deploy.output ?? '') : (deploy.output ?? '')
	const fullOutput = stripFailMarkers((deploy.error ? `ERROR: ${deploy.error}\n\n` : '') + body)
	return (
		<div className="space-y-6">
			{streamNote && (
				<Alert tone="destructive" title="log stream stopped">
					{streamNote}
				</Alert>
			)}
			<title>{`deploy ${deploy.gitSha ? deploy.gitSha.slice(0, 7) : deployId.replace(/^dep_/, '').slice(0, 12)} · powder`}</title>
			<PageHeader
				back={{ href: '/deploys', label: 'deploys' }}
				title={
					<>
						<span>
							{deploy.containerName}
							<span className="ml-2 font-mono text-base font-normal text-muted-foreground">
								{deploy.gitSha
									? deploy.gitSha.slice(0, 7)
									: deployId.replace(/^dep_/, '').slice(0, 12)}
							</span>
						</span>
						<StatusBadge status={deploy.status} />
					</>
				}
				actions={
					<>
						{deploy.status === 'failed' && (next.isLatest || next.activeDeployId) && (
							<NextStepActions deploy={deploy} next={next} />
						)}
						<CopyLinkButton />
					</>
				}
				meta={
					<span className="text-xs">
						{deployKindLabel(deploy.kind)} ·{' '}
						<Link
							href={`/servers/${deploy.serverId}/${deploy.containerName}`}
							className="font-mono text-foreground underline-offset-2 hover:underline"
						>
							{deploy.containerName}
						</Link>
						{deploy.gitBranch && (
							<>
								{' '}
								· <span className="font-mono">{deploy.gitBranch}</span>
							</>
						)}
						{deploy.gitSha && (
							<>
								{' '}
								· <span className="font-mono">{deploy.gitSha.slice(0, 7)}</span>
							</>
						)}
						{triggeredByLabel(deploy.triggeredBy) && <> · {triggeredByLabel(deploy.triggeredBy)}</>}
						<> · started {formatDateTime(deploy.startedAt)}</>
						{deploy.finishedAt ? (
							<> · {duration(deploy.startedAt, deploy.finishedAt)}</>
						) : active ? (
							<>
								{' '}
								· <Elapsed since={deploy.startedAt} />
							</>
						) : null}
					</span>
				}
			/>

			{deploy.status === 'failed' && deploy.errorSummary && (
				<FailureBanner
					summary={deploy.errorSummary}
					failedStep={deploy.failedStep}
					exitCode={deploy.exitCode}
				/>
			)}

			{deploy.status === 'failed' && (
				<AgentHelp
					title="debug this deploy"
					description="run it in a checkout of this app's repo. it reads the failed stage and fixes the cause there."
					prompt={debugDeployPrompt({
						app: deploy.containerName,
						branch: deploy.gitBranch,
						sha: deploy.gitSha,
						failedStep: deploy.failedStep,
						exitCode: deploy.exitCode,
						summary: deploy.errorSummary,
						log: fullOutput,
					})}
					note="includes the failed stage and the last 80 log lines, with secrets masked. copy the full log below if your agent needs more."
				/>
			)}

			<LogViewer
				raw={fullOutput}
				live={active}
				deployId={deployId}
				failed={deploy.status === 'failed'}
			/>
		</div>
	)
}

// Stream payloads are JSON-stringified by the server; fall back to the raw text.
function decodeChunk(data: string): string {
	try {
		const v = JSON.parse(data)
		return typeof v === 'string' ? v : String(v)
	} catch {
		return data ?? ''
	}
}

function CopyLinkButton() {
	const [copied, setCopied] = useState(false)
	function copy() {
		if (typeof window === 'undefined') return
		navigator.clipboard.writeText(window.location.href).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}
	return (
		<Button variant="outline" size="sm" onClick={copy}>
			{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
			copy link
		</Button>
	)
}

function FailureBanner({
	summary,
	failedStep,
	exitCode,
}: {
	summary: string
	failedStep: string | null
	exitCode: number | null
}) {
	return (
		<div
			role="alert"
			className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3"
		>
			<div className="flex items-start gap-2.5">
				<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
				<div className="min-w-0 space-y-1">
					<p className="ph-no-capture break-words text-sm font-medium text-foreground">{summary}</p>
					{(failedStep || exitCode != null) && (
						<p className="font-mono text-2xs text-muted-foreground">
							{failedStep && <>failed at: {failedStep}</>}
							{failedStep && exitCode != null && ' · '}
							{exitCode != null && <>exit code {exitCode}</>}
						</p>
					)}
				</div>
			</div>
		</div>
	)
}

const BADGE_FOR_TONE = {
	success: 'success',
	warning: 'warning',
	destructive: 'destructive',
	info: 'info',
	neutral: 'outline',
} as const

function StatusBadge({ status }: { status: Deploy['status'] }) {
	const m = deployStatus(status)
	return (
		<Badge variant={BADGE_FOR_TONE[m.tone]}>
			{m.pulse && <StatusDot tone={m.tone} pulse className="h-1.5 w-1.5" />}
			{m.label}
		</Badge>
	)
}

interface NextSteps {
	appId: string | null
	isLatest: boolean
	lastGood: { id: string; gitSha: string | null } | null
	/** A newer deploy of this app that is still queued or building. */
	activeDeployId: string | null
}

// A failed deploy's way forward: build again, or put the last good image back.
// Same routes and confirmations as the app page and the container page.
function NextStepActions({ deploy, next }: { deploy: Deploy; next: NextSteps }) {
	const router = useRouter()
	const toast = useToast()
	const [confirm, setConfirm] = useState<'redeploy' | 'rollback' | null>(null)
	const [busy, setBusy] = useState(false)
	const good = next.lastGood
	const goodLabel = good ? (good.gitSha ? good.gitSha.slice(0, 7) : 'last good deploy') : ''

	async function run(kind: 'redeploy' | 'rollback') {
		setBusy(true)
		try {
			const res =
				kind === 'redeploy'
					? await fetch(`/api/projects/${next.appId}/redeploy`, { method: 'POST' })
					: await fetch(
							`/api/servers/${encodeURIComponent(deploy.serverId)}/containers/${encodeURIComponent(deploy.containerName)}/rollback`,
							{
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ targetDeployId: good?.id }),
							},
						)
			const data = (await res.json().catch(() => ({}))) as { deployId?: string; error?: string }
			if (!res.ok) {
				toast.error(`${kind} failed: ${data.error ?? res.status}`)
				return
			}
			setConfirm(null)
			if (data.deployId) router.push(`/deploys/${data.deployId}`)
		} catch {
			toast.error(`${kind} failed: network error`)
		} finally {
			setBusy(false)
		}
	}

	const running = !!next.activeDeployId
	return (
		<>
			{running && (
				<Link
					href={`/deploys/${next.activeDeployId}`}
					className="self-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					a deploy is running
				</Link>
			)}
			{next.appId && (
				<Button size="sm" disabled={running} onClick={() => setConfirm('redeploy')}>
					<RefreshCw className="h-3.5 w-3.5" />
					redeploy
				</Button>
			)}
			{good && (
				<Button
					variant="outline"
					size="sm"
					disabled={running}
					onClick={() => setConfirm('rollback')}
				>
					<Undo2 className="h-3.5 w-3.5" />
					roll back to <span className="font-mono">{goodLabel}</span>
				</Button>
			)}
			<ConfirmDialog
				open={confirm === 'redeploy'}
				title={`redeploy ${deploy.containerName}?`}
				description="pulls the branch again, builds, health-checks the result and swaps it in. the running version keeps serving until then."
				confirmLabel="redeploy"
				loading={busy}
				onConfirm={() => void run('redeploy')}
				onClose={() => setConfirm(null)}
			/>
			<ConfirmDialog
				open={confirm === 'rollback'}
				title={`roll back to ${goodLabel}?`}
				description="recreates the container with the previously built image of that deploy. nothing is rebuilt."
				confirmLabel="roll back"
				danger
				loading={busy}
				onConfirm={() => void run('rollback')}
				onClose={() => setConfirm(null)}
			/>
		</>
	)
}

interface Section {
	name: string
	body: string
}

function parseSections(text: string): Section[] {
	// Sections look like: `── name ──\n... body ...`
	// We split on the marker and pair name with the following body.
	const re = /──\s+([^─\n]+?)\s+──/g
	const parts: Section[] = []
	let lastEnd = 0
	let lastName: string | null = null
	const matches: { name: string; idx: number; len: number }[] = []
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		matches.push({ name: (m[1] ?? '').trim(), idx: m.index, len: m[0].length })
	}
	if (matches.length === 0) return [{ name: 'output', body: text }]

	// preamble (text before first marker)
	const first = matches[0]
	if (first && first.idx > 0) {
		const preamble = text.slice(0, first.idx).trimEnd()
		if (preamble) parts.push({ name: 'preamble', body: preamble })
	}

	for (const [i, cur] of matches.entries()) {
		const next = matches[i + 1]
		const bodyStart = cur.idx + cur.len
		const bodyEnd = next ? next.idx : text.length
		parts.push({ name: cur.name, body: text.slice(bodyStart, bodyEnd).trim() })
		lastEnd = bodyEnd
		lastName = cur.name
	}
	void lastEnd
	void lastName
	return parts
}

// Phones wrap long lines so the error is readable without sideways scrolling;
// wider screens keep one log line per row.
const LOG_PRE =
	'overflow-auto bg-background font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] sm:whitespace-pre sm:[overflow-wrap:normal]'

function LogViewer({
	raw,
	live,
	deployId,
	failed = false,
}: {
	raw: string
	live: boolean
	deployId: string
	failed?: boolean
}) {
	const sections = useMemo(() => parseSections(raw), [raw])
	// A failed deploy opens on its last section: that is where it broke. While
	// streaming the last section follows the output until someone picks one.
	const lastKey =
		sections.length > 0 ? sections[sections.length - 1].name + (sections.length - 1) : null
	const [picked, setPicked] = useState<string | null | undefined>(undefined)
	const openSection = picked !== undefined ? picked : failed || live ? lastKey : null
	const [showRaw, setShowRaw] = useState(false)
	const [copied, setCopied] = useState(false)
	const tailRef = useRef<HTMLPreElement | null>(null)

	// Keep the open streaming section scrolled to its newest line.
	// biome-ignore lint/correctness/useExhaustiveDependencies: raw is the trigger, every new chunk scrolls
	useEffect(() => {
		if (live && tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight
	}, [live, raw])

	function copy() {
		navigator.clipboard.writeText(raw).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}

	function download() {
		const blob = new Blob([raw], { type: 'text/plain' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `deploy-${deployId.replace(/^dep_/, '')}.log`
		a.click()
		URL.revokeObjectURL(url)
	}

	return (
		<div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
			<div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
				<div className="flex items-center gap-2 text-2xs text-muted-foreground">
					{live && (
						<span className="inline-flex items-center gap-1.5">
							<StatusDot tone="warning" pulse className="h-1.5 w-1.5" />
							streaming
						</span>
					)}
					{sections.length > 1 && !live && `${sections.length} sections`}
				</div>
				<div className="flex items-center gap-1">
					<Button variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)}>
						{showRaw ? 'sections' : 'raw'}
					</Button>
					<Button variant="ghost" size="sm" onClick={copy} title="copy the full deploy log">
						{copied ? (
							<>
								<Check className="h-3 w-3 text-success" />
								<span className="hidden sm:inline">copied</span>
							</>
						) : (
							<>
								<Copy className="h-3 w-3" />
								<span className="hidden sm:inline">copy</span>
							</>
						)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={download}
						title="download the full deploy log as a .txt file"
					>
						<Download className="h-3 w-3" />
						<span className="hidden sm:inline">download</span>
					</Button>
				</div>
			</div>
			{showRaw || sections.length === 1 ? (
				<pre ref={live ? tailRef : undefined} className={cn('ph-no-capture', LOG_PRE, 'max-h-[70vh] p-4')}>
					{raw || (live ? 'waiting for output…' : '(no output)')}
				</pre>
			) : (
				<div className="divide-y divide-border">
					{sections.map((s, i) => {
						const key = s.name + i
						const isOpen = openSection === key
						const streamingHere = live && key === lastKey
						const lines = s.body ? s.body.split('\n').length : 0
						return (
							// the key is name + position: section names repeat (a step can print the same marker twice), and the list is parsed in log order, so name + position is the identity
							<div key={key}>
								<button
									type="button"
									aria-expanded={isOpen}
									onClick={() => setPicked(isOpen ? null : key)}
									className="flex min-h-10 w-full items-center gap-2 px-3 py-2.5 text-left text-xs transition-colors hover:bg-accent/40"
								>
									{isOpen ? (
										<ChevronDown className="h-3 w-3 text-muted-foreground" />
									) : (
										<ChevronRight className="h-3 w-3 text-muted-foreground" />
									)}
									<span className="font-mono">{s.name}</span>
									{streamingHere && <StatusDot tone="warning" pulse className="h-1.5 w-1.5" />}
									<span className="ml-auto text-2xs tabular-nums text-muted-foreground">
										{lines} {lines === 1 ? 'line' : 'lines'}
									</span>
								</button>
								{isOpen && (
									<pre
										ref={streamingHere ? tailRef : undefined}
										className={cn('ph-no-capture', LOG_PRE, 'max-h-[60vh] border-t border-border px-4 py-3 sm:px-8')}
									>
										{s.body || (streamingHere ? 'waiting for output…' : '(empty)')}
									</pre>
								)}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}

// Ticks once a second while a deploy runs: "running for 1m 12s".
function Elapsed({ since }: { since: string }) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	}, [])
	const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000))
	const text = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
	return <span className="tabular-nums">running for {text}</span>
}

function duration(startISO: string, endISO: string): string {
	try {
		const ms = new Date(endISO).getTime() - new Date(startISO).getTime()
		if (ms < 1000) return `${ms}ms`
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
		return `${Math.round(ms / 60_000)}m`
	} catch {
		return ''
	}
}
