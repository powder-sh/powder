'use client'

// Per-project domains tab. Three steps per hostname:
//   1. add it (POST /api/projects/:id/domains): a pending row with a TXT challenge
//   2. create the DNS records the row lists (lib/domain-records.ts), then
//      "check" (POST .../verify): verified, or verify_failed with the reason
//   3. apply once verified (POST .../apply): Traefik labels, container recreated, live
//
// Every row that is not proven yet lists its records with a copy button each
// and the stored error from the last check (redacted server-side).
//
// A live apex row also says what its www does (and a www row what its apex does):
// GET .../domains/www probes it live, on load and on "recheck" (lib/www-status.ts).

import { AgentHelp } from '@/components/agent-help'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { SkeletonList } from '@/components/ui/skeleton'
import { StatusDot } from '@/components/ui/status'
import { domainPrompt } from '@/lib/agent-help-prompts'
import { cn } from '@/lib/cn'
import { type DnsRecord, domainRecords, needsDnsRecords } from '@/lib/domain-records'
import { formatDateTime } from '@/lib/format'
import { type WwwCheck, wwwSibling, wwwStatusLine } from '@/lib/www-status'
import { AlertCircle, Globe, RefreshCw, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useProject } from '../_lib/project-context'

interface AppDomain {
	id: string
	appRepoId: string
	previewDeployId?: string | null
	hostname: string
	status: 'pending' | 'verified' | 'verify_failed' | 'live' | 'apply_failed' | 'failed'
	statusError: string | null
	verifyChallenge: string | null
	verifiedAt: string | null
	appliedAt: string | null
	appliedError: string | null
	createdAt: string
}

/** One row's www line: probing, probed, or the request failed. */
type WwwState = { state: 'loading' } | { state: 'error' } | { state: 'done'; check: WwwCheck }

/** The rows that get a www line: live, not a preview's, an apex or www.<apex>. */
function wwwCandidates(domains: AppDomain[]): string[] {
	return domains
		.filter((d) => d.status === 'live' && !d.previewDeployId && wwwSibling(d.hostname) !== null)
		.map((d) => d.hostname)
}

interface DomainsResponse {
	autoAssigned: string | null
	ingressIp?: string | null
	domains: AppDomain[]
}

const STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
	pending: { label: 'waiting for DNS', variant: 'warning' },
	verified: { label: 'verified', variant: 'info' },
	verify_failed: { label: 'DNS check failed', variant: 'destructive' },
	live: { label: 'live', variant: 'success' },
	apply_failed: { label: 'apply failed', variant: 'destructive' },
}

function StatusBadge({ status }: { status: string }) {
	const m = STATUS[status] ?? { label: 'failed', variant: 'destructive' as const }
	return <Badge variant={m.variant}>{m.label}</Badge>
}

