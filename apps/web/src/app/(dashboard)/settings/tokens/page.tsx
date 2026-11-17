'use client'

import { Alert } from '@/components/ui/alert'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { TableFrame } from '@/components/ui/table'
import { ChevronRight, KeyRound } from 'lucide-react'

import { McpConnectCard } from '@/components/mcp-connect-card'

import { SkeletonList } from '@/components/ui/skeleton'
// API tokens: list, create, revoke over the existing /api/tokens endpoints
// (same session auth and rules as the API). Tokens created here are
// full-access, or limited to the MCP read / read-write presets, or read plus
// write for chosen apps only (lib/token-scopes.ts); the plaintext is shown once.

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldRow, Input, Select } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { formatDate, timeAgo } from '@/lib/format'
import { MCP_READ_SCOPES, MCP_WRITE_SCOPES, mcpWriteScopesForApps } from '@/lib/token-scopes'
import { useCallback, useEffect, useState } from 'react'

type Access = 'full' | 'mcp-read' | 'mcp-write' | 'mcp-apps'

const ACCESS_SCOPES: Record<Exclude<Access, 'mcp-apps'>, readonly string[] | undefined> = {
	full: undefined,
	'mcp-read': MCP_READ_SCOPES,
	'mcp-write': MCP_WRITE_SCOPES,
}

interface ProjectRow {
	id: string
	containerName: string
	serverName?: string
}

interface TokenRow {
	id: string
	name: string
	prefix: string
	createdAt: string
	lastUsedAt: string | null
	scopes: string[] | null
	expiresAt: string | null
}

