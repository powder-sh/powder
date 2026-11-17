'use client'

import { RECREATE_COMMAND } from '@/lib/recreate-hint'
import { PageHeader } from '@/components/ui/page-header'

import { useEffect, useId, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FieldRow, Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { buttonVariants } from '@/components/ui/button-variants'
import Link from 'next/link'
import { signIn } from '@/lib/auth-client'

interface GhStatus {
	connected: boolean
	/** false: GitHub rejected the stored token (401); null/undefined: not known */
	valid?: boolean | null
	username?: string | null
	source?: 'oauth' | 'pat'
	scopes?: string[]
	oauthAvailable?: boolean
}

export default function IntegrationsPage() {
	return (
		<div className="space-y-6">
			<title>{`integrations · powder`}</title>
			<PageHeader
				back={{ href: '/settings', label: 'settings' }}
				title="integrations"
				description="accounts powder can use on your behalf."
			/>
			<GithubRow />
		</div>
	)
}

function GithubMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</svg>
	)
}

function GithubRow() {
	const toast = useToast()
	const [status, setStatus] = useState<GhStatus | null>(null)
	const [showAdvanced, setShowAdvanced] = useState(false)
	const [confirmDisconnect, setConfirmDisconnect] = useState(false)
	const [busy, setBusy] = useState(false)
	// set when GitHub sign-in sent the browser back with an error (errorCallbackURL)
	const [signInError, setSignInError] = useState<string | null>(null)
	const advancedId = useId()

	async function load() {
		const res = await fetch('/api/integrations/github')
		if (res.ok) setStatus(await res.json())
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; load is recreated every render and only calls state setters, so listing it would refetch on every render
	useEffect(() => {
		load()
	}, [])

	// ?gh_error=1 (plus better-auth's ?error=<code>) after a failed GitHub sign-in:
	// show it once and drop the params, so a reload does not show it again.
	useEffect(() => {
		const url = new URL(window.location.href)
		if (!url.searchParams.has('gh_error')) return
		const code = url.searchParams.get('error') ?? ''
		setSignInError(
			/^[a-z0-9_]{1,64}$/i.test(code)
				? `GitHub sign-in did not complete (${code})`
				: 'GitHub sign-in did not complete',
		)
		url.searchParams.delete('gh_error')
		url.searchParams.delete('error')
		window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
	}, [])

	async function connectOAuth() {
		setBusy(true)
		try {
			await signIn.social({
				provider: 'github',
				callbackURL: '/integrations',
				errorCallbackURL: '/integrations?gh_error=1',
			})
		} catch {
			toast.error('GitHub sign-in failed: network error')
		} finally {
			setBusy(false)
		}
	}

	async function disconnect() {
		setBusy(true)
		try {
			await fetch('/api/integrations/github', { method: 'DELETE' })
			setConfirmDisconnect(false)
			await load()
		} catch {
			toast.error('disconnect failed: network error')
		} finally {
			setBusy(false)
		}
	}

	if (!status) {
		return <div className="h-20 animate-pulse rounded-lg border border-border bg-muted/20" />
	}

	const connected = status.connected
	const rejected = connected && status.valid === false

	return (
		<div className="space-y-3">
			{signInError && (
				<p role="alert" className="text-xs text-destructive">
					{signInError}: try again, or use a personal access token under advanced.
				</p>
			)}
			<div
				className={`flex items-center gap-4 rounded-lg border px-5 py-4 ${
					rejected ? 'border-warning/40 bg-warning/10' : 'border-border bg-card shadow-card'
				}`}
			>
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-foreground/5">
					<GithubMark className="h-5 w-5" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-semibold tracking-tight">GitHub</span>
						{rejected ? (
							<span className="inline-flex items-center gap-1 text-2xs text-warning">
								<span className="h-1.5 w-1.5 rounded-full bg-warning" />
								token rejected by GitHub
							</span>
						) : (
							connected && (
								<span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
									<span className="h-1.5 w-1.5 rounded-full bg-success" />
									{status.username ?? 'connected'}
								</span>
							)
						)}
					</div>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{rejected
							? 'GitHub no longer accepts the stored token (revoked or expired): reconnect'
							: connected
								? 'powder can list your repos and auto-install deploy keys + webhooks'
								: 'import repos and auto-deploy on push'}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{rejected && status.oauthAvailable && (
						<Button onClick={connectOAuth} disabled={busy} size="sm">
							{busy ? 'redirecting…' : 'reconnect'}
						</Button>
					)}
					{connected ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setConfirmDisconnect(true)}
							title="disconnect"
							aria-label="disconnect GitHub"
						>
							<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
						</Button>
					) : status.oauthAvailable ? (
						<Button onClick={connectOAuth} disabled={busy} size="sm">
							{busy ? 'redirecting…' : 'connect'}
						</Button>
					) : (
						<Link
							href="/docs/quickstart"
							className={buttonVariants({ size: 'sm', variant: 'outline' })}
						>
							set up GitHub
						</Link>
					)}
				</div>
			</div>

			{!connected && !status.oauthAvailable && (
				<p className="text-xs text-muted-foreground">
					this powder has no GitHub OAuth app yet. create one (the quickstart has the URLs), set{' '}
					<code className="font-mono text-foreground">GITHUB_CLIENT_ID</code> and{' '}
					<code className="font-mono text-foreground">GITHUB_CLIENT_SECRET</code> in{' '}
					<code className="font-mono text-foreground">powder.env</code>, then in the powder source
					dir run <code className="font-mono text-foreground break-all">{RECREATE_COMMAND}</code> (a
					restart does not re-read the file). a personal access token under advanced works too.
				</p>
			)}

			{(!connected || (rejected && status.source === 'pat')) && (
				<div className="space-y-2">
					<div className="flex justify-end">
						<Button
							variant="ghost"
							size="xs"
							className="-mr-2.5 sm:-mr-2"
							onClick={() => setShowAdvanced((s) => !s)}
							aria-expanded={showAdvanced}
							aria-controls={advancedId}
						>
							{showAdvanced ? 'hide advanced' : 'advanced'}
						</Button>
					</div>
					<div id={advancedId} hidden={!showAdvanced}>
						{showAdvanced && <PatFallback onConnected={load} />}
					</div>
				</div>
			)}

			<ConfirmDialog
				open={confirmDisconnect}
				title="disconnect GitHub?"
				description="powder forgets your access. existing connected app repos keep working (their webhook and deploy key already live on GitHub). future imports stop working until you reconnect."
				confirmLabel="disconnect"
				danger
				loading={busy}
				onConfirm={disconnect}
				onClose={() => setConfirmDisconnect(false)}
			/>
		</div>
	)
}

function PatFallback({ onConnected }: { onConnected: () => void }) {
	const [token, setToken] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const tokenId = useId()

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		try {
			setError(null)
			const res = await fetch('/api/integrations/github', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token }),
			})
			const data = await res.json()
			if (!res.ok) {
				setError(data.error ?? 'failed')
				return
			}
			setToken('')
			await onConnected()
		} catch {
			setError('failed: network error')
		} finally {
			setBusy(false)
		}
	}

	return (
		<form onSubmit={submit} className="rounded-lg border border-border bg-card p-4 shadow-card">
			<FieldRow
				error={error}
				action={
					<Button type="submit" variant="outline" loading={busy}>
						{busy ? 'checking…' : 'use'}
					</Button>
				}
			>
				<Input
					id={tokenId}
					label="personal access token"
					type="password"
					placeholder="ghp_…"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					required
					autoComplete="off"
					className="font-mono"
				/>
			</FieldRow>
		</form>
	)
}
