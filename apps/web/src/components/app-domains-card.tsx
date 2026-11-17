'use client'

import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Globe } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface AppDomain {
	id: string
	appRepoId?: string
	hostname: string
	status: 'pending' | 'verified' | 'verify_failed' | 'live' | 'apply_failed' | 'failed'
	statusError: string | null
	verifiedAt: string | null
	createdAt: string
	previewDeployId: string | null
}

interface State {
	supported: boolean
	autoAssigned: string | null
	ingressIp: string | null
	domains: AppDomain[]
	reason?: string
}

export function AppDomainsCard({
	serverId,
	containerName,
}: {
	serverId: string
	containerName: string
}) {
	const [state, setState] = useState<State | null>(null)
	const [projectId, setProjectId] = useState<string | null>(null)
	const base = `/api/servers/${serverId}/containers/${containerName}/domains`

	async function load() {
		const res = await fetch(base)
		setState(await res.json())
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the server or container changes; load is recreated every render and reads both props itself
	useEffect(() => {
		load()
	}, [serverId, containerName])

	// The domains tab lives under /projects/<repo id>; resolve it from the project list.
	useEffect(() => {
		let cancelled = false
		fetch('/api/projects')
			.then((r) => (r.ok ? r.json() : null))
			.then(
				(d: { projects?: { id: string; serverId: string; containerName: string }[] } | null) => {
					const p = d?.projects?.find(
						(x) => x.serverId === serverId && x.containerName === containerName,
					)
					if (!cancelled && p) setProjectId(p.id)
				},
			)
			.catch(() => {})
		return () => {
			cancelled = true
		}
	}, [serverId, containerName])

	if (!state) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Globe className="h-4 w-4 text-powder" />
						domains
					</CardTitle>
				</CardHeader>
				<CardContent>
					<SkeletonList rows={2} bare />
				</CardContent>
			</Card>
		)
	}

	if (!state.supported) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Globe className="h-4 w-4 text-powder" />
						domains
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-xs text-muted-foreground">
						custom domains attach here on Traefik servers. this app runs on an nginx server: use the{' '}
						<Link className="underline" href="/domains">
							nginx domain manager
						</Link>
						.
					</p>
				</CardContent>
			</Card>
		)
	}

	const manageId = projectId ?? state.domains[0]?.appRepoId ?? null
	const manageHref = manageId ? `/projects/${manageId}/domains` : '/projects'

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<CardTitle className="flex items-center gap-2">
						<Globe className="h-4 w-4 text-powder" />
						domains
					</CardTitle>
					<Link href={manageHref} className="text-xs text-muted-foreground hover:text-foreground">
						manage domains →
					</Link>
				</div>
			</CardHeader>
			<CardContent className="space-y-3">
				{state.autoAssigned ? (
					<div className="rounded-md border border-border px-3 py-2 text-xs flex items-center justify-between">
						<div>
							<a
								href={`https://${state.autoAssigned}`}
								target="_blank"
								rel="noopener noreferrer"
								className="font-mono hover:text-powder inline-flex items-center gap-1"
							>
								{state.autoAssigned}
								<ExternalLink className="h-3 w-3" />
							</a>
							<span className="ml-2 text-2xs text-muted-foreground">auto-assigned</span>
						</div>
						<Badge variant="success">live</Badge>
					</div>
				) : (
					<p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
						no base domain set on this server, add a custom domain
					</p>
				)}

				{state.domains
					.filter((d) => d.previewDeployId === null)
					.map((d) => (
						<div
							key={d.id}
							className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
						>
							<div className="min-w-0 flex-1">
								{d.status === 'live' ? (
									<a
										href={`https://${d.hostname}`}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center gap-1 font-mono text-sm hover:text-powder"
									>
										{d.hostname}
										<ExternalLink className="h-3 w-3" />
									</a>
								) : (
									<span className="font-mono text-sm">{d.hostname}</span>
								)}
								{d.statusError && (
									<div className="mt-0.5 text-2xs text-destructive">{d.statusError}</div>
								)}
							</div>
							<StatusBadge status={d.status} />
						</div>
					))}
			</CardContent>
		</Card>
	)
}

function StatusBadge({ status }: { status: AppDomain['status'] }) {
	if (status === 'live') return <Badge variant="success">live</Badge>
	if (status === 'failed' || status === 'verify_failed' || status === 'apply_failed')
		return <Badge variant="destructive">{status.replace('_', ' ')}</Badge>
	if (status === 'verified') return <Badge variant="outline">verified</Badge>
	return <Badge variant="warning">pending</Badge>
}
