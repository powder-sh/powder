'use client'

// Server detail: settings (routing, TLS certificates, base domain, public IP, build host),
// a DNS check for the base domain, the apps on this server, the check-first bootstrap
// ("check server" is read-only; "fix missing pieces" runs only the additive
// steps listed in its confirm dialog, plus a replace of an outdated helper only
// when its checkbox is ticked), and removing the server once no app lives on it.
// Data comes from gated API routes.

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Field, Input, Select } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonList } from '@/components/ui/skeleton'
import { StatusLabel, type StatusTone } from '@/components/ui/status'
import { ServerUnreachable } from '@/components/server-unreachable'
import { APP_HEALTH } from '@/lib/app-health'
import { type AppRow, appRowHealth } from '@/lib/apps-table'
import { serverStatus } from '@/lib/server-status'
import { changedSettings } from '@/lib/server-settings-diff'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/toast'
import { type CheckState, confirmedStepIds } from '@/lib/server-bootstrap'
import type { BootstrapCheckResult, BootstrapStepResult } from '@/lib/server-bootstrap-run'
import type { CachedDnsCheck } from '@/lib/server-dns-check'
import { RefreshCw, Stethoscope, Trash2, Wrench } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { formatDateTime } from '@/lib/format'

type Proxy = 'traefik' | 'nginx' | 'nginx-container'
type TlsMode = 'acme' | 'origin-cert'

interface Settings {
	proxy: Proxy
	tlsMode: TlsMode
	baseDomain: string | null
	ingressIp: string | null
	buildHost: string | null
}

interface ServerDetail {
	id: string
	name: string
	host: string
	sshUser: string
	sshPort: string
	kind: string
	status: 'pending' | 'connected' | 'unreachable'
	lastError: string | null
	hostKeyFingerprint?: string | null
	settings: Settings
	effectiveBaseDomain: string | null
}

const CHECK_TONE: Record<CheckState, StatusTone> = {
	ok: 'success',
	missing: 'destructive',
	warn: 'warning',
	info: 'neutral',
}

export default function ServerDetailPage() {
	const { id } = useParams<{ id: string }>()
	const toast = useToast()
	const [server, setServer] = useState<ServerDetail | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [check, setCheck] = useState<BootstrapCheckResult | null>(null)
	const [dns, setDns] = useState<CachedDnsCheck | null>(null)
	const [apps, setApps] = useState<AppRow[] | null>(null)
	// The apps list failed to load: delete stays off (the API refuses it too).
	const [appsError, setAppsError] = useState(false)

	const load = useCallback(async () => {
		const res = await fetch(`/api/servers/${encodeURIComponent(id)}`)
		const data = (await res.json().catch(() => ({}))) as {
			server?: ServerDetail
			check?: BootstrapCheckResult | null
			dns?: CachedDnsCheck | null
			error?: string
		}
		if (!res.ok || !data.server) {
			setLoadError(data.error ?? `failed to load server (${res.status})`)
			return
		}
		setServer(data.server)
		setCheck(data.check ?? null)
		setDns(data.dns ?? null)
		setLoadError(null)
	}, [id])

	useEffect(() => {
		load()
		fetch('/api/projects')
			.then((r) => {
				if (!r.ok) throw new Error(String(r.status))
				return r.json()
			})
			.then((d: { projects?: AppRow[] }) => {
				if (!Array.isArray(d.projects)) throw new Error('no apps list')
				setApps(d.projects.filter((a) => a.serverId === id))
				setAppsError(false)
			})
			.catch(() => {
				setApps([])
				setAppsError(true)
			})
	}, [load, id])

	// Retry: one SSH round over every server (the sync the servers list runs), then reload.
	const retry = useCallback(async () => {
		await fetch('/api/servers/sync', { method: 'POST' }).catch(() => null)
		await load()
	}, [load])

	if (loadError) {
		return (
			<div className="space-y-6">
				<PageHeader title="server" back={{ href: '/servers', label: 'servers' }} />
				<Alert tone="destructive" title="could not load this server">
					{loadError}
				</Alert>
			</div>
		)
	}
	if (!server) return <SkeletonList />
	const st = serverStatus(server.status)

	return (
		<div className="space-y-6">
			<title>{`${server.name} · servers · powder`}</title>
			<PageHeader
				back={{ href: '/servers', label: 'servers' }}
				title={
					<>
						{server.name}
						<StatusLabel tone={st.tone}>{st.label}</StatusLabel>
					</>
				}
				meta={
					<>
						<span className="font-mono text-xs">
							{server.sshUser}@{server.host}:{server.sshPort}
						</span>
						{server.kind === 'raw-docker' && <Badge variant="outline">watch only</Badge>}
						<span
							className="ph-no-capture min-w-0 truncate font-mono text-2xs"
							title="powder pins the server's SSH host key on the first connection and refuses a different one later. compare with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
						>
							{server.hostKeyFingerprint
								? `host key ${server.hostKeyFingerprint}`
								: 'host key pinned on first connect'}
						</span>
					</>
				}
			/>
			{server.status === 'unreachable' && (
				<ServerUnreachable
					serverId={server.id}
					serverName={server.name}
					error={server.lastError}
					what="what runs on it"
					openServer={false}
					onRetry={retry}
				/>
			)}
			<AppsCard apps={apps} error={appsError} />
			<SettingsCard
				server={server}
				onSaved={(s) => {
					toast.success('settings saved')
					setServer({ ...server, settings: s })
					load()
				}}
				dns={dns}
				onDns={setDns}
			/>
			<BootstrapCard serverId={server.id} check={check} onCheck={setCheck} />
			<DangerZone server={server} apps={apps} appsError={appsError} />
		</div>
	)
}

