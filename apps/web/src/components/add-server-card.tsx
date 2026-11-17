'use client'

import { useEffect, useState } from 'react'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/input'
import { AgentHelp } from '@/components/agent-help'
import { prepareServerPrompt } from '@/lib/agent-help-prompts'
import { authorizeCommand } from '@/lib/authorize-command'

interface AddServerCardProps {
	onClose: () => void
	onAdded: (added: { id: string; name: string }) => void | Promise<void>
}

export function AddServerCard({ onClose, onAdded }: AddServerCardProps) {
	const [name, setName] = useState('')
	const [host, setHost] = useState('')
	const [user, setUser] = useState('root')
	const [kind, setKind] = useState<'compose' | 'raw-docker'>('compose')
	const [proxy, setProxy] = useState<'traefik' | 'nginx' | 'nginx-container'>('traefik')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [pubkey, setPubkey] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		fetch('/api/servers/ssh-key')
			.then((r) => r.json())
			.then((d) => setPubkey(d.pubkey ?? null))
			.catch(() => setPubkey(null))
	}, [])

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const res = await fetch('/api/servers', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, host, user, kind, proxy }),
			})
			if (!res.ok) {
				const data = await res.json()
				setError(data.error ?? 'add failed')
				return
			}
			const data = (await res.json()) as { server: { id: string; name: string } }
			await onAdded(data.server)
			onClose()
		} catch {
			setError('add failed: network error')
		} finally {
			setSubmitting(false)
		}
	}

	async function copyInstall() {
		if (!pubkey) return
		await navigator.clipboard.writeText(authorizeCommand(pubkey))
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle>add server</CardTitle>
					<Button variant="ghost" size="sm" onClick={onClose}>
						cancel
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="rounded-md border border-border bg-muted/40 p-3">
					<p className="text-xs font-medium text-foreground">1. authorize powder on the server</p>
					<p className="mb-2 mt-0.5 text-xs text-muted-foreground">
						SSH into it and run this once:
					</p>
					{pubkey ? (
						<div className="flex items-start gap-2">
							<pre className="ph-no-capture min-w-0 flex-1 whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 font-mono text-2xs leading-relaxed [overflow-wrap:anywhere]">
								{authorizeCommand(pubkey)}
							</pre>
							<Button
								variant="outline"
								size="icon"
								onClick={copyInstall}
								title="copy"
								aria-label="copy the authorize command"
							>
								{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
							</Button>
						</div>
					) : (
						<p className="text-xs text-muted-foreground">loading powder's public key…</p>
					)}
					<AgentHelp
						className="mt-3"
						title="prepare this server for powder"
						description="authorizes powder's key, checks Docker, networks and routing, and fixes only what is missing. it uses the host and ssh user you type below."
						prompt={prepareServerPrompt({ host, user, proxy, pubkey })}
						note="includes powder's public key (safe to share), the host and the ssh user. no secrets."
					/>
				</div>

				<form onSubmit={handleSubmit} className="space-y-3">
					<p className="text-xs font-medium text-foreground">2. add it here</p>
					<div className="grid gap-3 sm:grid-cols-2">
						<Input
							label="display name"
							placeholder="prod-1"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
						/>
						<Input
							label="host or IP"
							placeholder="203.0.113.10"
							value={host}
							onChange={(e) => setHost(e.target.value)}
							required
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<Input
							label="SSH user"
							placeholder="root"
							value={user}
							onChange={(e) => setUser(e.target.value)}
							hint={
								user.trim() && user.trim() !== 'root'
									? 'not root: run bin/server-bootstrap.sh with sudo on the server to install what is missing.'
									: 'root lets powder install Docker and Traefik for you.'
							}
						/>
					</div>
					<details className="group">
						<summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
							<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
							advanced
						</summary>
						<div className="mt-3 grid gap-3 sm:grid-cols-2">
							<Field
								id="add-server-kind"
								label="use"
								hint="watching lists, logs and restarts the containers already there. no deploys."
							>
								<Select
									id="add-server-kind"
									value={kind}
									onChange={(e) => setKind(e.target.value as 'compose' | 'raw-docker')}
									className="w-full"
									aria-describedby="add-server-kind-msg"
								>
									<option value="compose">deploy apps here</option>
									<option value="raw-docker">only watch existing containers</option>
								</Select>
							</Field>
							<Field
								id="add-server-proxy"
								label="routing"
								hint="Traefik routes apps and gets HTTPS certificates. nginx is for servers that already run it."
							>
								<Select
									id="add-server-proxy"
									value={proxy}
									onChange={(e) => setProxy(e.target.value as 'traefik' | 'nginx' | 'nginx-container')}
									className="w-full"
									aria-describedby="add-server-proxy-msg"
								>
									<option value="traefik">Traefik (recommended)</option>
									<option value="nginx">nginx on the host (no custom domains, previews or snapshots)</option>
									<option value="nginx-container">nginx in a container (no custom domains, previews or snapshots)</option>
								</Select>
							</Field>
						</div>
					</details>
					{error && <p className="text-xs text-destructive">{error}</p>}
					<Button type="submit" disabled={submitting} className="w-full sm:w-auto">
						{submitting ? 'adding…' : 'add server'}
					</Button>
				</form>
			</CardContent>
		</Card>
	)
}
