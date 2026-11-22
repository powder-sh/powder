'use client'

// Shared client-side state for the /projects/[id]/* tab routes. Layout fetches
// once, all tab pages read via useProject(). Reload exposed for actions that
// mutate (redeploy, delete domain, etc) - the consuming page calls reload()
// after a successful mutation and the header status reflects the change.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { type AppHealth, appHealth } from '@/lib/app-health'
import type { ContainerState } from '@/lib/container-state'
import type { DeployDay } from '@/lib/deploy-days'
import { timeAgoDays } from '@/lib/format'
import { singleFlight } from '@/lib/single-flight'

export type Container = ContainerState

export interface Project {
	id: string
	serverId: string
	serverName: string
	containerName: string
	repoUrl: string
	branch: string
	hasPostgres: boolean
	hasKv: boolean
	createdAt: string
	/** Undefined until the SSH round answers (the first load reads ?part=db first). */
	container?: Container
}

export interface Deploy {
	id: string
	status: 'success' | 'failed' | 'running' | 'queued'
	kind: string
	queuedAt?: string
	startedAt: string
	finishedAt: string | null
	gitSha: string | null
	/** the commit the deploy built (0070) and the one the push requested; displays read
	 *  them through lib/deploy-commit.ts */
	builtSha?: string | null
	requestedSha?: string | null
	gitBranch: string | null
	imageTag: string | null
	/** a failure: its one-line summary, step and exit code, and the end of its log
	 *  (masked; the full log is on /deploys/<id>) */
	failedStep?: string | null
	exitCode?: number | null
	errorSummary?: string | null
	logTail?: string | null
	/** true when logTail leaves earlier lines out */
	logCut?: boolean
	outputPreview: string | null
	/** Set while a queued push is held on the settle window (lib/deploy-settle.ts). */
	notBefore?: string | null
	waiting?: string | null
}

export interface Cron {
	id: string
	schedule: string
	kind: 'http' | 'exec'
	urlPath: string | null
	execCommand: string | null
	description: string | null
	enabled: boolean
	lastRunAt: string | null
	lastRunStatus: string | null
	nextRunAt: string | null
}

export interface Uptime {
	url: string
	isUp: boolean
	lastCheckedAt: string | null
	lastStatusCode: number | null
	lastDownAt: string | null
}

interface ProjectContextValue {
	id: string
	loading: boolean
	project: Project | null
	deploys: Deploy[]
	crons: Cron[]
	uptime: Uptime | null
	/** Deploys per UTC day, last 30 days. Empty until loaded. */
	deployDays: DeployDay[]
	/** Settings-tab fields from the same response. */
	meta: ProjectMeta | null
	reload: () => Promise<void>
}

export interface ProjectMeta {
	webhookUrl: string | null
	deployKeyPub: string | null
	syncDeploymentMd: boolean
	uptimeEnabled: boolean
	healthUrl: string | null
	previewsEnabled: boolean
	/** Why previews cannot work on this app's server (lib/preview-deploys.ts
	 *  previewBlockReason); null = they can. */
	previewBlockReason: string | null
	/** What previews build and route to (0065); null port: read from the compose. */
	dockerfilePath: string
	containerPort: number | null
	/** false: automatic rollback is off for this app (default on). */
	autoRollback: boolean
	/** Settle window for push deploys in seconds (0 = never wait); null: the install-wide value. */
	deploySettleSeconds: number | null
}

const Ctx = createContext<ProjectContextValue | null>(null)

export function useProject() {
	const v = useContext(Ctx)
	if (!v) throw new Error('useProject must be inside <ProjectProvider>')
	return v
}