function AppsCard({ apps, error }: { apps: AppRow[] | null; error: boolean }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>apps</CardTitle>
			</CardHeader>
			<CardContent>
				{apps === null ? (
					<p className="text-sm text-muted-foreground">loading…</p>
				) : error ? (
					<p className="text-sm text-muted-foreground">could not load the apps list. reload the page to try again.</p>
				) : apps.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						no apps on this server yet.{' '}
						<Link href="/new" className="text-foreground underline underline-offset-2">
							new app
						</Link>
					</p>
				) : (
					<ul className="-my-1 divide-y divide-border">
						{apps.map((a) => {
							const m = APP_HEALTH[appRowHealth(a)]
							return (
								<li key={a.id} className="flex min-h-11 items-center gap-3 py-1.5">
									<div className="min-w-0 flex-1">
										<Link
											href={`/projects/${a.id}`}
											className="block truncate text-sm font-medium underline-offset-2 hover:underline"
										>
											{a.containerName}
										</Link>
										{a.domain && (
											<div className="truncate text-xs text-muted-foreground">{a.domain}</div>
										)}
									</div>
									<StatusLabel tone={m.tone} pulse={m.pulse} className="shrink-0 text-xs">
										{m.label}
									</StatusLabel>
								</li>
							)
						})}
					</ul>
				)}
			</CardContent>
		</Card>
	)
}