export default function TokensPage() {
	const toast = useToast()
	const [tokens, setTokens] = useState<TokenRow[] | null>(null)
	const [name, setName] = useState('')
	const [days, setDays] = useState('')
	const [access, setAccess] = useState<Access>('full')
	const [busy, setBusy] = useState(false)
	const [fresh, setFresh] = useState<string | null>(null)
	const [projects, setProjects] = useState<ProjectRow[] | null>(null)
	const [apps, setApps] = useState<Set<string>>(new Set())
	const [confirmRevoke, setConfirmRevoke] = useState<TokenRow | null>(null)

	const load = useCallback(() => {
		fetch('/api/tokens')
			.then((r) => r.json())
			.then((d) => setTokens(d.tokens ?? []))
			.catch(() => setTokens((p) => p ?? []))
	}, [])
	useEffect(() => {
		load()
	}, [load])

	useEffect(() => {
		if (access !== 'mcp-apps' || projects !== null) return
		fetch('/api/projects')
			.then((r) => (r.ok ? r.json() : null))
			.then((d: { projects?: ProjectRow[] } | null) => setProjects(d?.projects ?? []))
			.catch(() => setProjects([]))
	}, [access, projects])

	function toggleApp(id: string) {
		setApps((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}

	async function create(e: React.FormEvent) {
		e.preventDefault()
		if (access === 'mcp-apps' && apps.size === 0) {
			toast.error('pick at least one app')
			return
		}
		setBusy(true)
		try {
			const body: { name: string; expiresInDays?: number; scopes?: string[] } = {
				name: name.trim() || 'untitled',
			}
			if (days.trim()) body.expiresInDays = Number(days)
			const scopes =
				access === 'mcp-apps' ? mcpWriteScopesForApps([...apps]) : ACCESS_SCOPES[access]
			if (scopes) body.scopes = [...scopes]
			const res = await fetch('/api/tokens', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
			const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
			if (!res.ok || !data.token) toast.error(data.error ?? `create failed (${res.status})`)
			else {
				setFresh(data.token)
				setName('')
				setDays('')
			}
		} finally {
			setBusy(false)
			load()
		}
	}

	async function revoke(t: TokenRow) {
		setConfirmRevoke(null)
		const res = await fetch(`/api/tokens?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' })
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string }
			toast.error(err.error ?? `revoke failed (${res.status})`)
		}
		load()
	}

	return (
		<div className="space-y-6">
			<title>API tokens · powder</title>
			<PageHeader
				back={{ href: '/settings', label: 'settings' }}
				title="API tokens"
				description="bearer tokens for the powder API, CI and coding agents (MCP). a new token is shown once."
			/>
			{fresh && (
				<Alert
					tone="success"
					title="token created. copy it now, it is not shown again."
					action={
						<Button size="sm" variant="outline" onClick={() => setFresh(null)}>
							done
						</Button>
					}
				>
					<code className="ph-no-capture mt-1 block select-all break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground">
						{fresh}
					</code>
				</Alert>
			)}

			{tokens === null ? (
				<SkeletonList />
			) : tokens.length === 0 ? (
				<EmptyState icon={KeyRound} title="no tokens yet" compact>
					create one below to call the powder API from scripts, CI or a coding agent.
				</EmptyState>
			) : (
				<TableFrame>
					<table className="w-full text-left text-sm">
						<caption className="sr-only">your active API tokens</caption>
						<thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
							<tr>
								<th scope="col" className="px-3 py-2 font-medium">
									name
								</th>
								<th scope="col" className="px-3 py-2 font-medium">
									token
								</th>
								<th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
									last used
								</th>
								<th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
									expires
								</th>
								<th scope="col" className="px-3 py-2 text-right font-medium">
									actions
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{tokens.map((t) => (
								<tr key={t.id}>
									<td className="px-3 py-2">
										{t.name}
										{t.scopes && <span className="ml-2 text-xs text-muted-foreground">scoped</span>}
									</td>
									<td className="px-3 py-2 font-mono text-xs">{t.prefix}…</td>
									<td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
										{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'never'}
									</td>
									<td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
										{t.expiresAt ? formatDate(t.expiresAt) : 'never'}
									</td>
									<td className="px-3 py-2 text-right">
										<Button
											size="sm"
											variant="destructive-outline"
											onClick={() => setConfirmRevoke(t)}
											aria-label={`revoke ${t.name}`}
										>
											revoke
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableFrame>
			)}
			<section aria-labelledby="create-token" className="space-y-3">
				<h2 id="create-token" className="text-sm font-semibold tracking-tight">
					create a token
				</h2>
				<form onSubmit={create} className="rounded-lg border border-border bg-card p-4 shadow-card">
					<FieldRow
						columns="minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.25fr)"
						action={
							<Button type="submit" loading={busy}>
								create token
							</Button>
						}
					>
						<Input
							id="token-name"
							label="name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="ci, laptop…"
							maxLength={60}
						/>
						<Input
							id="token-days"
							label="expires in days (optional)"
							value={days}
							onChange={(e) => setDays(e.target.value)}
							inputMode="numeric"
							pattern="[0-9]*"
						/>
						<Field id="token-access" label="access">
							<Select
								id="token-access"
								value={access}
								onChange={(e) => setAccess(e.target.value as Access)}
								className="w-full"
							>
								<option value="full">full access</option>
								<option value="mcp-read">coding agent, read-only</option>
								<option value="mcp-write">coding agent, read and write (all apps)</option>
								<option value="mcp-apps">coding agent, read, write chosen apps</option>
							</Select>
						</Field>
					</FieldRow>
				</form>

				{access === 'mcp-apps' && (
					<fieldset className="rounded-lg border border-border bg-card p-4 shadow-card">
						<legend className="px-1 text-sm font-medium">
							apps this token may change and redeploy
						</legend>
						{projects === null ? (
							<SkeletonList rows={2} bare />
						) : projects.length === 0 ? (
							<p className="text-sm text-muted-foreground">no apps yet.</p>
						) : (
							<div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
								{projects.map((p) => (
									<label key={p.id} className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											checked={apps.has(p.id)}
											onChange={() => toggleApp(p.id)}
										/>
										<span>{p.containerName}</span>
										{p.serverName && (
											<span className="text-xs text-muted-foreground">{p.serverName}</span>
										)}
									</label>
								))}
							</div>
						)}
					</fieldset>
				)}

				<details className="group rounded-lg border border-border bg-card shadow-card">
					<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
						<ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
						what a token can change
					</summary>
					<div className="space-y-3 border-t border-border px-4 py-3 text-sm text-muted-foreground">
						<p>
							a token may write or delete only credential env keys: names ending in _SECRET, _TOKEN,
							_API_KEY or _KEY, or with a _SECRET_ / _TOKEN_ segment (WEBHOOK_SECRET_APP,
							MAILER_TOKEN_APP), never NEXT_PUBLIC_* or *_PUBLIC_KEY. the operator can allow more
							names with the POWDER_TOKEN_ENV_ALLOW regex. even then a token is refused keys that
							change how an app or its package manager starts (NODE_OPTIONS, LD_PRELOAD, COREPACK_*,
							NPM_*, PYTHON*, ...), keys that look like a place the app connects to or loads from
							(*_URL, *_HOST, *_ENDPOINT, *_DSN, *_PATH, *_FILE, *_CONFIG, PG*, REDIS*, ...) and any
							value with a line break. everything else (NODE_ENV, DEBUG, CORS_ORIGIN, ...) is set
							from the dashboard. a token that may write env vars and redeploy can still change the
							credential keys of its apps (BETTER_AUTH_SECRET, an API key) and redeploy with them.
						</p>
						<p>
							a token whose scope covers all apps (full access, or coding agent read and write for
							all apps) can replace the credentials of any app and redeploy it. whoever holds it
							could set a new BETTER_AUTH_SECRET and forge sessions, or swap a mail or API key for
							one of their own provider account, so the app's mail and API calls run through an
							account they control. give each agent a token for only the apps it works on: pick
							&quot;coding agent, read, write chosen apps&quot;.
						</p>
					</div>
				</details>
			</section>
			<McpConnectCard token={fresh} />

			<ConfirmDialog
				open={confirmRevoke !== null}
				title={`revoke token "${confirmRevoke?.name ?? ''}"?`}
				description="anything using it stops working."
				confirmLabel="revoke"
				danger
				onConfirm={() => {
					if (confirmRevoke) void revoke(confirmRevoke)
				}}
				onClose={() => setConfirmRevoke(null)}
			/>
		</div>
	)
}
