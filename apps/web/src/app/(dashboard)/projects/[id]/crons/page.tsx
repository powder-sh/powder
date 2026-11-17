'use client'

import { SkeletonList } from '@/components/ui/skeleton'
// Crons tab: powder-managed jobs for this app (create / edit / pause / run now /
// run history) plus its host crontab lines, read-only with an import action.

import { CronsCard } from '@/components/crons-card'
import { useProject } from '../_lib/project-context'

export default function AppCronsPage() {
	const { project } = useProject()
	if (!project) return <SkeletonList rows={4} />
	return <CronsCard
			serverId={project.serverId}
			serverName={project.serverName}
			containerName={project.containerName}
		/>
}