// Removing a server only deletes powder's record (DELETE /api/servers/:id); the
// machine keeps running. Offered once no app lives here, so no app is orphaned.
function DangerZone({
	server,
	apps,
	appsError,
}: {
	server: ServerDetail
	apps: AppRow[] | null
	appsError: boolean
}) {
	const router = useRouter()
	const toast = useToast()
	const [open, setOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	if (apps === null) return null
	const blocked = appsError || apps.length > 0
	async function remove() {
		setBusy(true)
		try {
			const res = await fetch(`/api/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' })
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string }
				toast.error(`delete failed: ${data.error ?? res.status}`)
				return
			}
			toast.success(`${server.name} removed from powder`)
			router.push('/servers')
		} catch {
			toast.error('delete failed: network error')
		} finally {
			setBusy(false)
		}
	}
	return (
		<section className="rounded-lg border border-destructive/30">
			<div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
				<div className="min-w-0">
					<h2 className="text-sm font-semibold">delete server</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{appsError
							? 'the apps list did not load, so delete stays off. reload the page to try again.'
							: blocked
							? `delete its ${apps.length} app${apps.length === 1 ? '' : 's'} first. the machine itself is never touched.`
							: 'removes it from powder. the machine and anything running on it keep running.'}
					</p>
				</div>
				<Button
					variant="destructive-outline"
					size="sm"
					disabled={blocked}
					onClick={() => setOpen(true)}
				>
					<Trash2 className="h-3.5 w-3.5" />
					delete server
				</Button>
			</div>
			<ConfirmDialog
				open={open}
				title={`delete ${server.name}?`}
				description="powder forgets this server. the machine and its containers keep running."
				confirmLabel="delete server"
				danger
				loading={busy}
				onConfirm={remove}
				onClose={() => !busy && setOpen(false)}
			/>
		</section>
	)
}

function SettingsCard({
	server,
	onSaved,
	dns,
	onDns,
}: {
	server: ServerDetail
	onSaved: (s: Settings) => void
	dns: CachedDnsCheck | null
	onDns: (d: CachedDnsCheck) => void
}) {
	const [proxy, setProxy] = useState<Proxy>(server.settings.proxy)
	const [tlsMode, setTlsMode] = useState<TlsMode>(server.settings.tlsMode)
	const [baseDomain, setBaseDomain] = useState(server.settings.baseDomain ?? '')
	const [ingressIp, setIngressIp] = useState(server.settings.ingressIp ?? '')
	const [buildHost, setBuildHost] = useState(server.settings.buildHost ?? '')
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [checkingDns, setCheckingDns] = useState(false)

	const dirty =
		proxy !== server.settings.proxy ||
		tlsMode !== server.settings.tlsMode ||
		baseDomain.trim() !== (server.settings.baseDomain ?? '') ||
		ingressIp.trim() !== (server.settings.ingressIp ?? '') ||
		buildHost.trim() !== (server.settings.buildHost ?? '')

	async function save(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setSaving(true)
		try {
			const res = await fetch(`/api/servers/${encodeURIComponent(server.id)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(changedSettings(server.settings, { proxy, tlsMode, baseDomain, ingressIp, buildHost })),
			})
			const data = (await res.json().catch(() => ({}))) as { settings?: Settings; error?: string }
			if (!res.ok || !data.settings) {
				setError(data.error ?? `save failed (${res.status})`)
				return
			}
			onSaved(data.settings)
		} catch {
			setError('save failed: network error')
		} finally {
			setSaving(false)
		}
	}

	async function checkDns() {
		setCheckingDns(true)
		try {
			const res = await fetch(`/api/servers/${encodeURIComponent(server.id)}/dns-check`, {
				method: 'POST',
			})
			const data = (await res.json().catch(() => ({}))) as { dns?: CachedDnsCheck }
			if (data.dns) onDns(data.dns)
		} catch {
			// the last check stays on screen; the button can be pressed again
		} finally {
			setCheckingDns(false)
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>settings</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={save} className="grid gap-4 md:grid-cols-2">
					<Field
						id="proxy"
						label="routing"
						hint="Traefik adds custom domains, redirects and traffic stats."
					>
						<Select
							id="proxy"
							value={proxy}
							onChange={(e) => setProxy(e.target.value as Proxy)}
							className="w-full"
						>
							<option value="traefik">Traefik</option>
							<option value="nginx">nginx on the host</option>
							<option value="nginx-container">nginx in a container</option>
						</Select>
					</Field>
					<Field
						id="tls-mode"
						label="TLS certificates"
						hint={
							proxy === 'traefik'
								? tlsMode === 'acme'
									? "Let's Encrypt issues one per domain over HTTP."
									: "Traefik serves the certificate in its default store."
								: 'used with Traefik only.'
						}
					>
						<Select
							id="tls-mode"
							value={tlsMode}
							onChange={(e) => setTlsMode(e.target.value as TlsMode)}
							className="w-full"
						>
							<option value="acme">Let's Encrypt</option>
							<option value="origin-cert">Cloudflare origin certificate</option>
						</Select>
					</Field>
					<Input
						label="base domain"
						placeholder="apps.example.com"
						value={baseDomain}
						onChange={(e) => setBaseDomain(e.target.value)}
						hint={
							<>
								point <code className="font-mono">*.{baseDomain.trim() || 'apps.example.com'}</code> here
								and apps get <code className="font-mono">{`<app>.${baseDomain.trim() || 'apps.example.com'}`}</code>.
							</>
						}
					/>
					<Input
						label="public IP"
						placeholder={server.host}
						value={ingressIp}
						onChange={(e) => setIngressIp(e.target.value)}
						hint="the IPv4 your DNS records point at. empty: the host above."
					/>
					<Input
						label="build host"
						placeholder="builder.example.com"
						value={buildHost}
						onChange={(e) => setBuildHost(e.target.value)}
						hint="a separate server that builds this server's images. empty: build on this server."
					/>
					<div className="flex flex-wrap items-center gap-3 md:col-span-2">
						<Button type="submit" variant="outline" size="sm" disabled={saving || !dirty}>
							{saving ? 'saving…' : 'save'}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={checkDns}
							disabled={checkingDns || dirty || !server.effectiveBaseDomain}
							title={dirty ? 'save first' : undefined}
						>
							<RefreshCw className={`h-3 w-3 ${checkingDns ? 'animate-spin' : ''}`} />
							check DNS
						</Button>
						{error && <span className="text-xs text-destructive">{error}</span>}
					</div>
				</form>
				{dns && <DnsResult dns={dns} />}
				{server.effectiveBaseDomain &&
					server.effectiveBaseDomain !== (server.settings.baseDomain ?? null) && (
						<p className="mt-3 text-xs text-muted-foreground">
							powder currently uses{' '}
							<code className="font-mono text-foreground">{server.effectiveBaseDomain}</code> for
							this server (deprecated fallback). save a base domain to stop using it.
						</p>
					)}
			</CardContent>
		</Card>
	)
}

function DnsResult({ dns }: { dns: CachedDnsCheck }) {
	switch (dns.state) {
		case 'ok':
			return (
				<Alert tone="success" title="DNS ok" className="mt-4">
					<span className="font-mono text-xs">{dns.probe}</span> resolves to{' '}
					<span className="font-mono text-xs">{dns.resolved.join(', ')}</span>.
				</Alert>
			)
		case 'mismatch':
			return (
				<Alert tone="warning" title="DNS mismatch" className="mt-4">
					<span className="font-mono text-xs">{dns.probe}</span> resolves to{' '}
					<span className="font-mono text-xs">{dns.resolved.join(', ')}</span>, expected{' '}
					<span className="font-mono text-xs">{dns.expected}</span>. behind a Cloudflare proxy the
					record shows Cloudflare's IPs, which is expected there.
				</Alert>
			)
		case 'unresolved':
			return (
				<Alert tone="destructive" title="no wildcard record" className="mt-4">
					<span className="font-mono text-xs">{dns.probe}</span> did not resolve ({dns.error}). add
					an A record <span className="font-mono text-xs">*.{dns.baseDomain}</span>
					{dns.expected ? (
						<>
							{' '}
							pointing at <span className="font-mono text-xs">{dns.expected}</span>
						</>
					) : null}
					.
				</Alert>
			)
		case 'no-target':
			return (
				<Alert tone="warning" title="no public IP" className="mt-4">
					set the public IP: the host is not an IPv4 address and did not resolve.
				</Alert>
			)
		default:
			return null
	}
}

function BootstrapCard({
	serverId,
	check,
	onCheck,
}: {
	serverId: string
	check: BootstrapCheckResult | null
	onCheck: (c: BootstrapCheckResult) => void
}) {
	const toast = useToast()
	const [checking, setChecking] = useState(false)
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [applying, setApplying] = useState(false)
	const [results, setResults] = useState<BootstrapStepResult[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	// Replace steps (an outdated helper) are opt-in: unticked each time the dialog opens.
	const [replaceIds, setReplaceIds] = useState<string[]>([])

	async function call(body: object) {
		const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/bootstrap`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		return (await res.json().catch(() => ({}))) as {
			check?: BootstrapCheckResult
			steps?: BootstrapStepResult[]
			error?: string
		}
	}

	async function runCheck() {
		setChecking(true)
		setError(null)
		try {
			const data = await call({ mode: 'check' })
			if (data.check) onCheck(data.check)
			else setError(data.error ?? 'check failed')
		} catch {
			setError('check failed: network error')
		} finally {
			setChecking(false)
		}
	}

	async function apply() {
		if (!check) return
		setApplying(true)
		setError(null)
		try {
			const data = await call({ mode: 'apply', steps: confirmedStepIds(check.plan.steps, replaceIds) })
			setConfirmOpen(false)
			if (data.steps) setResults(data.steps)
			if (data.check) onCheck(data.check)
			if (data.error) setError(data.error)
			else if (data.steps?.every((s) => s.ok)) toast.success('missing pieces fixed')
		} catch {
			toast.error('fix failed: network error')
		} finally {
			setApplying(false)
		}
	}

	const allSteps = check?.plan.steps ?? []
	const steps = allSteps.filter((s) => !s.replaces)
	const replaceSteps = allSteps.filter((s) => s.replaces)

	return (
		// id server-check: the setup checklist links to this card for a failed check
		<Card id="server-check">
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle>server check</CardTitle>
					<div className="flex gap-2">
						<Button variant="outline" size="sm" onClick={runCheck} disabled={checking || applying}>
							<Stethoscope className={`h-3 w-3 ${checking ? 'animate-pulse' : ''}`} />
							check server
						</Button>
						{allSteps.length > 0 && (
							<Button
								size="sm"
								onClick={() => {
									setReplaceIds([])
									setConfirmOpen(true)
								}}
								disabled={checking || applying}
							>
								<Wrench className="h-3 w-3" />
								fix missing pieces
							</Button>
						)}
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{error && (
					<Alert tone="destructive" title="server check failed">
						<span className="font-mono text-xs">{error}</span>
					</Alert>
				)}
				{!check ? (
					<p className="text-sm text-muted-foreground">
						read-only: Docker, the proxy, networks, helpers, disk and memory.
					</p>
				) : (
					<>
						<p className="text-xs text-muted-foreground">
							{check.green ? 'all required pieces are there' : 'some pieces are missing'} · checked{' '}
							{formatDateTime(check.at)}
						</p>
						<ul className="divide-y divide-border">
							{check.items.map((i) => (
								<li key={i.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
									<StatusLabel tone={CHECK_TONE[i.state]} className="w-56 shrink-0">
										{i.label}
									</StatusLabel>
									<span className="ph-no-capture text-xs text-muted-foreground">{i.detail}</span>
								</li>
							))}
						</ul>
						{check.plan.skipped.length > 0 && (
							<div className="space-y-1 text-xs text-muted-foreground">
								<p className="font-medium text-foreground">not done automatically</p>
								{check.plan.skipped.map((s) => (
									<p key={s.id}>
										<code className="font-mono">{s.id}</code>: {s.reason}
									</p>
								))}
							</div>
						)}
					</>
				)}
				{results && (
					<div className="space-y-2">
						<p className="text-xs font-medium">last fix run</p>
						{results.map((r) => (
							<div key={r.id} className="space-y-1">
								<div className="flex items-center justify-between gap-2">
									<StatusLabel tone={r.ok ? 'success' : 'destructive'}>{r.title}</StatusLabel>
									{r.output && (
										<CopyButton
											value={r.output}
											label={`copy the output of ${r.title}`}
											targetId={`fix-output-${r.id}`}
										/>
									)}
								</div>
								{r.output && (
									<pre
										id={`fix-output-${r.id}`}
										className="ph-no-capture max-h-48 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-2xs"
									>
										{r.output}
									</pre>
								)}
							</div>
						))}
					</div>
				)}
			</CardContent>
			<ConfirmDialog
				open={confirmOpen}
				title="fix missing pieces?"
				description={
					<div className="space-y-3">
						<p>
							powder re-checks the server, then runs exactly these commands over SSH, in order. it
							never restarts or changes an existing container, Traefik or nginx, and never runs ufw.
						</p>
						{steps.some((s) => s.id === 'install-docker' || s.id === 'start-traefik') && (
							<p className="text-warning">
								{steps.some((s) => s.id === 'install-docker')
									? 'installing Docker changes iptables: Docker adds its own chains and NAT rules. '
									: ''}
								{steps.some((s) => s.id === 'start-traefik')
									? 'publishing 80/443 for Traefik adds Docker iptables rules that bypass ufw.'
									: ''}
							</p>
						)}
						{steps.map((s) => (
							<div key={s.id} className="space-y-1">
								<p className="text-xs font-medium text-foreground">{s.title}</p>
								<pre className="ph-no-capture max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-2xs">
									{s.command}
								</pre>
							</div>
						))}
						{replaceSteps.length > 0 && (
							<div className="space-y-2">
								<p className="text-xs font-medium text-foreground">
									replace outdated helpers (only the ones you tick)
								</p>
								{replaceSteps.map((s) => (
									<div key={s.id} className="space-y-1">
										<label className="flex items-start gap-2 text-xs text-foreground">
											<input
												type="checkbox"
												className="mt-0.5"
												checked={replaceIds.includes(s.id)}
												onChange={(e) =>
													setReplaceIds((ids) =>
														e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id),
													)
												}
											/>
											{s.title}
										</label>
										<pre className="ph-no-capture max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-2xs">
											{s.command}
										</pre>
									</div>
								))}
							</div>
						)}
					</div>
				}
				confirmLabel="run these"
				confirmDisabled={steps.length === 0 && replaceIds.length === 0}
				loading={applying}
				onConfirm={apply}
				onClose={() => !applying && setConfirmOpen(false)}
			/>
		</Card>
	)
}
