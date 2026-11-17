'use client'

import { PageHeader } from '@/components/ui/page-header'

// Admin user management. There is no signup: this is the only way to add a user
// after the first-run admin. Type their email + name, click Create, copy the
// temp password to them out-of-band. A user only gets access once their id is
// in POWDER_ADMIN_USER_IDS. remove deletes a non-admin user with their sessions
// and accounts (DELETE /api/admin/users/<id>).

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FieldRow, Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { timeAgo } from '@/lib/format'
import { Check, Copy, RefreshCw, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'

interface UserRow {
	id: string
	email: string
	name: string
	createdAt: string
	providers: string[]
	lastSessionAt: string | null
	isAdmin?: boolean
}

const PROVIDER_LABEL: Record<string, string> = { credential: 'email', github: 'GitHub' }

export default function AdminUsersPage() {
	const [users, setUsers] = useState<UserRow[] | null>(null)
	const [busy, setBusy] = useState(false)
	const [err, setErr] = useState<string | null>(null)
	const [loadErr, setLoadErr] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)

	// Create form state
	const [email, setEmail] = useState('')
	const [name, setName] = useState('')
	const [password, setPassword] = useState('') // optional override
	const [created, setCreated] = useState<{ email: string; tempPassword: string } | null>(null)
	const [copiedField, setCopiedField] = useState<string | null>(null)
	const [confirmRemove, setConfirmRemove] = useState<UserRow | null>(null)
	const [removing, setRemoving] = useState(false)
	const toast = useToast()

	async function load() {
		setRefreshing(true)
		try {
			const res = await fetch('/api/admin/users')
			if (!res.ok) {
				const body = await res.json().catch(() => ({}))
				setLoadErr(body.error ?? `could not load users (${res.status})`)
				setRefreshing(false)
				return
			}
			const data = (await res.json()) as { users: UserRow[] }
			setUsers(data.users)
			setLoadErr(null)
		} catch {
			setLoadErr('could not load users: network error')
		}
		setRefreshing(false)
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; load is recreated every render and only calls state setters, so listing it would refetch on every render
	useEffect(() => {
		load()
	}, [])

	async function onCreate(e: React.FormEvent) {
		e.preventDefault()
		setErr(null)
		setBusy(true)
		try {
			const res = await fetch('/api/admin/users', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, name, password: password || undefined }),
			})
			const body = await res.json()
			if (!res.ok) {
				setErr(body.error ?? `create failed (${res.status})`)
				setBusy(false)
				return
			}
			setCreated({ email: body.user.email, tempPassword: body.tempPassword })
			setEmail('')
			setName('')
			setPassword('')
			await load()
		} catch {
			setErr('create failed: network error')
		}
		setBusy(false)
	}

	async function remove(u: UserRow) {
		setRemoving(true)
		try {
			const res = await fetch(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' })
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				toast.error(body.error ?? `remove failed (${res.status})`)
			}
		} catch {
			toast.error('remove failed: network error')
		}
		setRemoving(false)
		setConfirmRemove(null)
		await load()
	}

	async function copy(text: string, field: string) {
		await navigator.clipboard.writeText(text)
		setCopiedField(field)
		setTimeout(() => setCopiedField(null), 1500)
	}

	return (
		<div className="space-y-6">
			<title>{`users · powder`}</title>
			<PageHeader
				back={{ href: '/settings', label: 'settings' }}
				title="users"
				description={
					<>
						there is no signup. a new user gets a temporary password and can sign in once you run{' '}
						<code className="font-mono text-foreground">
							sudo bin/install.sh --set-admin &lt;id&gt;
						</code>{' '}
						with their id on the powder server.
					</>
				}
				actions={
					<Button variant="ghost" size="sm" onClick={load} loading={refreshing}>
						{!refreshing && <RefreshCw className="h-3.5 w-3.5" />}
						refresh
					</Button>
				}
			/>

			{/* Create form */}
			<div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-card">
				<div className="flex items-center gap-2 text-sm font-medium">
					<UserPlus className="h-4 w-4" />
					create user
				</div>
				<form onSubmit={onCreate}>
					<FieldRow
						error={err}
						hint="a password needs 8 characters or more."
						action={
							<Button type="submit" variant="outline" disabled={busy || !email || !name}>
								{busy ? 'creating…' : 'create user'}
							</Button>
						}
					>
						<Input
							label="email"
							type="email"
							placeholder="alex@example.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
						<Input
							label="name"
							placeholder="Alex Doe"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
						/>
						<Input
							label="password"
							type="text"
							placeholder="leave empty to generate"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							minLength={password ? 8 : undefined}
						/>
					</FieldRow>
				</form>
			</div>

			{/* Just-created banner */}
			{created && (
				<div className="rounded-md border border-success/30 bg-success/5 p-4 space-y-3">
					<div className="text-sm font-medium text-success">
						user created: copy the password NOW (won't be shown again)
					</div>
					<div className="grid grid-cols-2 gap-3 text-sm">
						<div>
							<div className="text-2xs text-muted-foreground">email</div>
							<div className="flex items-center gap-2 font-mono">
								<span>{created.email}</span>
								<button
									type="button"
									onClick={() => copy(created.email, 'email')}
									aria-label="copy email"
									title="copy email"
									className="text-muted-foreground hover:text-foreground"
								>
									{copiedField === 'email' ? (
										<Check className="h-3 w-3" />
									) : (
										<Copy className="h-3 w-3" />
									)}
								</button>
							</div>
						</div>
						<div>
							<div className="text-2xs text-muted-foreground">temp password</div>
							<div className="flex items-center gap-2 font-mono">
								<span>{created.tempPassword}</span>
								<button
									type="button"
									onClick={() => copy(created.tempPassword, 'pw')}
									aria-label="copy temp password"
									title="copy temp password"
									className="text-muted-foreground hover:text-foreground"
								>
									{copiedField === 'pw' ? (
										<Check className="h-3 w-3" />
									) : (
										<Copy className="h-3 w-3" />
									)}
								</button>
							</div>
						</div>
					</div>
					<button
						type="button"
						onClick={() => setCreated(null)}
						className="text-xs text-muted-foreground hover:text-foreground underline"
					>
						dismiss
					</button>
				</div>
			)}

			{/* User list */}
			<div className="overflow-hidden rounded-md border border-border">
				<div className="hidden grid-cols-12 gap-3 border-b border-border bg-muted/30 px-4 py-2 text-2xs font-medium text-muted-foreground md:grid">
					<div className="col-span-3">email</div>
					<div className="col-span-2">name</div>
					<div className="col-span-2">id</div>
					<div className="col-span-2">sign-in</div>
					<div className="col-span-2 text-right">last sign-in</div>
					<div className="col-span-1" />
				</div>
				{loadErr ? (
					<div className="px-4 py-3 text-sm text-destructive">{loadErr}</div>
				) : users === null ? (
					<div className="px-4 py-3 text-sm text-muted-foreground">loading…</div>
				) : users.length === 0 ? (
					<div className="px-4 py-3 text-sm text-muted-foreground">no users yet</div>
				) : (
					users.map((u) => {
						const lastSignIn = u.lastSessionAt ? timeAgo(u.lastSessionAt) : 'never'
						// Phones: one compact block per user (email and the action on the first
						// line, name and last sign-in under it, then id and sign-in methods). From md
						// up the same cells are the table's columns (md:contents unwraps the groups).
						return (
							<div
								key={u.id}
								className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3 text-sm last:border-b-0 md:grid-cols-12 md:gap-3"
							>
								<div className="flex min-w-0 items-center gap-2 md:col-span-3">
									<span className="truncate font-mono text-xs">{u.email}</span>
									{u.isAdmin && <Badge variant="success">admin</Badge>}
								</div>
								<div className="col-start-2 row-span-2 row-start-1 flex justify-end md:order-last md:col-span-1 md:col-start-auto md:row-span-1 md:row-start-auto">
									{!u.isAdmin && (
										<Button
											size="sm"
											variant="destructive-outline"
											onClick={() => setConfirmRemove(u)}
											aria-label={`remove ${u.email}`}
										>
											remove
										</Button>
									)}
								</div>
								<div className="col-start-1 truncate text-xs md:col-span-2">
									{u.name}
									<span className="text-muted-foreground md:hidden"> · {lastSignIn}</span>
								</div>
								<div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 md:contents">
									<div className="flex min-w-0 items-center gap-1 md:col-span-2">
										<code className="ph-no-capture truncate font-mono text-2xs text-muted-foreground">
											{u.id}
										</code>
										<button
											type="button"
											onClick={() => copy(u.id, `id-${u.id}`)}
											aria-label={`copy the id of ${u.email}`}
											title="copy id"
											className="-my-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:my-0 md:h-7 md:w-7"
										>
											{copiedField === `id-${u.id}` ? (
												<Check className="h-3 w-3" />
											) : (
												<Copy className="h-3 w-3" />
											)}
										</button>
									</div>
									<div className="flex flex-wrap items-center gap-1 md:col-span-2">
										{u.providers.length === 0 ? (
											<span className="text-xs text-muted-foreground">no sign-in yet</span>
										) : (
											u.providers.map((p) => (
												<Badge key={p} variant="outline">
													{PROVIDER_LABEL[p] ?? p}
												</Badge>
											))
										)}
									</div>
								</div>
								<div className="hidden text-xs text-muted-foreground md:col-span-2 md:block md:text-right">
									{lastSignIn}
								</div>
							</div>
						)
					})
				)}
			</div>

			<ConfirmDialog
				open={confirmRemove !== null}
				title={`remove ${confirmRemove?.email ?? ''}?`}
				description="their sessions, sign-in methods (password and GitHub sign-in, with the GitHub token it stored), API tokens and stored integration tokens (a GitHub personal access token) are deleted from powder. GitHub is not told: revoke a token there if it should stop working. this cannot be undone."
				confirmLabel="remove"
				danger
				loading={removing}
				onConfirm={() => {
					if (confirmRemove) void remove(confirmRemove)
				}}
				onClose={() => setConfirmRemove(null)}
			/>
		</div>
	)
}
