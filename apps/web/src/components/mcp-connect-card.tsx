'use client'

import { CopyPromptButton } from '@/components/copy-prompt-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { useEffect, useState } from 'react'

// "Use with your coding agent": the MCP URL (this dashboard's origin +
// /api/mcp) and copyable client configs. A token created a moment ago is
// filled in; otherwise the snippets carry a <token> placeholder.
export function McpConnectCard({ token }: { token: string | null }) {
	const [origin, setOrigin] = useState('<your powder dashboard URL>')
	useEffect(() => setOrigin(window.location.origin), [])

	const url = `${origin}/api/mcp`
	const bearer = token ?? '<token>'
	const claude = `claude mcp add --transport http powder ${url} --header "Authorization: Bearer ${bearer}"`
	const json = JSON.stringify(
		{
			mcpServers: { powder: { type: 'http', url, headers: { Authorization: `Bearer ${bearer}` } } },
		},
		null,
		2,
	)

	const blocks = [
		{ id: 'mcp-url', label: 'mcp url', text: url },
		{ id: 'mcp-claude', label: 'claude code', text: claude },
		{ id: 'mcp-json', label: 'other clients (json)', text: json },
	]

	return (
		<Card>
			<CardHeader>
				<CardTitle>use with your coding agent</CardTitle>
				<CardDescription>
					powder is an MCP server. agents can list apps, read deploy logs, redeploy and manage env
					vars, with the token's scopes. pick a coding agent access level above for a narrower
					token.{' '}
					<Link href="/docs/mcp" className="underline underline-offset-4 hover:text-foreground">
						tools and scopes
					</Link>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{blocks.map((b) => (
					<div key={b.id} className="space-y-1.5">
						<div className="flex items-center justify-between gap-3">
							<span className="text-xs font-medium text-foreground">{b.label}</span>
							<CopyPromptButton text={b.text} targetId={b.id} label={b.label} />
						</div>
						<pre
							id={b.id}
							className="ph-no-capture overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground"
						>
							{b.text}
						</pre>
					</div>
				))}
			</CardContent>
		</Card>
	)
}
