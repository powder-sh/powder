'use client'

// The one "can't reach <server>" card: app pages, the servers list, the server
// page and the container page all use it when SSH failed (or, kind="docker",
// when SSH worked and docker did not). Says what is unknown (never "the
// container is gone"), and offers the way forward: retry, the server page, and
// the command that authorizes powder's key on the server.

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { authorizeCommand, fetchPowderPubkey } from '@/lib/authorize-command'
import { cn } from '@/lib/cn'
import { Check, KeyRound, RefreshCw, ServerOff } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

export function ServerUnreachable({
	serverId,
	serverName,
	error,
	onRetry,
	what = 'the container state',
	kind = 'ssh',
	openServer = true,
	className,
}: {
	serverId: string
	serverName: string
	error?: string | null
	onRetry: () => void | Promise<void>
	/** What cannot be shown, e.g. "runtime logs". */
	what?: string
	/** ssh: the server did not answer. docker: SSH worked, docker failed. */
	kind?: 'ssh' | 'docker'
	/** Off on the server page itself. */
	openServer?: boolean
	className?: string
}) {
	const [busy, setBusy] = useState(false)
	const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
	async function retry() {
		setBusy(true)
		try {
			await onRetry()
		} finally {
			setTimeout(() => setBusy(false), 600)
		}
	}
	async function copyAuthorize() {
		const key = await fetchPowderPubkey()
		const ok =
			!!key &&
			(await navigator.clipboard.writeText(authorizeCommand(key)).then(
				() => true,
				() => false,
			))
		setCopied(ok ? 'ok' : 'failed')
		setTimeout(() => setCopied(null), 2000)
	}
	return (
		<div
			className={cn(
				'flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3.5 shadow-card md:flex-row md:items-center',
				className,
			)}
		>
			<div className="flex min-w-0 flex-1 gap-3">
				<ServerOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
				<div className="min-w-0 space-y-0.5 text-sm">
					<p className="font-medium">
						{kind === 'docker' ? `docker isn't answering on ${serverName}` : `can't reach ${serverName}`}
					</p>
					<p className="text-muted-foreground">
						{kind === 'docker'
							? `powder reached the server over SSH, but the docker command failed, so ${what} is unknown.`
							: `powder could not connect over SSH, so ${what} is unknown. the apps may still be serving.`}
					</p>
					{error && (
						<div className="flex items-start gap-1">
							<p
								className="ph-no-capture line-clamp-2 min-w-0 flex-1 font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]"
								title={error}
							>
								{error}
							</p>
							<CopyButton value={error} label="copy the error" className="-mt-0.5" />
						</div>
					)}
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-7 md:pl-0">
				{openServer && (
					<Link
						href={`/servers/${encodeURIComponent(serverId)}`}
						className="inline-flex h-10 items-center px-2 text-xs font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground sm:h-8"
					>
						open server
					</Link>
				)}
				{kind === 'ssh' && (
					<Button
						variant="ghost"
						size="sm"
						onClick={copyAuthorize}
						title="run it on the server as the SSH user powder logs in as"
					>
						{copied === 'ok' ? (
							<Check className="h-3.5 w-3.5 text-success" />
						) : (
							<KeyRound className="h-3.5 w-3.5" />
						)}
						{copied === 'ok'
							? 'copied'
							: copied === 'failed'
								? "couldn't copy"
								: 'copy authorize command'}
					</Button>
				)}
				<Button variant="outline" size="sm" onClick={retry} loading={busy}>
					{!busy && <RefreshCw className="h-3.5 w-3.5" />}
					retry
				</Button>
			</div>
		</div>
	)
}
