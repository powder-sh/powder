'use client'

import { remoteState } from '@/lib/git-remote-state'
import { Alert } from '@/components/ui/alert'
import { StatusDot } from '@/components/ui/status'
import { ChevronLeft } from 'lucide-react'
import { SkeletonList } from '@/components/ui/skeleton'
import { use, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { ServerUnreachable } from '@/components/server-unreachable'
import {
	Eye,
	EyeOff,
	GitBranch,
	Plus,
	RotateCcw,
	Rocket,
	Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Input, Textarea } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { RepoCard } from '@/components/repo-card'
import { CronsCard } from '@/components/crons-card'
import { AppDomainsCard } from '@/components/app-domains-card'
import { PreviewsCard } from '@/components/previews-card'
import { TrafficCard } from '@/components/traffic-card'
import { LiveLogsCard } from '@/components/live-logs-card'
import { parseRawEnv, serializeEnv } from '@/lib/env-parse'
import { formatDateTime } from '@/lib/format'
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

interface Detail {
	name: string
	image: string
	state: string
	status: string
	startedAt: string
	createdAt: string
	restartPolicy: string
	restartCount: number
	ports: string[]
	env: { key: string; value: string }[]
	mounts: { source: string; destination: string }[]
	compose: {
		project: string | null
		service: string | null
		workingDir: string | null
		configFile: string | null
	}
}

interface EnvFile {
	supported: boolean
	reason?: string
	kind?: string
	autoApply?: boolean
	path?: string
	exists?: boolean
	candidates?: string[]
	/** `differs`: the running container has another value (computed server-side on raw values). */
	entries?: { key: string; value: string; differs?: boolean }[]
}

interface DeployRow {
	id: string
	serverId: string
	containerName: string
	kind: 'env_change' | 'image_update' | 'manual_apply' | 'restart' | 'git_deploy' | 'rollback' | 'stop' | 'delete'
	status: 'queued' | 'running' | 'success' | 'failed'
	startedAt: string
	finishedAt: string | null
	output: string | null
	error: string | null
	triggeredBy: string | null
	gitSha?: string | null
	gitBranch?: string | null
	imageTag?: string | null
	rolledBackFromId?: string | null
	snapshotUrl?: string | null
	snapshotExpiresAt?: string | null
	/** Set while a queued push is held on the settle window (lib/deploy-settle.ts). */
	waiting?: string | null
}

interface GitStatus {
	supported: boolean
	reason?: string
	workingDir?: string
	isRepo?: boolean
	branch?: string | null
	currentSha?: string | null
	upstreamSha?: string | null
	dirty?: boolean
	checkout?: 'src' | 'workdir' | 'none' | 'src-link' | 'unknown'
	checkoutDir?: string | null
	staleWorkdirGit?: boolean
	upstreamError?: string | null
}

type Entry = { key: string; value: string; id: number }

let entryIdSeed = 0
const newId = () => ++entryIdSeed

export default function ContainerPage({
	params,
}: {
	params: Promise<{ id: string; name: string }>
}) {
	const { id, name } = use(params)
	const toast = useToast()
	const [detail, setDetail] = useState<Detail | null>(null)
	const [error, setError] = useState<string | null>(null)
	// 503 from inspect: the server did not answer over SSH.
	const [unreachable, setUnreachable] = useState(false)
	const [loading, setLoading] = useState(true)
	const [restarting, setRestarting] = useState(false)
	const [confirmAction, setConfirmAction] = useState<
		| { kind: 'restart' }
		| { kind: 'apply' }
		| { kind: 'deploy' }
		| { kind: 'rollback'; targetId: string }
		| null
	>(null)

	const [envFile, setEnvFile] = useState<EnvFile | null>(null)
	const [envScope, setEnvScope] = useState<'production' | 'preview'>('production')
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState<Entry[]>([])
	const [saving, setSaving] = useState(false)
	const [applying, setApplying] = useState(false)

	const [deployHistory, setDeployHistory] = useState<DeployRow[] | null>(null)
	const [serverName, setServerName] = useState<string | null>(null)
	useEffect(() => {
		fetch('/api/servers/list')
			.then((r) => (r.ok ? r.json() : null))
			.then((d: { servers?: { id: string; name: string }[] } | null) =>
				setServerName(d?.servers?.find((s) => s.id === id)?.name ?? null),
			)
			.catch(() => {})
	}, [id])
	const [expandedDeploy, setExpandedDeploy] = useState<string | null>(null)

	const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
	const [deploying, setDeploying] = useState(false)
	const [rollingBackId, setRollingBackId] = useState<string | null>(null)

	const [liveDeploy, setLiveDeploy] = useState<{
		id: string
		kind: string
		lines: string[]
		status: 'queued' | 'running' | 'success' | 'failed'
		error?: string
	} | null>(null)
	const deployStreamRef = useRef<EventSource | null>(null)
	// characters of the live deploy stream received so far (an
	// `expired` stream resumes after them).
	const deployReceivedRef = useRef(0)

	async function loadDetail() {
		setLoading(true)
		setError(null)
		try {
			// Masked on load: values are revealed per key on click (revealEnvValue).
			const res = await fetch(`/api/servers/${id}/containers/${name}/inspect`)
			const data = await res.json().catch(() => ({}))
			setUnreachable(res.status === 503)
			if (!res.ok) {
				setError(data.error ?? `failed (${res.status})`)
				return
			}
			setDetail(data)
		} catch {
			setError('failed: network error')
		} finally {
			setLoading(false)
		}
	}

	async function loadEnvFile(scope: 'production' | 'preview' = envScope) {
		const res = await fetch(`/api/servers/${id}/containers/${name}/env-file?scope=${scope}`)
		const data = (await res.json()) as EnvFile
		setEnvFile(data)
	}

	// One value, on an explicit click. The server allows reveal only for an
	// admin browser session (canReveal) and returns every other entry masked.
	async function revealEnvValue(
		source: 'env-file' | 'inspect',
		key: string,
	): Promise<string | null> {
		const qs = new URLSearchParams({ reveal: '1', key })
		if (source === 'env-file') qs.set('scope', envScope)
		const res = await fetch(`/api/servers/${id}/containers/${name}/${source}?${qs}`)
		const data = (await res.json().catch(() => ({}))) as {
			error?: string
			entries?: { key: string; value: string }[]
			env?: { key: string; value: string }[]
		}
		if (!res.ok) {
			toast.error(`reveal failed: ${data.error ?? res.status}`)
			return null
		}
		const list = source === 'env-file' ? data.entries : data.env
		return list?.find((e) => e.key === key)?.value ?? null
	}

	async function loadDeploys() {
		const res = await fetch(`/api/servers/${id}/containers/${name}/deploys`)
		if (!res.ok) {
			setDeployHistory([])
			return
		}
		const data = (await res.json()) as { deploys: DeployRow[] }
		setDeployHistory(data.deploys)
	}

	async function loadGitStatus() {
		const res = await fetch(`/api/servers/${id}/containers/${name}/git-status`)
		const data = (await res.json()) as GitStatus
		setGitStatus(data)
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the server or container changes; the loaders are recreated every render and read id and name themselves
	useEffect(() => {
		loadDetail()
		loadEnvFile()
		loadDeploys()
		loadGitStatus()
	}, [id, name])

	useEffect(() => {
		return () => {
			deployStreamRef.current?.close()
			deployStreamRef.current = null
		}
	}, [])

	function openDeployStream(deployId: string, kind: string, resumeFrom = 0) {
		// close any existing stream
		deployStreamRef.current?.close()
		deployStreamRef.current = null

		if (resumeFrom === 0) {
			setLiveDeploy({ id: deployId, kind, lines: [], status: 'running' })
			deployReceivedRef.current = 0
		}

		const es = new EventSource(deployStreamUrl(deployId, resumeFrom))
		// The stream hit its lifetime cap while the deploy runs on: resume after the
		// characters we have. Never read as the deploy finishing.
		es.addEventListener(STREAM_EXPIRED, () => {
			es.close()
			deployStreamRef.current = null
			openDeployStream(deployId, kind, deployReceivedRef.current)
		})
		es.addEventListener(STREAM_REVOKED, () => {
			es.close()
			deployStreamRef.current = null
			setLiveDeploy((prev) =>
				prev && prev.id === deployId
					? { ...prev, lines: [...prev.lines, `[stream] ${REVOKED_MESSAGE}`] }
					: prev,
			)
		})
		// chunks are masked; resume from the raw offset the server reports.
		es.addEventListener(STREAM_OFFSET, (e) => {
			const n = streamOffset((e as MessageEvent).data)
			if (n !== null) deployReceivedRef.current = n
		})
		es.addEventListener('chunk', (e) => {
			try {
				const chunk = JSON.parse((e as MessageEvent).data) as string
				deployReceivedRef.current += streamChars(chunk)
				const newLines = chunk.split('\n').filter((l) => l.length > 0)
				setLiveDeploy((prev) =>
					prev && prev.id === deployId
						? { ...prev, lines: [...prev.lines, ...newLines].slice(-5000) }
						: prev,
				)
			} catch {
				// ignore
			}
		})
		es.addEventListener('end', (e) => {
			// Only a real final status changes the badge; anything else leaves it to the
			// reloads below (never assume success).
			const final = deployEndStatus((e as MessageEvent).data)
			if (final)
				setLiveDeploy((prev) => (prev && prev.id === deployId ? { ...prev, status: final } : prev))
			es.close()
			deployStreamRef.current = null
			loadDetail()
			loadDeploys()
			loadGitStatus()
		})
		es.addEventListener('error', (e) => {
			let msg = 'stream error'
			try {
				msg = JSON.parse((e as MessageEvent).data) as string
			} catch {
				// connection error: leave status running until end fires
				if (es.readyState === EventSource.CLOSED) {
					setLiveDeploy((prev) =>
						prev && prev.id === deployId
							? { ...prev, status: 'failed', error: 'stream closed' }
							: prev,
					)
				}
				return
			}
			setLiveDeploy((prev) =>
				prev && prev.id === deployId ? { ...prev, status: 'failed', error: msg } : prev,
			)
			es.close()
			deployStreamRef.current = null
			loadDeploys()
		})
		deployStreamRef.current = es
	}

	async function doRestart() {
		setRestarting(true)
		try {
			const res = await fetch(`/api/servers/${id}/containers/${name}/restart`, {
				method: 'POST',
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok) {
				toast.error(`restart failed: ${data.error ?? res.status}`)
				return
			}
			toast.success(`${name} restarted`)
		} catch {
			toast.error('restart failed: network error')
			return
		} finally {
			setRestarting(false)
		}
		await Promise.all([loadDetail(), loadDeploys()])
	}

	async function doRollback(targetId: string) {
		setRollingBackId(targetId)
		let deployId: string | null = null
		try {
			const res = await fetch(`/api/servers/${id}/containers/${name}/rollback`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ targetDeployId: targetId }),
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok) toast.error(`rollback failed: ${data.error ?? res.status}`)
			else deployId = data.deployId
		} catch {
			toast.error('rollback failed: network error')
		} finally {
			setRollingBackId(null)
		}
		if (deployId) openDeployStream(deployId, 'rollback')
		await loadDeploys()
	}

	async function doDeployFromGit() {
		setDeploying(true)
		let deployId: string | null = null
		try {
			const res = await fetch(`/api/servers/${id}/containers/${name}/git-deploy`, {
				method: 'POST',
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok) toast.error(`deploy failed: ${data.error ?? res.status}`)
			else deployId = data.deployId
		} catch {
			toast.error('deploy failed: network error')
		} finally {
			setDeploying(false)
		}
		if (deployId) openDeployStream(deployId, 'git_deploy')
		await loadDeploys()
	}

	function restart() {
		setConfirmAction({ kind: 'restart' })
	}
	function rollback(targetId: string) {
		setConfirmAction({ kind: 'rollback', targetId })
	}
	function deployFromGit() {
		setConfirmAction({ kind: 'deploy' })
	}

	// Editing needs the real values (saving masked ones would overwrite the
	// secrets), so the editor loads them revealed, on this explicit click only.
	async function startEdit() {
		let entries: { key: string; value: string }[] = []
		if (envFile?.exists) {
			const res = await fetch(
				`/api/servers/${id}/containers/${name}/env-file?scope=${envScope}&reveal=1`,
			)
			const data = (await res.json().catch(() => ({}))) as EnvFile & { error?: string }
			if (!res.ok) {
				toast.error(`cannot edit: ${data.error ?? res.status}`)
				return
			}
			entries = data.entries ?? []
		}
		setDraft(entries.map((e) => ({ ...e, id: newId() })))
		setEditing(true)
	}

	function cancelEdit() {
		setEditing(false)
		setDraft([])
	}

	async function save() {
		setSaving(true)
		try {
			const res = await fetch(`/api/servers/${id}/containers/${name}/env-file?scope=${envScope}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					entries: draft.map(({ key, value }) => ({ key, value })),
					path: envFile?.path,
				}),
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok) {
				toast.error(`save failed: ${data.error ?? res.status}`)
				return
			}
			toast.success('env file saved')
		} catch {
			toast.error('save failed: network error')
			return
		} finally {
			setSaving(false)
		}
		await loadEnvFile()
		setEditing(false)
	}

	async function doApply() {
		setApplying(true)
		let deployId: string
		try {
			const res = await fetch(`/api/servers/${id}/containers/${name}/apply`, {
				method: 'POST',
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok) {
				toast.error(`apply failed: ${data.error ?? res.status}`)
				return
			}
			deployId = data.deployId
		} catch {
			toast.error('apply failed: network error')
			return
		} finally {
			setApplying(false)
		}
		openDeployStream(deployId, 'manual_apply')
		await loadDeploys()
	}

	function apply() {
		setConfirmAction({ kind: 'apply' })
	}

	const deployBusy = liveDeploy?.status === 'running' || liveDeploy?.status === 'queued'

	if (loading) return <SkeletonList />
	if (unreachable)
		return (
			<div className="space-y-6">
				<title>{`${name} · powder`}</title>
				<BackLink />
				<div className="min-w-0">
					<h1 className="break-all text-2xl font-semibold tracking-tight">{name}</h1>
					<p className="mt-1 text-xs text-muted-foreground">
						on{' '}
						<Link href={`/servers/${encodeURIComponent(id)}`} className="hover:text-foreground">
							{serverName ?? id}
						</Link>
					</p>
				</div>
				<ServerUnreachable
					serverId={id}
					serverName={serverName ?? 'this server'}
					error={error}
					what="its state, logs and env"
					onRetry={loadDetail}
				/>
			</div>
		)
	if (error || !detail)
		return (
			<div className="space-y-4">
				<title>{`${name} · powder`}</title>
				<BackLink />
				<Alert
					tone="destructive"
					title={`could not load ${name}`}
					action={
						<Link
							href={`/servers/${encodeURIComponent(id)}`}
							className="text-sm font-medium text-foreground underline underline-offset-2"
						>
							open {serverName ?? 'server'}
						</Link>
					}
				>
					<span className="ph-no-capture font-mono text-xs">{error ?? 'container not found'}</span>
					<span className="mt-1 block text-xs">
						powder reads this page live from {serverName ?? 'the server'} over SSH. if the server is
						unreachable, its page says why.
					</span>
				</Alert>
			</div>
		)

	const confirmContent = (() => {
		if (!confirmAction) return null
		if (confirmAction.kind === 'restart') {
			return {
				title: `restart ${name}?`,
				description: 'the container is stopped and started again with the same image.',
				confirmLabel: 'restart',
				danger: false,
				onConfirm: doRestart,
			}
		}
		if (confirmAction.kind === 'apply') {
			return {
				title: `recreate ${name} with new envs?`,
				description:
					'the container briefly drops while compose recreates it with the new env file.',
				confirmLabel: 'apply',
				danger: true,
				onConfirm: doApply,
			}
		}
		if (confirmAction.kind === 'deploy') {
			return {
				title: `deploy ${name} from git?`,
				description:
					'git pull → docker build → recreate. takes a couple minutes. container drops briefly at the end.',
				confirmLabel: 'deploy',
				danger: false,
				onConfirm: doDeployFromGit,
			}
		}
		const targetId = confirmAction.targetId
		return {
			title: 'rollback to this deploy?',
			description:
				'recreates the container with the previously-built image of the selected deploy.',
			confirmLabel: 'rollback',
			danger: true,
			onConfirm: () => doRollback(targetId),
		}
	})()

	const drift = (envFile?.entries ?? []).filter((e) => e.differs).length

	return (
		<div className="space-y-6">
			<title>{`${detail.name} · powder`}</title>
			<BackLink />

			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="break-all text-2xl font-semibold tracking-tight">{detail.name}</h1>
						<StateBadge state={detail.state} />
					</div>
					<p className="mt-1 break-all font-mono text-xs text-muted-foreground">{detail.image}</p>
					<p className="mt-1 text-xs text-muted-foreground">
						on{' '}
						<Link href={`/servers/${encodeURIComponent(id)}`} className="hover:text-foreground">
							{serverName ?? id}
						</Link>{' '}
						· restart policy{' '}
						<span className="font-mono">{detail.restartPolicy}</span> · {detail.restartCount}{' '}
						restarts
					</p>
					<GitInline status={gitStatus} />
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={restart}
						disabled={restarting || deploying || deployBusy}
					>
						<RotateCcw className={`h-3 w-3 ${restarting ? 'animate-spin' : ''}`} />
						{restarting ? 'restarting…' : 'restart'}
					</Button>
					<Button
						size="sm"
						onClick={deployFromGit}
						disabled={deploying || restarting || deployBusy || !canDeployFromGit(gitStatus)}
						title={deployHint(gitStatus)}
					>
						<Rocket className={`h-3 w-3 ${deploying ? 'animate-pulse' : ''}`} />
						{deploying ? 'deploying…' : 'deploy'}
					</Button>
				</div>
			</div>

			{liveDeploy && (
				<Card>
					<CardHeader>
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2.5">
								<CardTitle>{liveDeploy.kind.replace('_', ' ')}</CardTitle>
								{liveDeploy.status === 'running' ? (
									<span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
										<StatusDot tone="warning" pulse className="h-1.5 w-1.5" />
										live
									</span>
								) : liveDeploy.status === 'success' ? (
									<Badge variant="success">success</Badge>
								) : (
									<Badge variant="destructive">failed</Badge>
								)}
							</div>
							{(liveDeploy.error || liveDeploy.lines.length > 0) && (
								<CopyButton
									value={() =>
										[liveDeploy.error, liveDeploy.lines.join('\n')].filter(Boolean).join('\n\n')
									}
									label="copy the deploy output"
									text="copy"
									size="sm"
									className="ml-auto"
								/>
							)}
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									deployStreamRef.current?.close()
									deployStreamRef.current = null
									setLiveDeploy(null)
								}}
							>
								dismiss
							</Button>
						</div>
					</CardHeader>
					<CardContent>
						{liveDeploy.error && (
							<p className="ph-no-capture mb-2 text-xs text-destructive">{liveDeploy.error}</p>
						)}
						{liveDeploy.lines.length === 0 ? (
							<p className="text-sm text-muted-foreground">connecting…</p>
						) : (
							<pre className="ph-no-capture max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-2xs leading-relaxed">
								{liveDeploy.lines.join('\n')}
							</pre>
						)}
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle>overview</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3 text-sm">
					<KV k="status" v={detail.status} />
					<KV k="started" v={fmt(detail.startedAt)} />
					<KV k="created" v={fmt(detail.createdAt)} />
					<KV k="ports" v={detail.ports.length ? detail.ports.join(', ') : '-'} />
					<KV
						k="mounts"
						v={
							detail.mounts.length
								? detail.mounts.map((m) => `${m.source} → ${m.destination}`).join(' · ')
								: '-'
						}
					/>
					{detail.compose.project && (
						<>
							<KV k="compose" v={`${detail.compose.project} / ${detail.compose.service}`} />
							{detail.compose.configFile && <KV k="config" v={detail.compose.configFile} />}
						</>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<div className="flex items-center justify-between gap-3">
						<div>
							<CardTitle>env</CardTitle>
							<div className="mt-1 flex items-center gap-2">
								<div className="flex rounded-md border border-border p-0.5 text-xs">
									<button
										type="button"
										onClick={async () => {
											if (editing) cancelEdit()
											setEnvScope('production')
											await loadEnvFile('production')
										}}
										className={`rounded px-2.5 py-0.5 text-2xs ${envScope === 'production' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
									>
										production
									</button>
									<button
										type="button"
										onClick={async () => {
											if (editing) cancelEdit()
											setEnvScope('preview')
											await loadEnvFile('preview')
										}}
										className={`rounded px-2.5 py-0.5 text-2xs ${envScope === 'preview' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
									>
										preview
									</button>
								</div>
								{envFile?.path && (
									<span className="font-mono text-2xs text-muted-foreground">{envFile.path}</span>
								)}
							</div>
							{envScope === 'preview' && (
								<p className="mt-1 text-2xs text-muted-foreground">
									preview deploys merge production + these overrides. changes apply on the next
									preview deploy.
								</p>
							)}
						</div>
						<EnvHeaderActions
							envFile={envFile}
							editing={editing}
							saving={saving}
							applying={applying}
							busy={deployBusy}
							drift={drift}
							onEdit={startEdit}
							onCancel={cancelEdit}
							onSave={save}
							onApply={apply}
						/>
					</div>
				</CardHeader>
				<CardContent>
					{!envFile ? (
						<SkeletonList rows={2} bare />
					) : !envFile.supported ? (
						<LiveEnvFallback
							onReveal={(k) => revealEnvValue('inspect', k)}
							entries={detail.env}
							reason={`not editable here: ${envFile.reason ?? envFile.kind ?? 'unsupported'}`}
						/>
					) : !envFile.exists && !editing ? (
						<EmptyEnvFile
							path={envFile.path ?? ''}
							liveEntries={detail.env}
							onStart={startEdit}
							onReveal={(k) => revealEnvValue('inspect', k)}
						/>
					) : editing ? (
						<EnvEditor draft={draft} onChange={setDraft} />
					) : (
						<EnvList
							entries={envFile.entries ?? []}
							drift={drift}
							onReveal={(k) => revealEnvValue('env-file', k)}
						/>
					)}
				</CardContent>
			</Card>

			<RepoCard serverId={id} containerName={name} />

			<TrafficCard serverId={id} containerName={name} />

			<AppDomainsCard serverId={id} containerName={name} />

			<PreviewsCard serverId={id} containerName={name} />

			<CronsCard serverId={id} containerName={name} />

			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>deploys</CardTitle>
						<Button variant="outline" size="sm" onClick={loadDeploys}>
							refresh
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					<DeployList
						serverId={id}
						containerName={name}
						rows={deployHistory}
						expanded={expandedDeploy}
						onToggle={(rowId) => setExpandedDeploy((curr) => (curr === rowId ? null : rowId))}
						onRollback={rollback}
						rollingBackId={rollingBackId}
						busy={deployBusy}
						onSnapshotChanged={loadDeploys}
					/>
				</CardContent>
			</Card>

			<LiveLogsCard serverId={id} containerName={name} />
			<ConfirmDialog
				open={confirmAction !== null}
				title={confirmContent?.title ?? ''}
				description={confirmContent?.description}
				confirmLabel={confirmContent?.confirmLabel}
				danger={confirmContent?.danger}
				loading={restarting || applying || deploying || rollingBackId !== null}
				onConfirm={() => {
					const action = confirmContent
					setConfirmAction(null)
					action?.onConfirm()
				}}
				onClose={() => setConfirmAction(null)}
			/>
		</div>
	)
}

function EnvHeaderActions({
	envFile,
	editing,
	saving,
	applying,
	busy,
	drift,
	onEdit,
	onCancel,
	onSave,
	onApply,
}: {
	envFile: EnvFile | null
	editing: boolean
	saving: boolean
	applying: boolean
	busy: boolean
	drift: number
	onEdit: () => void
	onCancel: () => void
	onSave: () => void
	onApply: () => void
}) {
	if (!envFile?.supported) return null
	const canApply = envFile.autoApply !== false
	if (editing) {
		return (
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
					cancel
				</Button>
				<Button size="sm" onClick={onSave} disabled={saving}>
					{saving ? 'saving…' : 'save'}
				</Button>
			</div>
		)
	}
	return (
		<div className="flex items-center gap-2">
			{drift > 0 && <Badge variant="warning">{drift} pending: apply to recreate</Badge>}
			<Button variant="outline" size="sm" onClick={onEdit}>
				edit
			</Button>
			<Button
				size="sm"
				onClick={onApply}
				disabled={applying || busy || !canApply}
				title={
					canApply
						? 'recreate via docker compose'
						: 'auto-apply unavailable on raw-docker servers: recreate manually'
				}
			>
				{applying ? 'applying…' : 'apply'}
			</Button>
		</div>
	)
}

type RevealFn = (key: string) => Promise<string | null>

function EnvList({
	entries,
	drift,
	onReveal,
}: {
	entries: { key: string; value: string }[]
	drift: number
	onReveal: RevealFn
}) {
	if (entries.length === 0)
		return <p className="text-sm text-muted-foreground">env file is empty.</p>
	return (
		<>
			{drift > 0 && (
				<p className="mb-3 text-xs text-muted-foreground">
					{drift} {drift === 1 ? 'value differs' : 'values differ'} from what the running container
					has. click apply to recreate.
				</p>
			)}
			<div className="divide-y divide-border">
				{entries.map((e) => (
					<EnvRow key={e.key} entry={e} onReveal={onReveal} />
				))}
			</div>
		</>
	)
}

function EmptyEnvFile({
	path,
	liveEntries,
	onStart,
	onReveal,
}: {
	path: string
	liveEntries: { key: string; value: string }[]
	onStart: () => void
	onReveal: RevealFn
}) {
	return (
		<div className="space-y-4">
			<div className="flex items-start justify-between gap-3 rounded-md border border-dashed border-border px-3 py-3">
				<div>
					<p className="text-sm">
						no env file at <span className="font-mono">{path}</span> yet.
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						click edit to create one: values you set there will overlay the live envs below.
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={onStart}>
					edit
				</Button>
			</div>
			<LiveEnvSection entries={liveEntries} onReveal={onReveal} />
		</div>
	)
}

function LiveEnvFallback({
	entries,
	reason,
	onReveal,
}: {
	entries: { key: string; value: string }[]
	reason: string
	onReveal: RevealFn
}) {
	return (
		<div className="space-y-3">
			<p className="text-xs text-muted-foreground">{reason}</p>
			<LiveEnvSection entries={entries} onReveal={onReveal} />
		</div>
	)
}

function LiveEnvSection({
	entries,
	onReveal,
}: {
	entries: { key: string; value: string }[]
	onReveal: RevealFn
}) {
	if (entries.length === 0)
		return <p className="text-xs text-muted-foreground">live container has no env vars set.</p>
	return (
		<div>
			<p className="mb-2 text-xs text-muted-foreground">
				live envs · from <code className="font-mono">docker inspect</code> · read-only
			</p>
			<div className="divide-y divide-border">
				{entries.map((e) => (
					<EnvRow key={e.key} entry={e} onReveal={onReveal} />
				))}
			</div>
		</div>
	)
}

// The value arrives masked from the server; the eye fetches the real one for
// this key only, and hiding it drops it from state again.
function EnvRow({
	entry,
	onReveal,
}: { entry: { key: string; value: string }; onReveal: RevealFn }) {
	const [real, setReal] = useState<string | null>(null)
	const revealed = real !== null
	return (
		<div className="flex items-start justify-between gap-3 py-2">
			<div className="flex-1 min-w-0">
				<div className="font-mono text-xs font-semibold">{entry.key}</div>
				<div className="ph-no-capture font-mono text-xs text-muted-foreground break-all">
					{revealed ? real : entry.value ? entry.value : '(empty)'}
				</div>
			</div>
			<button
				type="button"
				onClick={async () => setReal(revealed ? null : await onReveal(entry.key))}
				className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent"
				aria-label={revealed ? 'hide value' : 'reveal value'}
			>
				{revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
			</button>
		</div>
	)
}

function EnvEditor({
	draft,
	onChange,
}: {
	draft: Entry[]
	onChange: (next: Entry[]) => void
}) {
	// Default to raw: devs prefer pasting/bulk-editing a .env over a row form.
	const [mode, setMode] = useState<'form' | 'raw'>('raw')
	const [rawText, setRawText] = useState(() => serializeEnv(draft))

	function update(id: number, patch: Partial<Entry>) {
		onChange(draft.map((e) => (e.id === id ? { ...e, ...patch } : e)))
	}
	function remove(id: number) {
		onChange(draft.filter((e) => e.id !== id))
	}
	function add() {
		onChange([...draft, { key: '', value: '', id: newId() }])
	}

	function toRaw() {
		setRawText(serializeEnv(draft))
		setMode('raw')
	}
	function toForm() {
		const parsed = parseRawEnv(rawText)
		onChange(parsed.map((e) => ({ ...e, id: newId() })))
		setMode('form')
	}
	function onRawChange(next: string) {
		setRawText(next)
		// keep parent draft in sync so save uses the latest text.
		// comments and blank lines exist only inside the textarea: they're stripped here.
		onChange(parseRawEnv(next).map((e) => ({ ...e, id: newId() })))
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<div className="flex rounded-md border border-border p-0.5 text-xs">
					<button
						type="button"
						onClick={() => mode === 'raw' && toForm()}
						className={`rounded px-3 py-1 transition-colors ${
							mode === 'form'
								? 'bg-accent text-accent-foreground'
								: 'text-muted-foreground hover:text-foreground'
						}`}
					>
						form
					</button>
					<button
						type="button"
						onClick={() => mode === 'form' && toRaw()}
						className={`rounded px-3 py-1 transition-colors ${
							mode === 'raw'
								? 'bg-accent text-accent-foreground'
								: 'text-muted-foreground hover:text-foreground'
						}`}
					>
						raw .env
					</button>
				</div>
				{mode === 'raw' && (
					<span className="text-2xs text-muted-foreground">
						KEY=value per line · # comments stripped on save
					</span>
				)}
			</div>

			{mode === 'raw' ? (
				<Textarea
					value={rawText}
					onChange={(e) => onRawChange(e.target.value)}
					spellCheck={false}
					textareaSize="sm"
					className="min-h-[420px] font-mono leading-relaxed"
					placeholder={'DATABASE_URL=postgres://…\nNODE_ENV=production\n'}
				/>
			) : (
				<div className="space-y-2">
					{draft.length === 0 && (
						<p className="text-xs text-muted-foreground">no vars yet. add one below.</p>
					)}
					{draft.map((e) => (
						<div key={e.id} className="flex gap-2">
							<Input
								value={e.key}
								onChange={(ev) => update(e.id, { key: ev.target.value.toUpperCase() })}
								placeholder="KEY"
								inputSize="sm"
								className="w-1/3 font-mono"
							/>
							<Input
								value={e.value}
								onChange={(ev) => update(e.id, { value: ev.target.value })}
								placeholder="value"
								inputSize="sm"
								className="min-w-0 flex-1 font-mono"
							/>
							<button
								type="button"
								onClick={() => remove(e.id)}
								className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
								aria-label="remove"
							>
								<Trash2 className="h-3.5 w-3.5" />
							</button>
						</div>
					))}
					<Button variant="outline" size="sm" onClick={add}>
						<Plus className="h-3 w-3" />
						add var
					</Button>
				</div>
			)}
		</div>
	)
}

function BackLink() {
	return (
		<Link
			href="/servers"
			className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
		>
			<ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
			servers
		</Link>
	)
}

function KV({ k, v }: { k: string; v: string }) {
	return (
		<div className="grid grid-cols-[100px_1fr] items-baseline gap-3">
			<span className="text-xs text-muted-foreground">{k}</span>
			<span className="break-all font-mono text-xs">{v}</span>
		</div>
	)
}

function GitInline({ status }: { status: GitStatus | null }) {
	if (!status) return null
	if (!status.supported)
		return (
			<p className="mt-2 text-xs text-muted-foreground">
				git deploy not available: {status.reason ?? 'no compose working dir'}.
			</p>
		)
	if (!status.isRepo) {
		if (status.checkout === 'src-link')
			return (
				<p className="mt-2 text-xs text-muted-foreground">
					<span className="font-mono">src</span> in{' '}
					<span className="font-mono">{status.workingDir}</span> is a symlink · deploys refuse it
				</p>
			)
		if (status.checkout === 'unknown' || (status.checkout !== 'none' && status.checkoutDir))
			return (
				<p className="mt-2 text-xs text-muted-foreground">
					could not read the git checkout in{' '}
					<span className="font-mono">{status.checkoutDir ?? status.workingDir}</span>
				</p>
			)
		return (
			<p className="mt-2 text-xs text-muted-foreground">
				not git-tracked · deploys will rebuild from{' '}
				<span className="font-mono">{status.workingDir}</span>
			</p>
		)
	}
	const remote = remoteState(status)
	return (
		<p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<GitBranch className="h-3 w-3" />
			<span className="font-mono">{status.branch ?? '-'}</span>
			<span>·</span>
			<span className="font-mono">{(status.currentSha ?? '').slice(0, 7) || '-'}</span>
			{remote.kind === 'ahead' && <Badge variant="warning">remote has new commits</Badge>}
			{remote.kind === 'unchecked' && (
				<Badge variant="outline" title={remote.reason}>
					could not check the remote
				</Badge>
			)}
			{remote.kind === 'unchecked' && <span className="break-all">{remote.reason}</span>}
			{status.dirty && <Badge variant="outline">dirty working tree</Badge>}
			{status.checkoutDir && <span className="font-mono">{status.checkoutDir}</span>}
			{status.staleWorkdirGit && (
				<span title="an older layout's .git in the working dir; deploys and this view use src/">
					· old .git in the working dir ignored
				</span>
			)}
		</p>
	)
}

function canDeployFromGit(status: GitStatus | null): boolean {
	return !!status?.supported
}

function deployHint(status: GitStatus | null): string {
	if (!status) return 'loading…'
	if (!status.supported) return status.reason ?? 'deploy not supported here'
	if (status.isRepo) return 'git pull → docker build → recreate'
	return 'docker build → recreate (no git repo)'
}

function DeployList({
	serverId,
	containerName,
	rows,
	expanded,
	onToggle,
	onRollback,
	rollingBackId,
	busy,
	onSnapshotChanged,
}: {
	serverId: string
	containerName: string
	rows: DeployRow[] | null
	expanded: string | null
	onToggle: (id: string) => void
	onRollback: (id: string) => void
	rollingBackId: string | null
	busy: boolean
	onSnapshotChanged: () => void | Promise<void>
}) {
	if (rows === null) return <SkeletonList />
	if (rows.length === 0)
		return (
			<p className="text-sm text-muted-foreground">
				no deploys yet. apply or deploy to record one.
			</p>
		)
	const latestSuccessIdx = rows.findIndex((r) => r.status === 'success')
	return (
		<div className="divide-y divide-border">
			{rows.map((d, i) => {
				const canRollback =
					d.status === 'success' && !!d.imageTag && i !== latestSuccessIdx && d.kind !== 'rollback'
				const isRollingBack = rollingBackId === d.id
				return (
					<div key={d.id} className="py-2.5">
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={() => onToggle(d.id)}
								className="flex flex-1 items-center gap-3 text-left"
							>
								<DeployStatusBadge status={d.status} />
								<span className="text-xs text-muted-foreground">{d.kind.replace('_', ' ')}</span>
								{d.waiting && <span className="text-2xs text-muted-foreground">{d.waiting}</span>}
								{d.gitSha && (
									<span className="font-mono text-2xs text-muted-foreground">
										{d.gitBranch ? `${d.gitBranch} · ` : ''}
										{d.gitSha.slice(0, 7)}
									</span>
								)}
								<span className="ml-auto font-mono text-xs text-muted-foreground">
									{fmt(d.startedAt)}
								</span>
								{d.finishedAt && (
									<span className="font-mono text-2xs text-muted-foreground">
										{durationMs(d.startedAt, d.finishedAt)}
									</span>
								)}
							</button>
							<Link
								href={`/deploys/${d.id}`}
								onClick={(e) => e.stopPropagation()}
								className="text-xs text-muted-foreground hover:text-powder"
							>
								view ↗
							</Link>
							{d.status === 'success' && d.imageTag && (
								<SnapshotButton
									serverId={serverId}
									containerName={containerName}
									deploy={d}
									onChanged={onSnapshotChanged}
								/>
							)}
							{canRollback && (
								<Button
									variant="ghost"
									size="sm"
									disabled={busy || isRollingBack || rollingBackId !== null}
									onClick={(e) => {
										e.stopPropagation()
										onRollback(d.id)
									}}
									className="text-xs"
								>
									{isRollingBack ? 'rolling back…' : 'rollback'}
								</Button>
							)}
						</div>
						{expanded === d.id && (d.output || d.error) && (
							<DeployOutputBlock error={d.error} output={d.output} />
						)}
					</div>
				)
			})}
		</div>
	)
}

function SnapshotButton({
	serverId,
	containerName,
	deploy,
	onChanged,
}: {
	serverId: string
	containerName: string
	deploy: DeployRow
	onChanged: () => void | Promise<void>
}) {
	const [busy, setBusy] = useState(false)
	const liveSnapshot =
		deploy.snapshotUrl &&
		deploy.snapshotExpiresAt &&
		new Date(deploy.snapshotExpiresAt).getTime() > Date.now()

	async function spawn(e: React.MouseEvent) {
		e.stopPropagation()
		setBusy(true)
		let url: string | undefined
		try {
			const res = await fetch(
				`/api/servers/${serverId}/containers/${containerName}/deploys/${deploy.id}/snapshot`,
				{ method: 'POST' },
			)
			if (!res.ok) return
			const data = await res.json().catch(() => ({}))
			url = data.url
		} catch {
			return
		} finally {
			setBusy(false)
		}
		if (url) window.open(url, '_blank')
		await onChanged()
	}

	if (liveSnapshot) {
		return (
			<a
				href={deploy.snapshotUrl ?? '#'}
				target="_blank"
				rel="noopener noreferrer"
				onClick={(e) => e.stopPropagation()}
				className="text-xs text-powder hover:underline"
			>
				preview ↗
			</a>
		)
	}
	return (
		<Button variant="ghost" size="sm" disabled={busy} onClick={spawn} className="text-xs">
			{busy ? 'spinning…' : 'preview'}
		</Button>
	)
}

function DeployOutputBlock({ error, output }: { error: string | null; output: string | null }) {
	const text = `${error ? `ERROR: ${error}\n\n` : ''}${output ?? ''}`
	const id = useId()
	return (
		<div className="relative mt-2">
			<CopyButton
				value={text}
				label="copy output"
				targetId={id}
				className="absolute right-1.5 top-1.5 bg-background/80"
			/>
			<pre
				id={id}
				className="ph-no-capture max-h-72 overflow-auto rounded-md bg-muted/40 p-3 pr-10 font-mono text-2xs leading-relaxed"
			>
				{text}
			</pre>
		</div>
	)
}

function DeployStatusBadge({ status }: { status: DeployRow['status'] }) {
	if (status === 'queued') return <Badge variant="outline">queued</Badge>
	if (status === 'running') return <Badge variant="outline">running…</Badge>
	if (status === 'success') return <Badge variant="success">success</Badge>
	return <Badge variant="destructive">failed</Badge>
}

function durationMs(startISO: string, endISO: string): string {
	try {
		const ms = new Date(endISO).getTime() - new Date(startISO).getTime()
		if (ms < 1000) return `${ms}ms`
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
		return `${Math.round(ms / 60_000)}m`
	} catch {
		return ''
	}
}

function StateBadge({ state }: { state: string }) {
	if (state === 'running') return <Badge variant="success">running</Badge>
	if (state === 'exited' || state === 'dead') return <Badge variant="destructive">{state}</Badge>
	return <Badge variant="outline">{state}</Badge>
}

function fmt(iso: string): string {
	return formatDateTime(iso)
}
