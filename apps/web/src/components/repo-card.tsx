'use client'

import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	GitBranch,
	Lock,
	Search,
	Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'

interface GhRepo {
	id: number
	fullName: string
	name: string
	ownerLogin: string
	ownerAvatar: string
	private: boolean
	defaultBranch: string
	sshUrl: string
	updatedAt: string
}

interface GhStatus {
	connected: boolean
	username?: string
}

interface ConnectStep {
	step: string
	ok: boolean
	detail: string
}

interface RepoState {
	connected: boolean
	repoUrl?: string
	branch?: string
	deployKeyPub?: string
	webhookUrl?: string
	webhookSecret?: string | null
	autoInstalled?: boolean
	isCheckout?: boolean
	// where the checkout is on the server (lib/app-checkout.ts)
	checkout?: { kind: 'src' | 'workdir' | 'none' | 'src-link' | 'unknown' }
	// one line saying where the checkout is, or why there is none (lib/app-checkout.ts checkoutNote)
	checkoutNote?: string
	// the clone action (into <working dir>/src) is allowed for this layout
	cloneAllowed?: boolean
	// src/ is a checkout of this repo but <wd>/.deploy-key is missing
	keyMissing?: boolean
	// Present only in the response right after an adopt: the per-step result of
	// the auto-setup so the user sees a punch list instead of a silent gap.
	steps?: ConnectStep[]
	allGreen?: boolean
}