export function ProjectProvider({
	id,
	children,
}: {
	id: string
	children: React.ReactNode
}) {
	const [project, setProject] = useState<Project | null>(null)
	const [deploys, setDeploys] = useState<Deploy[]>([])
	const [crons, setCrons] = useState<Cron[]>([])
	const [uptime, setUptime] = useState<Uptime | null>(null)
	const [deployDays, setDeployDays] = useState<DeployDay[]>([])
	const [meta, setMeta] = useState<ProjectMeta | null>(null)
	const [loading, setLoading] = useState(true)

	// Two reads on first load: ?part=db (database only, fast) renders the tabs,
	// then the full read adds the container state over SSH. Later reloads read
	// everything; one at a time. A reload() asked for while a read is in flight (a
	// redeploy clicked during a slow read) gets one follow-up read after it, shared
	// by every such request; a poll in that window is skipped.
	const lastUnreachable = useRef(false)
	const apply = useCallback((d: Record<string, unknown> & { project?: Project | null }) => {
		setProject((prev) =>
			d.project ? { ...d.project, container: d.project.container ?? prev?.container } : null,
		)
		lastUnreachable.current = d.project?.container?.reachable === false
		setDeploys((d.deploys as Deploy[]) ?? [])
		setCrons((d.crons as Cron[]) ?? [])
		setUptime((d.uptime as Uptime) ?? null)
		setDeployDays((d.deployDays as DeployDay[]) ?? [])
		setMeta({
			webhookUrl: (d.webhookUrl as string) ?? null,
			deployKeyPub: (d.deployKeyPub as string) ?? null,
			syncDeploymentMd: d.syncDeploymentMd === true,
			uptimeEnabled: d.uptimeEnabled === true,
			healthUrl: (d.healthUrl as string) ?? null,
			previewsEnabled: d.previewsEnabled === true,
			previewBlockReason: typeof d.previewBlockReason === 'string' ? d.previewBlockReason : null,
			dockerfilePath: typeof d.dockerfilePath === 'string' && d.dockerfilePath ? d.dockerfilePath : './Dockerfile',
			containerPort: typeof d.containerPort === 'number' ? d.containerPort : null,
			autoRollback: d.autoRollback !== false,
			deploySettleSeconds: typeof d.deploySettleSeconds === 'number' ? d.deploySettleSeconds : null,
		})
	}, [])
	const first = useRef(true)
	const read = useMemo(
		() =>
			singleFlight(async () => {
				try {
					if (first.current) {
						first.current = false
						await fetch(`/api/projects/${id}?part=db`)
							.then((r) => r.json())
							.then(apply)
							.catch(() => {})
						setLoading(false)
					}
					await fetch(`/api/projects/${id}`)
						.then((r) => r.json())
						.then(apply)
						.catch(() => {})
				} finally {
					setLoading(false)
				}
			}),
		[id, apply],
	)
	const reload = useCallback(() => read(true), [read])

	const deploysRef = useRef<Deploy[]>(deploys)
	deploysRef.current = deploys

	useEffect(() => {
		void read(false)
		// While a deploy is running or queued, poll so the header status stays
		// current: every 3s, or every 15s while the server does not answer (each
		// read waits on an SSH timeout). A poll is skipped while a read is in flight.
		let t: ReturnType<typeof setTimeout>
		const tick = () => {
			t = setTimeout(
				() => {
					if (deploysRef.current.some((d) => d.status === 'running' || d.status === 'queued'))
						void read(false)
					tick()
				},
				lastUnreachable.current ? 15_000 : 3000,
			)
		}
		tick()
		return () => clearTimeout(t)
	}, [read])

	return (
		<Ctx.Provider value={{ id, loading, project, deploys, crons, uptime, deployDays, meta, reload }}>
			{children}
		</Ctx.Provider>
	)
}

// Header status: the shared authority (lib/app-health.ts) fed with this app's facts.
export function computeProjectStatus(
	deploys: Deploy[],
	uptime: Uptime | null,
	container?: Container,
): AppHealth {
	return appHealth({
		lastDeploy: deploys[0] ?? null,
		uptime,
		serverReachable: container ? container.reachable : undefined,
		containerMissing: container
			? container.reachable && !container.exists && !('dockerError' in container)
			: false,
		dockerFailed: container ? 'dockerError' in container : false,
		containerStatus: container?.exists ? container.status : undefined,
	})
}

// Shared formatter - appears on every tab.
export function repoSlug(url: string): string {
	const ssh = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/)
	if (ssh) return `${ssh[1]}/${ssh[2]}`
	const https = url.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
	if (https) return `${https[1]}/${https[2]}`
	return url
}

export function repoHttpsUrl(url: string): string {
	const slug = repoSlug(url)
	return slug !== url ? `https://github.com/${slug}` : url
}

export { timeAgoDays as timeAgo }
