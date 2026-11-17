'use client'

import { Skeleton } from '@/components/ui/skeleton'
// Overview tab: container status, scheduled jobs, recent deploys preview.
// Full deploy history with expand-to-see-output lives at /projects/[id]/deployments.

import Link from 'next/link'
import { ChevronRight, Clock, Rocket } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionHeader } from '@/components/ui/page-header'
import { ServerUnreachable } from '@/components/server-unreachable'
import { StatusDot, StatusLabel } from '@/components/ui/status'
import { cronRunLabel, cronRunTone } from '@/lib/cron-status'
import { deployKindBadge, deployStatus } from '@/lib/deploy-status'
import { DeployStrip, StripLegend, stripSummary } from '@/components/deploy-strip'
import { timeAgo, useProject } from './_lib/project-context'

export default function OverviewPage() {
	const { id, project, deploys, crons, deployDays, reload } = useProject()
	if (!project) return null

	const recentDeploys = deploys.slice(0, 5)
	const hadGoodDeploy = deploys.some((d) => d.status === 'success')

	return (
		<div className="space-y-8">
			{/* Container status */}
			<section className="space-y-3">
				<SectionHeader title="container" />
				{!project.container ? (
					<Skeleton className="h-[4.5rem] w-full rounded-lg" />
				) : !project.container.reachable ? (
					<ServerUnreachable
						serverId={project.serverId}
						serverName={project.serverName}
						error={project.container.error}
						onRetry={reload}
					/>
				) : 'dockerError' in project.container ? (
					<ServerUnreachable
						kind="docker"
						serverId={project.serverId}
						serverName={project.serverName}
						error={project.container.dockerError}
						onRetry={reload}
					/>
				) : project.container.exists ? (
					<dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-card sm:grid-cols-3">
						<div className="bg-card px-4 py-3">
							<dt className="text-xs text-muted-foreground">status</dt>
							<dd className="mt-1 font-mono text-sm">{project.container.status}</dd>
						</div>
						<div className="min-w-0 bg-card px-4 py-3">
							<dt className="text-xs text-muted-foreground">image</dt>
							<dd className="mt-1 truncate font-mono text-sm" title={project.container.image}>
								{project.container.image}
							</dd>
						</div>
						<div className="bg-card px-4 py-3">
							<dt className="text-xs text-muted-foreground">started</dt>
							<dd className="mt-1 text-sm">
								{project.container.startedAt ? timeAgo(project.container.startedAt) : '-'}
							</dd>
						</div>
					</dl>
				) : (
					<Alert
						tone={hadGoodDeploy ? 'warning' : 'info'}
						title={
							hadGoodDeploy
								? `no ${project.containerName} container on ${project.serverName}`
								: 'not running yet'
						}
						action={
							<Link
								href={`/projects/${id}/deployments`}
								className="text-sm font-medium text-foreground underline underline-offset-2"
							>
								deployments
							</Link>
						}
					>
						{hadGoodDeploy
							? 'the server answered but the container is gone: it was removed outside powder. redeploy to start it again.'
							: deploys.length > 0
								? 'no deploy has finished yet. the deployments tab has the build log.'
								: 'the container appears after the first successful deploy.'}
					</Alert>
				)}
			</section>

			{/* Deploy history strip: one cell per UTC day, from the deploys table. */}
			{deployDays.length > 0 && (
				<section className="space-y-3">
					<SectionHeader title="deploys" />
					<div className="rounded-lg border border-border bg-card px-4 py-3 shadow-card">
						<DeployStrip days={deployDays} className="h-5 gap-[3px] [&>span]:flex-1" />
						<div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
							<span className="text-xs text-muted-foreground">{stripSummary(deployDays)}</span>
							<StripLegend />
						</div>
					</div>
				</section>
			)}

			{/* Crons */}
			{crons.length > 0 && (
				<section className="space-y-3">
					<SectionHeader
						title={
							<>
								<Clock className="h-4 w-4 text-muted-foreground" />
								scheduled jobs
								<span className="text-xs font-normal text-muted-foreground">{crons.length}</span>
							</>
						}
						actions={
							<Link
								href={`/projects/${id}/crons`}
								className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
							>
								manage
								<ChevronRight className="h-3 w-3" />
							</Link>
						}
					/>
					<ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
						{crons.map((c) => (
							<li key={c.id} className="px-4 py-3">
								<div className="flex items-center gap-3 text-sm">
									<StatusDot tone={cronRunTone(c.enabled, c.lastRunStatus)} />
									<span className="shrink-0 font-mono text-xs">{c.schedule}</span>
									<span className="min-w-0 flex-1 truncate">
										{c.kind === 'http'
											? c.urlPath
											: c.execCommand && c.execCommand.length > 80
												? `${c.execCommand.slice(0, 80)}…`
												: c.execCommand}
									</span>
									<Badge variant="outline" className="hidden sm:inline-flex">
										{c.kind}
									</Badge>
									<span className="shrink-0 text-xs text-muted-foreground">
										{cronRunLabel(c.enabled, c.lastRunStatus)}
									</span>
								</div>
								{c.description && (
									<div className="ml-5 mt-1 text-xs text-muted-foreground">{c.description}</div>
								)}
							</li>
						))}
					</ul>
				</section>
			)}

			{/* Recent deploys preview */}
			<section className="space-y-3">
				<SectionHeader
					title="recent deploys"
					actions={
						recentDeploys.length > 0 && (
							<Link
								href={`/projects/${id}/deployments`}
								className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
							>
								all deploys
								<ChevronRight className="h-3 w-3" />
							</Link>
						)
					}
				/>
				{recentDeploys.length === 0 ? (
					<EmptyState icon={Rocket} title="no deploys yet" compact>
						push to <span className="font-mono text-foreground">{project.branch}</span> to trigger
						one, or use redeploy above.
					</EmptyState>
				) : (
					<ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
						{recentDeploys.map((d) => (
							<li key={d.id}>
								<Link
									href={`/projects/${id}/deployments#${d.id}`}
									className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent/40"
								>
									<StatusLabel
										tone={deployStatus(d.status).tone}
										pulse={deployStatus(d.status).pulse}
										className="w-24 shrink-0 text-xs"
									>
										{deployStatus(d.status).label}
									</StatusLabel>
									<span className="font-mono text-xs">{d.gitSha ? d.gitSha.slice(0, 7) : '-'}</span>
									{deployKindBadge(d.kind) && (
										<Badge variant="outline">{deployKindBadge(d.kind)}</Badge>
									)}
									<span className="ml-auto shrink-0 text-xs text-muted-foreground">
										{timeAgo(d.startedAt)}
									</span>
									<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	)
}