export function RepoCard({ serverId, containerName }: { serverId: string; containerName: string }) {
	const toast = useToast()
	const [state, setState] = useState<RepoState | null>(null)
	const [gh, setGh] = useState<GhStatus | null>(null)
	const [showSecret, setShowSecret] = useState<{ secret: string; webhookUrl: string } | null>(null)
	const [showConnect, setShowConnect] = useState(false)
	const [confirmDisconnect, setConfirmDisconnect] = useState(false)
	const [busy, setBusy] = useState(false)
	// what happened to the app's env files on disconnect (archived dir, or why kept)
	const [envNote, setEnvNote] = useState<string | null>(null)

	async function load() {
		const [a, b] = await Promise.all([
			fetch(`/api/servers/${serverId}/containers/${containerName}/repo`),
			fetch('/api/integrations/github'),
		])
		if (a.ok) setState(await a.json())
		if (b.ok) setGh(await b.json())
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the server or container changes; load is recreated every render and reads both props itself
	useEffect(() => {
		load()
	}, [serverId, containerName])

	function handleManualConnected(s: RepoState) {
		setState(s)
		if (s.webhookSecret) {
			setShowSecret({ secret: s.webhookSecret, webhookUrl: s.webhookUrl ?? '' })
		}
		setShowConnect(false)
	}

	async function disconnect() {
		setBusy(true)
		try {
			const r = await fetch(`/api/servers/${serverId}/containers/${containerName}/repo`, {
				method: 'DELETE',
			})
			const res = (await r.json().catch(() => null)) as {
				envArchive?: { detail?: string }
				github?: { deployKey?: string; hook?: string }
			} | null
			// What happened on github (deleted / not recorded / failed: reason), then the env files.
			const gh = res?.github
			const ghNote = gh
				? `github: deploy key ${gh.deployKey ?? 'unknown'}, webhook ${gh.hook ?? 'unknown'}.`
				: null
			setEnvNote([ghNote, res?.envArchive?.detail].filter(Boolean).join(' ') || null)
			setConfirmDisconnect(false)
			setShowSecret(null)
			await load()
		} catch {
			toast.error('disconnect failed: network error')
		} finally {
			setBusy(false)
		}
	}

	if (!state) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>git</CardTitle>
				</CardHeader>
				<CardContent>
					<SkeletonList rows={2} bare />
				</CardContent>
			</Card>
		)
	}

	if (!state.connected) {
		return (
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>git</CardTitle>
						{!showConnect && (
							<Button size="sm" variant="outline" onClick={() => setShowConnect(true)}>
								<GitBranch className="h-3 w-3" />
								connect
							</Button>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{envNote && <p className="mb-2 font-mono text-xs text-muted-foreground">{envNote}</p>}
					{!showConnect ? (
						<p className="text-sm text-muted-foreground">
							on every push, powder pulls, builds, and recreates.
						</p>
					) : gh?.connected ? (
						<ImportFlow
							serverId={serverId}
							containerName={containerName}
							onClose={() => setShowConnect(false)}
							onConnected={(s) => {
								setState(s)
								setShowConnect(false)
							}}
							onManualConnected={handleManualConnected}
						/>
					) : (
						<ManualConnect
							serverId={serverId}
							containerName={containerName}
							onClose={() => setShowConnect(false)}
							onConnected={handleManualConnected}
						/>
					)}
				</CardContent>
			</Card>
		)
	}

	const autoInstalled = state.autoInstalled

	return (
		<>
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div className="flex min-w-0 items-center gap-2.5">
							<CardTitle>git</CardTitle>
							<span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
								<span className="h-1.5 w-1.5 rounded-full bg-success" />
								connected
							</span>
						</div>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setConfirmDisconnect(true)}
							disabled={busy}
							title="disconnect"
						>
							<Trash2 className="h-3.5 w-3.5" />
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-3 text-sm">
					<div className="grid grid-cols-[80px_1fr] gap-3 text-xs">
						<span className="text-muted-foreground">repo</span>
						<span className="break-all font-mono">{prettyRepo(state.repoUrl ?? '')}</span>
						<span className="text-muted-foreground">branch</span>
						<span className="font-mono">{state.branch}</span>
					</div>

					{showSecret && (
						<SetupOnce
							secret={showSecret.secret}
							webhookUrl={showSecret.webhookUrl}
							deployKeyPub={state.deployKeyPub ?? ''}
							onDismiss={() => setShowSecret(null)}
						/>
					)}

					{state.cloneAllowed ? (
						<NeedsCloneCTA serverId={serverId} containerName={containerName} onCloned={load} />
					) : state.keyMissing ? (
						<NeedsCloneCTA serverId={serverId} containerName={containerName} onCloned={load} keyOnly />
					) : state.checkoutNote && state.isCheckout ? (
						<p className="text-2xs text-muted-foreground">{state.checkoutNote}</p>
					) : state.checkoutNote ? (
						<p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-2xs text-muted-foreground">
							{state.checkoutNote}
						</p>
					) : null}

					{state.steps && state.steps.length > 0 && <ConnectChecklist steps={state.steps} />}

					<AdvancedDetails
						webhookUrl={state.webhookUrl ?? ''}
						deployKeyPub={state.deployKeyPub ?? ''}
						autoInstalled={!!autoInstalled}
					/>
				</CardContent>
			</Card>

			<ConfirmDialog
				open={confirmDisconnect}
				title="disconnect git?"
				description="powder stops responding to webhooks for this app and deletes the deploy key and webhook it added on GitHub. if GitHub refuses, or powder never recorded them or has no GitHub token for the repo, they stay: the result is shown after, and you delete them in the repo settings on GitHub. the working dir on the server is untouched. when no container of this app is left on the server, its env files (/opt/apps/<app>.env, .preview.env, .db.env) move to /var/lib/powder/deleted-env/<app>-<time>/ (root only); the answer names the exact dir. while a container exists they stay."
				confirmLabel="disconnect"
				danger
				loading={busy}
				onConfirm={disconnect}
				onClose={() => setConfirmDisconnect(false)}
			/>
		</>
	)
}

// "owner/repo" from a git@github.com:owner/repo.git or https url
function prettyRepo(url: string): string {
	const ssh = url.match(/^git@[^:]+:([^/]+)\/(.+?)(\.git)?$/)
	if (ssh) return `${ssh[1]}/${ssh[2]}`
	const https = url.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(\.git)?\/?$/)
	if (https) return `${https[1]}/${https[2]}`
	return url
}