export default function DomainsPage() {
	const { id, project } = useProject()
	const [data, setData] = useState<DomainsResponse | null>(null)
	const [hostnameInput, setHostnameInput] = useState('')
	const [adding, setAdding] = useState(false)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
	const [www, setWww] = useState<Record<string, WwwState>>({})

	const load = useCallback(async () => {
		const res = await fetch(`/api/projects/${id}/domains`)
		const json = (await res.json()) as DomainsResponse
		setData(json)
	}, [id])

	useEffect(() => {
		load()
	}, [load])

	// A stable key, so a reload with the same live rows does not probe again.
	const wwwHosts = useMemo(() => (data ? wwwCandidates(data.domains) : []), [data])
	const wwwKey = wwwHosts.join(' ')

	const loadWww = useCallback(
		async (fresh: boolean) => {
			const hosts = wwwKey ? wwwKey.split(' ') : []
			if (hosts.length === 0) return
			setWww((prev) => {
				const next = { ...prev }
				for (const h of hosts) next[h] = { state: 'loading' }
				return next
			})
			const result: Record<string, WwwState> = {}
			try {
				const res = await fetch(`/api/projects/${id}/domains/www${fresh ? '?fresh=1' : ''}`)
				const json = res.ok ? ((await res.json()) as { checks?: WwwCheck[] }) : {}
				for (const c of json.checks ?? []) result[c.hostname] = { state: 'done', check: c }
			} catch {
				// every host below falls back to "could not check"
			}
			for (const h of hosts) result[h] ??= { state: 'error' }
			setWww(result)
		},
		[id, wwwKey],
	)

	useEffect(() => {
		void loadWww(false)
	}, [loadWww])

	const addDomain = async () => {
		setError(null)
		const hostname = hostnameInput.trim().toLowerCase()
		if (!hostname) return
		setAdding(true)
		try {
			const res = await fetch(`/api/projects/${id}/domains`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ hostname }),
			})
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string }
				setError(err.error ?? `add failed (${res.status})`)
				return
			}
			setHostnameInput('')
			await load()
		} finally {
			setAdding(false)
		}
	}

	const post = async (hostname: string, action: 'verify' | 'apply') => {
		setError(null)
		setBusy(hostname)
		try {
			await fetch(`/api/projects/${id}/domains/${encodeURIComponent(hostname)}/${action}`, {
				method: 'POST',
			})
			await load()
		} finally {
			setBusy(null)
		}
	}

	const remove = async (hostname: string) => {
		setConfirmRemove(null)
		setBusy(hostname)
		try {
			const res = await fetch(
				`/api/projects/${id}/domains?hostname=${encodeURIComponent(hostname)}`,
				{ method: 'DELETE' },
			)
			if (res.ok) setError(null)
			else {
				const err = (await res.json().catch(() => ({}))) as { error?: string }
				setError(err.error ?? `remove failed (${res.status})`)
			}
			await load()
		} finally {
			setBusy(null)
		}
	}

	if (!project || !data) return <SkeletonList />

	return (
		<div className="space-y-6">
			<div>
				<h2 className="text-base font-semibold tracking-tight">domains</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					add a domain you own, create the DNS records it lists, and powder routes it to this app.
				</p>
			</div>

			{data.autoAssigned && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-card">
					<code className="min-w-0 font-mono [overflow-wrap:anywhere]">
						<DnsText value={data.autoAssigned} />
					</code>
					<Badge variant="outline">default host</Badge>
				</div>
			)}

			<form
				onSubmit={(e) => {
					e.preventDefault()
					void addDomain()
				}}
				className="flex flex-col gap-2 sm:flex-row"
			>
				<Input
					aria-label="domain to add"
					placeholder="app.example.com"
					value={hostnameInput}
					onChange={(e) => setHostnameInput(e.target.value)}
					className="font-mono sm:flex-1"
					disabled={adding}
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
				/>
				<Button
					type="submit"
					variant="outline"
					loading={adding}
					disabled={!hostnameInput.trim()}
				>
					{!adding && <Globe className="h-3.5 w-3.5" />}
					{adding ? 'adding…' : 'add domain'}
				</Button>
			</form>
			{error && (
				<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
					<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
					<span>{error}</span>
				</div>
			)}

			{data.domains.length > 0 && (
				<div className="space-y-3">
					{data.domains.map((d) => (
						<DomainRow
							key={d.id}
							domain={d}
							autoAssigned={data.autoAssigned}
							ingressIp={data.ingressIp ?? null}
							busy={busy === d.hostname}
							www={www[d.hostname]}
							onRecheckWww={() => void loadWww(true)}
							onVerify={() => post(d.hostname, 'verify')}
							onApply={() => post(d.hostname, 'apply')}
							onRemove={() => setConfirmRemove(d.hostname)}
						/>
					))}
				</div>
			)}

			<AgentHelp
				title="point a domain at this app"
				description="creates or lists the TXT and routing records for your DNS provider, then checks they resolve."
				prompt={domainPrompt({
					app: project.containerName,
					autoAssigned: data.autoAssigned,
					domains: data.domains,
				})}
				note="includes the hostnames, their TXT values and the routing target. no secrets."
			/>

			<ConfirmDialog
				open={confirmRemove !== null}
				title={`remove ${confirmRemove ?? ''}?`}
				description="powder stops tracking this domain. a live domain keeps routing until powder next rewrites this app's domains, and the DNS records stay at your provider."
				confirmLabel="remove"
				danger
				onConfirm={() => {
					if (confirmRemove) void remove(confirmRemove)
				}}
				onClose={() => setConfirmRemove(null)}
			/>
		</div>
	)
}

