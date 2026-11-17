'use client'

// Logs tab, two views:
//   runtime       - live `docker logs --follow` of the app container (the same
//                   stream and access check as the container page)
//   deploy output - full-text search over this app's deploy output

import { useState } from 'react'
import { ServerUnreachable } from '@/components/server-unreachable'
import { LiveLogsCard } from '@/components/live-logs-card'
import { LogsView } from '@/components/logs-view'
import { SkeletonList } from '@/components/ui/skeleton'
import { type Project, useProject } from '../_lib/project-context'

const VIEWS = [
	{ key: 'runtime', label: 'runtime' },
	{ key: 'deploy', label: 'deploy output' },
] as const
type View = (typeof VIEWS)[number]['key']

export default function AppLogsPage() {
	const { project, reload } = useProject()
	const [view, setView] = useState<View>('runtime')
	if (!project) return <SkeletonList rows={4} />
	return (
		<div className="space-y-4">
			<div role="tablist" aria-label="logs view" className="flex gap-0.5 overflow-x-auto border-b border-border">
				{VIEWS.map((v) => {
					const active = view === v.key
					return (
						<button
							key={v.key}
							type="button"
							role="tab"
							id={`logs-tab-${v.key}`}
							aria-selected={active}
							aria-controls={`logs-panel-${v.key}`}
							onClick={() => setView(v.key)}
							className={`-mb-px inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors ${
								active
									? 'border-foreground font-medium text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground'
							}`}
						>
							{v.label}
						</button>
					)
				})}
			</div>
			<div role="tabpanel" id={`logs-panel-${view}`} aria-labelledby={`logs-tab-${view}`}>
				{view !== 'runtime' ? (
					<LogsView app={project.containerName} serverId={project.serverId} embedded />
				) : (
					<Runtime project={project} reload={reload} />
				)}
			</div>
		</div>
	)
}

function Runtime({ project, reload }: { project: Project; reload: () => void }) {
	const c = project.container
	if (!c) return <SkeletonList rows={3} label="reading the container" />
	if (!c.reachable)
		return (
			<ServerUnreachable
				serverId={project.serverId}
				serverName={project.serverName}
				error={c.error}
				onRetry={reload}
				what="the runtime log"
			/>
		)
	if ('dockerError' in c)
		return (
			<ServerUnreachable
				kind="docker"
				serverId={project.serverId}
				serverName={project.serverName}
				error={c.dockerError}
				onRetry={reload}
				what="the runtime log"
			/>
		)
	return (
		<LiveLogsCard
			serverId={project.serverId}
			containerName={project.containerName}
			title="runtime logs"
			autoStart={c.exists}
			{...(c.exists
				? {}
				: {
						idleHint: `no ${project.containerName} container on ${project.serverName}: logs appear once a deploy has started it.`,
					})}
		/>
	)
}