// Post-adopt punch list. The import flow auto-does deploy key, workflow, Actions
// secrets, env backfill, and a dry-run verify; this renders the per-step outcome
// so any amber item (build-mode compose, branch mismatch, a failed secret) is a
// visible TODO with the fix inline, not a silent gap discovered days later.
function ConnectChecklist({ steps }: { steps: ConnectStep[] }) {
	const warnings = steps.filter((s) => !s.ok).length
	return (
		<div
			className={`space-y-2 rounded-md border p-3 text-xs ${
				warnings > 0 ? 'border-warning/40 bg-warning/10' : 'border-success/40 bg-success/10'
			}`}
		>
			<p className="font-medium">
				{warnings > 0
					? `connected: ${warnings} item${warnings > 1 ? 's' : ''} need a look`
					: 'connected: everything set up automatically'}
			</p>
			<ul className="space-y-1.5">
				{steps.map((s) => (
					<li key={s.step} className="flex gap-2">
						{s.ok ? (
							<Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
						) : (
							<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
						)}
						<span className="min-w-0">
							<span className={s.ok ? 'text-muted-foreground' : 'text-foreground'}>{s.step}</span>
							{s.detail && (
								<span className="ph-no-capture block break-words text-2xs text-muted-foreground">
									{s.detail}
								</span>
							)}
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}

// Shown ONCE after a manual connect: gives the user the secret to paste into github.
function SetupOnce({
	secret,
	webhookUrl,
	deployKeyPub,
	onDismiss,
}: {
	secret: string
	webhookUrl: string
	deployKeyPub: string
	onDismiss: () => void
}) {
	return (
		<div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
			<div>
				<p className="font-medium">finish setup on github (once)</p>
				<p className="mt-1 text-muted-foreground">
					powder needs you to add 2 things on the repo. the secret below won't be shown again.
				</p>
			</div>
			<div>
				<p className="text-2xs text-muted-foreground">
					1. settings → webhooks → add webhook → content type{' '}
					<code className="font-mono">application/json</code>
				</p>
				<CopyLine value={webhookUrl} label="payload url" />
				<CopyLine value={secret} label="secret" />
			</div>
			<div>
				<p className="text-2xs text-muted-foreground">
					2. settings → deploy keys → add (read-only is fine)
				</p>
				<CopyLine value={deployKeyPub} label="key" />
			</div>
			<button
				type="button"
				onClick={onDismiss}
				className="text-2xs text-muted-foreground underline hover:text-foreground"
			>
				done: hide this
			</button>
		</div>
	)
}

// Shown when the app has no git checkout (no src/ and the working dir is not one).
// The clone goes into <working dir>/src; nothing else in the working dir changes.
function NeedsCloneCTA({
	serverId,
	containerName,
	onCloned,
	keyOnly = false,
}: {
	serverId: string
	containerName: string
	onCloned: () => void
	/** the clone is in place and only the deploy key is missing: the action writes it */
	keyOnly?: boolean
}) {
	const [confirm, setConfirm] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function go() {
		setBusy(true)
		try {
			setError(null)
			const res = await fetch(`/api/servers/${serverId}/containers/${containerName}/repo/clone`, {
				method: 'POST',
			})
			const data = await res.json()
			setConfirm(false)
			if (!res.ok) {
				setError(data.error ?? 'clone failed')
				return
			}
			onCloned()
		} catch {
			setError('clone failed: network error')
		} finally {
			setBusy(false)
		}
	}

	return (
		<>
			<div className="flex items-start justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 p-3">
				<div>
					<p className="text-xs font-medium">{keyOnly ? 'deploy key missing' : 'no git checkout yet'}</p>
					<p className="mt-0.5 text-2xs text-muted-foreground">
						{keyOnly
							? "the repo is cloned into src/, but the deploy key in the app's working dir is missing; deploys need it."
							: "clone the repo into src/ in the app's working dir to enable auto-deploy on push."}
					</p>
					{error && <p className="mt-1 text-2xs text-destructive">{error}</p>}
				</div>
				<Button size="sm" variant="outline" onClick={() => setConfirm(true)} disabled={busy}>
					{busy ? (keyOnly ? 'writing…' : 'cloning…') : keyOnly ? 'write key' : 'clone'}
				</Button>
			</div>
			<ConfirmDialog
				open={confirm}
				title={keyOnly ? 'write the deploy key?' : 'clone repo into src/?'}
				description={
					keyOnly
						? "powder writes the app's deploy key from its database to .deploy-key in the app's working dir. nothing else changes."
						: "powder clones the repo into a new src/ folder in the app's working dir. nothing in the working dir is moved, renamed or deleted. if the compose builds on the server, its build context must be ./src: a deploy refuses the app dir as the context and says so."
				}
				confirmLabel={keyOnly ? "write key" : "clone"}
				danger
				loading={busy}
				onConfirm={go}
				onClose={() => setConfirm(false)}
			/>
		</>
	)
}

// Collapsible details for users who want to see / re-copy the webhook + key.
function AdvancedDetails({
	webhookUrl,
	deployKeyPub,
	autoInstalled,
}: {
	webhookUrl: string
	deployKeyPub: string
	autoInstalled: boolean
}) {
	const [open, setOpen] = useState(false)
	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
			>
				{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				webhook + deploy key
				{autoInstalled && (
					<span className="ml-1 text-2xs text-muted-foreground">(auto-installed ✓)</span>
				)}
			</button>
			{open && (
				<div className="mt-2 space-y-2 rounded-md border border-border bg-muted/30 p-3">
					<CopyLine value={webhookUrl} label="webhook url" />
					<CopyLine value={deployKeyPub} label="deploy key (pub)" />
				</div>
			)}
		</div>
	)
}

function CopyLine({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false)
	async function copy() {
		await navigator.clipboard.writeText(value)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}
	return (
		<div className="ph-no-capture mt-1 flex items-center gap-2">
			<span className="w-24 shrink-0 text-2xs text-muted-foreground">{label}</span>
			<code className="ph-no-capture flex-1 truncate rounded-md bg-background px-2 py-1 font-mono text-2xs">
				{value}
			</code>
			<button
				type="button"
				onClick={copy}
				className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				aria-label="copy"
			>
				{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
			</button>
		</div>
	)
}

// Repo-picker flow when github oauth IS connected.
function ImportFlow({
	serverId,
	containerName,
	onClose,
	onConnected,
	onManualConnected,
}: {
	serverId: string
	containerName: string
	onClose: () => void
	onConnected: (s: RepoState) => void
	// Used by the "paste a url manually" fallback so the one-time webhook secret is shown.
	onManualConnected: (s: RepoState) => void
}) {
	const [repos, setRepos] = useState<GhRepo[] | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [filter, setFilter] = useState('')
	const [selected, setSelected] = useState<GhRepo | null>(null)
	const [branch, setBranch] = useState('')
	const [importing, setImporting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [showManual, setShowManual] = useState(false)

	useEffect(() => {
		fetch('/api/integrations/github/repos')
			.then(async (r) => {
				const data = await r.json()
				if (!r.ok) {
					setLoadError(data.error ?? 'failed to load repos')
					return
				}
				setRepos(data.repos)
			})
			.catch((e) => setLoadError(String(e)))
	}, [])

	const filtered = useMemo(() => {
		if (!repos) return []
		const q = filter.trim().toLowerCase()
		if (!q) return repos.slice(0, 50)
		return repos.filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, 50)
	}, [repos, filter])

	async function go() {
		if (!selected) return
		setImporting(true)
		try {
			setError(null)
			const res = await fetch(`/api/servers/${serverId}/containers/${containerName}/repo/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoFullName: selected.fullName, branch }),
			})
			const data = await res.json()
			if (!res.ok) {
				setError(data.error ?? 'import failed')
				return
			}
			onConnected(data)
		} catch {
			setError('import failed: network error')
		} finally {
			setImporting(false)
		}
	}

	if (showManual) {
		return (
			<ManualConnect
				serverId={serverId}
				containerName={containerName}
				onClose={onClose}
				onConnected={onManualConnected}
			/>
		)
	}

	if (selected) {
		return (
			<div className="space-y-3">
				<div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-3">
					<img src={selected.ownerAvatar} alt="" className="h-6 w-6 shrink-0 rounded-sm" />
					<div className="min-w-0 flex-1">
						<p className="truncate font-mono text-sm">{selected.fullName}</p>
						<p className="text-2xs text-muted-foreground">
							deploy on push to{' '}
							<input
								value={branch}
								onChange={(e) => setBranch(e.target.value)}
								aria-label="branch"
								className="ml-0.5 inline-block w-28 border-b border-muted-foreground/30 bg-transparent px-0.5 font-mono text-base text-foreground focus:border-foreground focus:outline-none sm:text-2xs"
							/>
						</p>
					</div>
				</div>
				{error && <p className="text-xs text-destructive">{error}</p>}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" size="sm" onClick={() => setSelected(null)} disabled={importing}>
						back
					</Button>
					<Button size="sm" onClick={go} disabled={importing || !branch}>
						{importing ? 'connecting…' : 'connect'}
					</Button>
				</div>
			</div>
		)
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
					<Input
						placeholder="search repos"
						aria-label="search repos"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="pl-7 font-mono"
						autoFocus
					/>
				</div>
				<Button type="button" variant="ghost" size="sm" onClick={onClose}>
					cancel
				</Button>
			</div>
			{loadError ? (
				<p className="text-xs text-destructive">{loadError}</p>
			) : !repos ? (
				<p className="text-xs text-muted-foreground">loading repos…</p>
			) : filtered.length === 0 ? (
				<p className="text-xs text-muted-foreground">no repos match.</p>
			) : (
				<ul className="max-h-[40vh] divide-y divide-border overflow-auto rounded-md border border-border">
					{filtered.map((r) => (
						<li key={r.id}>
							<button
								type="button"
								onClick={() => {
									setSelected(r)
									setBranch(r.defaultBranch)
								}}
								className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/40"
							>
								<img src={r.ownerAvatar} alt="" className="h-5 w-5 rounded-sm" />
								<span className="truncate font-mono">{r.fullName}</span>
								{r.private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
								<span className="ml-auto shrink-0 text-2xs text-muted-foreground">
									{r.defaultBranch}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<button
				type="button"
				onClick={() => setShowManual(true)}
				className="text-2xs text-muted-foreground hover:text-foreground"
			>
				or paste a url manually
			</button>
		</div>
	)
}

// Manual paste flow: only used when github oauth ISN'T connected.
function ManualConnect({
	serverId,
	containerName,
	onClose,
	onConnected,
}: {
	serverId: string
	containerName: string
	onClose: () => void
	onConnected: (s: RepoState) => void
}) {
	const [rawInput, setRawInput] = useState('')
	const [branch, setBranch] = useState('main')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const normalized = normalizeRepoUrl(rawInput)
	const valid = looksValid(normalized)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		try {
			setError(null)
			const res = await fetch(`/api/servers/${serverId}/containers/${containerName}/repo`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoUrl: normalized, branch }),
			})
			const data = await res.json()
			if (!res.ok) {
				setError(data.error ?? 'connect failed')
				return
			}
			onConnected(data)
		} catch {
			setError('connect failed: network error')
		} finally {
			setBusy(false)
		}
	}

	return (
		<form onSubmit={submit} className="space-y-3">
			<div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-2xs text-muted-foreground">
				<Link href="/integrations" className="text-foreground underline">
					connect github
				</Link>{' '}
				to skip this and pick a repo from a dropdown.
			</div>
			<Input
				placeholder="git@github.com:user/repo.git"
				aria-label="repo SSH URL"
				value={rawInput}
				onChange={(e) => setRawInput(e.target.value)}
				required
				autoComplete="off"
				className={`font-mono ${rawInput && !valid ?'border-destructive/60' :''}`}
			/>
			<Input
				placeholder="branch (default: main)"
				aria-label="branch"
				value={branch}
				onChange={(e) => setBranch(e.target.value)}
				className="font-mono"
				required
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
					cancel
				</Button>
				<Button type="submit" size="sm" disabled={busy || !valid}>
					{busy ? 'generating key…' : 'connect'}
				</Button>
			</div>
		</form>
	)
}

function normalizeRepoUrl(input: string): string {
	const trimmed = input.trim().replace(/\/+$/, '')
	const httpsMatch = trimmed.match(
		/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
	)
	if (httpsMatch) return `git@github.com:${httpsMatch[1]}/${httpsMatch[2]}.git`
	if (/^git@github\.com:[^/]+\/[^/]+\.git$/i.test(trimmed)) return trimmed
	return trimmed
}

function looksValid(url: string): boolean {
	if (!url) return false
	return /^(git@|https?:\/\/|ssh:\/\/)/.test(url) && /[/:][^/]+\/[^/]+/.test(url)
}