function DomainRow({
	domain,
	autoAssigned,
	ingressIp,
	busy,
	www,
	onRecheckWww,
	onVerify,
	onApply,
	onRemove,
}: {
	domain: AppDomain
	autoAssigned: string | null
	ingressIp: string | null
	busy: boolean
	www?: WwwState
	onRecheckWww: () => void
	onVerify: () => void
	onApply: () => void
	onRemove: () => void
}) {
	const unproven = needsDnsRecords(domain.status)
	const canApply = domain.status === 'verified' || domain.status === 'apply_failed'
	const { records, routingMissing } = domainRecords({ ...domain, autoAssigned, ingressIp })
	const err = domain.status === 'apply_failed' ? (domain.appliedError ?? domain.statusError) : domain.statusError
	const showErr = domain.status !== 'live' && domain.status !== 'verified' && !!err

	return (
		<div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
				<code className="min-w-0 basis-full font-mono text-sm [overflow-wrap:anywhere] sm:basis-0 sm:flex-1">
					<DnsText value={domain.hostname} />
				</code>
				<StatusBadge status={domain.status} />
				<div className="flex items-center gap-1">
					{unproven && (
						<Button variant="outline" size="sm" onClick={onVerify} loading={busy}>
							{!busy && <RefreshCw className="h-3.5 w-3.5" />}
							{showErr ? 'check again' : 'check DNS'}
						</Button>
					)}
					{canApply && (
						<Button variant="outline" size="sm" onClick={onApply} loading={busy}>
							{!busy && <Globe className="h-3.5 w-3.5" />}
							{domain.status === 'apply_failed' ? 'apply again' : 'apply'}
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onRemove}
						disabled={busy}
						aria-label={`remove ${domain.hostname}`}
						title="remove"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			</div>

			{showErr && (
				<div className="flex items-start gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
					<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					<p className="ph-no-capture min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{err}</p>
					{err && (
						<CopyButton
							value={`${domain.hostname}: ${err}`}
							label="copy the error"
							className="-my-1.5 text-destructive/80 hover:text-destructive"
						/>
					)}
				</div>
			)}

			{unproven && (records.length > 0 || routingMissing) && (
				<div className="border-t border-border bg-muted/30 px-4 py-3">
					<p className="text-xs text-muted-foreground">create at your DNS provider:</p>
					{records.length > 0 && (
						<div className="mt-2 overflow-hidden rounded-md border border-border bg-card">
							<div className="hidden grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1.4fr)] gap-3 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground sm:grid">
								<span>type</span>
								<span>name</span>
								<span>value</span>
							</div>
							<ul className="divide-y divide-border">
								{records.map((r) => (
									<RecordRow key={`${r.type}-${r.name}`} record={r} />
								))}
							</ul>
						</div>
					)}
					{routingMissing && (
						<p className="mt-2 text-xs text-muted-foreground">also needed: {routingMissing}.</p>
					)}
				</div>
			)}

			{domain.status === 'live' && (domain.appliedAt || www) && (
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
					{www && (
						<WwwLine hostname={domain.hostname} www={www} onRecheck={onRecheckWww} />
					)}
					{domain.appliedAt && <span>live since {formatDateTime(domain.appliedAt)}</span>}
				</div>
			)}
		</div>
	)
}

// What the www (or apex) sibling of a live domain does, from a live probe.
function WwwLine({
	hostname,
	www,
	onRecheck,
}: {
	hostname: string
	www: WwwState
	onRecheck: () => void
}) {
	const sibling = wwwSibling(hostname) ?? hostname
	const loading = www.state === 'loading'
	const { text, tone } = loading
		? { text: `checking ${sibling}`, tone: 'neutral' as const }
		: www.state === 'done'
			? wwwStatusLine(www.check)
			: { text: `could not check ${sibling}`, tone: 'neutral' as const }
	return (
		<span className="flex min-w-0 items-center gap-1.5" aria-live="polite">
			<StatusDot tone={tone} pulse={loading} />
			<span
				className={cn(
					'min-w-0 [overflow-wrap:anywhere]',
					loading && 'animate-shimmer',
					tone === 'destructive' && 'text-destructive',
					tone === 'warning' && 'text-warning',
					tone === 'success' && 'text-foreground',
				)}
			>
				{text}
			</span>
			<button
				type="button"
				onClick={onRecheck}
				disabled={loading}
				aria-label={`check ${sibling} again`}
				className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 sm:-my-1 sm:h-6 sm:w-6"
			>
				<RefreshCw className={cn('h-3 w-3', loading && 'motion-safe:animate-spin')} aria-hidden="true" />
			</button>
		</span>
	)
}

function RecordRow({ record }: { record: DnsRecord }) {
	return (
		<li className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-3 py-2 text-xs sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1.4fr)]">
			<span className="row-span-2 self-start pt-1 font-mono font-medium sm:row-span-1 sm:self-center sm:pt-0">
				{record.type}
			</span>
			<CopyValue value={record.name} label={`copy the ${record.type} record name`} />
			<CopyValue value={record.value} label={`copy the ${record.type} record value`} />
		</li>
	)
}

// A DNS name or record value with a line-break opportunity (<wbr>) after every
// dot, hyphen, underscore and equals sign, so a long hostname wraps between its
// labels instead of mid-word. overflow-wrap on the parent still breaks a single
// label that is longer than the line. <wbr> adds no text: a selection or the
// copy button gets the value unchanged.
function DnsText({ value }: { value: string }) {
	let at = 0
	return (
		<>
			{value.split(/(?<=[._=-])/).map((part) => {
				const key = at
				at += part.length
				return (
					<Fragment key={key}>
						{key > 0 && <wbr />}
						{part}
					</Fragment>
				)
			})}
		</>
	)
}

function CopyValue({ value, label }: { value: string; label: string }) {
	return (
		<span className="flex min-w-0 items-center gap-1">
			<code className="ph-no-capture min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">
				<DnsText value={value} />
			</code>
			<CopyButton value={value} label={label} size="sm" />
		</span>
	)
}
