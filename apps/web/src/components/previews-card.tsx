'use client'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useState } from 'react'
import { Copy, ExternalLink, GitBranch, Globe, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface Preview {
	id: string
	branch: string
	branchSlug: string
	containerName: string
	url: string | null
	status: 'pending' | 'running' | 'failed' | 'torn-down'
	lastDeployedAt: string | null
	lastError: string | null
	createdAt: string
}

interface PreviewDomain {
	id: string
	hostname: string
	status: 'pending' | 'live' | 'failed'
	statusError: string | null
	verifyChallenge: string | null
	previewDeployId: string | null
}

export function PreviewsCard({
	serverId,
	containerName,
}: {
	serverId: string
	containerName: string
}) {
	const [previews, setPreviews] = useState<Preview[] | null>(null)
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
	const [allDomains, setAllDomains] = useState<PreviewDomain[]>([])
	const [ingressIp, setIngressIp] = useState<string | null>(null)
	const [baseDomain, setBaseDomain] = useState<string | null | undefined>(undefined)
	const base = `/api/servers/${serverId}/containers/${containerName}/previews`
	const domainsBase = `/api/servers/${serverId}/containers/${containerName}/domains`

	async function load() {
		const [pRes, dRes] = await Promise.all([fetch(base), fetch(domainsBase)])
		if (pRes.ok) {
			const data = await pRes.json()
			setPreviews(data.previews ?? [])
		} else {
			setPreviews([])
		}
		if (dRes.ok) {
			const data = await dRes.json()
			setAllDomains(data.domains ?? [])
			setIngressIp(data.ingressIp ?? null)
			setBaseDomain(data.baseDomain ?? null)
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the server or container changes; load is recreated every render and reads both props itself
	useEffect(() => {
		load()
	}, [serverId, containerName])

	async function remove(id: string) {
		setConfirmRemove(null)
		await fetch(`${base}/${id}`, { method: 'DELETE' })
		await load()
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<CardTitle className="flex items-center gap-2">
						<GitBranch className="h-4 w-4 text-powder" />
						previews
					</CardTitle>
					{previews && previews.length > 0 && (
						<Badge variant="outline" className="font-mono text-2xs">
							{previews.length} active
						</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{previews === null ? (
					<SkeletonList rows={2} bare />
				) : previews.length === 0 ? (
					<div className="space-y-2">
						{baseDomain === null && (
							<p className="text-xs text-destructive">
								no base domain set on this server: previews are ignored until servers.base_domain is
								set (see docs/SELF-HOSTING.md).
							</p>
						)}
						<p className="text-xs text-muted-foreground">
							no preview deploys yet. push to any branch (other than{' '}
							<span className="font-mono">main</span>) and powder spins up a parallel container at
							<br />
							<span className="font-mono text-foreground">
								pv-{containerName}-&lt;branch&gt;.{baseDomain ?? '<base domain>'}
							</span>
						</p>
						<p className="text-2xs text-muted-foreground">
							previews never run migrations. If a preview's env points at this app's database, be
							careful with destructive migrations.
						</p>
					</div>
				) : (
					<div className="divide-y divide-border rounded-md border border-border">
						{previews.map((p) => (
							<PreviewRow
								key={p.id}
								preview={p}
								domains={allDomains.filter((d) => d.previewDeployId === p.id)}
								domainsBase={domainsBase}
								ingressIp={ingressIp}
								onRemove={() => setConfirmRemove(p.id)}
								onChanged={load}
							/>
						))}
					</div>
				)}
			</CardContent>
			<ConfirmDialog
				open={confirmRemove !== null}
				title="tear down this preview?"
				description="container + working dir will be removed."
				confirmLabel="tear down"
				danger
				onConfirm={() => {
					if (confirmRemove) void remove(confirmRemove)
				}}
				onClose={() => setConfirmRemove(null)}
			/>
		</Card>
	)
}

function PreviewRow({
	preview,
	domains,
	domainsBase,
	ingressIp,
	onRemove,
	onChanged,
}: {
	preview: Preview
	domains: PreviewDomain[]
	domainsBase: string
	ingressIp: string | null
	onRemove: () => void
	onChanged: () => void | Promise<void>
}) {
	const [showAddDomain, setShowAddDomain] = useState(false)
	return (
		<div className="px-3 py-2.5 text-xs">
			<div className="grid grid-cols-12 gap-3">
				<div className="col-span-4 min-w-0">
					<div className="flex items-center gap-1.5 truncate font-mono">
						<GitBranch className="h-3 w-3 text-muted-foreground" />
						{preview.branch}
					</div>
					<div className="mt-0.5 truncate text-2xs text-muted-foreground font-mono">
						{preview.containerName}
					</div>
				</div>
				<div className="col-span-5 min-w-0">
					{preview.url ? (
						<a
							href={preview.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 truncate font-mono text-xs hover:text-powder"
						>
							{preview.url.replace(/^https?:\/\//, '')}
							<ExternalLink className="h-3 w-3 shrink-0" />
						</a>
					) : (
						<span className="text-2xs text-muted-foreground">-</span>
					)}
					{preview.lastError && (
						<div className="mt-0.5 truncate text-2xs text-destructive">{preview.lastError}</div>
					)}
				</div>
				<div className="col-span-2">
					<StatusBadge status={preview.status} />
				</div>
				<div className="col-span-1 text-right flex items-center justify-end gap-1">
					<button
						type="button"
						onClick={() => setShowAddDomain((v) => !v)}
						className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
						title="custom domain"
					>
						<Globe className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onRemove}
						className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
						title="tear down"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			{(showAddDomain || domains.length > 0) && (
				<PreviewDomains
					previewId={preview.id}
					domains={domains}
					domainsBase={domainsBase}
					ingressIp={ingressIp}
					onChanged={onChanged}
				/>
			)}
		</div>
	)
}

function PreviewDomains({
	previewId,
	domains,
	domainsBase,
	ingressIp,
	onChanged,
}: {
	previewId: string
	domains: PreviewDomain[]
	domainsBase: string
	ingressIp: string | null
	onChanged: () => void | Promise<void>
}) {
	const [hostname, setHostname] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function add() {
		setBusy(true)
		try {
			setError(null)
			const res = await fetch(domainsBase, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ hostname: hostname.trim().toLowerCase(), previewId }),
			})
			if (!res.ok) {
				const d = await res.json().catch(() => ({}))
				setError(d.error ?? 'failed')
				return
			}
			setHostname('')
			await onChanged()
		} catch {
			setError('failed: network error')
		} finally {
			setBusy(false)
		}
	}
	async function verify(id: string) {
		await fetch(`${domainsBase}/${id}`, { method: 'POST' })
		await onChanged()
	}
	async function remove(id: string) {
		await fetch(`${domainsBase}/${id}`, { method: 'DELETE' })
		await onChanged()
	}

	return (
		<div className="mt-2 ml-5 space-y-2 rounded-md border border-border bg-muted/30 p-2">
			{domains.map((d) => (
				<div key={d.id} className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Globe className="h-3 w-3 text-muted-foreground" />
						<span className="font-mono text-2xs">{d.hostname}</span>
						{d.status === 'live' ? (
							<Badge variant="success">live</Badge>
						) : d.status === 'failed' ? (
							<Badge variant="destructive">failed</Badge>
						) : (
							<Badge variant="warning">pending</Badge>
						)}
						{d.statusError && <span className="text-2xs text-destructive">{d.statusError}</span>}
						{d.status !== 'live' && d.verifyChallenge && (
							<span className="flex items-center gap-1 font-mono text-2xs text-muted-foreground">
								TXT _powder-verify.{d.hostname} = {d.verifyChallenge}
								<button
									type="button"
									onClick={() => navigator.clipboard?.writeText(d.verifyChallenge ?? '')}
									aria-label="copy TXT value"
									title="copy TXT value"
									className="rounded-md p-1 hover:bg-accent"
								>
									<Copy className="h-3 w-3" />
								</button>
							</span>
						)}
					</div>
					<div className="flex items-center gap-1">
						{d.status !== 'live' && (
							<Button variant="ghost" size="sm" onClick={() => verify(d.id)}>
								<RefreshCw className="h-3 w-3" /> verify
							</Button>
						)}
						<button
							type="button"
							onClick={() => remove(d.id)}
							aria-label="remove domain"
							title="remove domain"
							className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
						>
							<Trash2 className="h-3 w-3" />
						</button>
					</div>
				</div>
			))}
			<div className="flex items-center gap-2">
				<Input
					value={hostname}
					onChange={(e) => setHostname(e.target.value)}
					placeholder="pr-42.widget.com"
					aria-label="custom domain for this preview"
					inputSize="sm"
					className="min-w-0 flex-1 font-mono"
				/>
				<Button size="sm" onClick={add} disabled={busy || !hostname.trim()}>
					<Plus className="h-3 w-3" />
					add
				</Button>
			</div>
			{ingressIp && (
				<p className="text-2xs text-muted-foreground">
					DNS: A record to <span className="font-mono">{ingressIp}</span> and the TXT record, then
					verify.
				</p>
			)}
			{error && <p className="text-2xs text-destructive">{error}</p>}
		</div>
	)
}

function StatusBadge({ status }: { status: Preview['status'] }) {
	if (status === 'running') return <Badge variant="success">running</Badge>
	if (status === 'failed') return <Badge variant="destructive">failed</Badge>
	if (status === 'pending') return <Badge variant="warning">pending</Badge>
	return <Badge variant="outline">{status}</Badge>
}
