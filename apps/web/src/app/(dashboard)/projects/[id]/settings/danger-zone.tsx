'use client'

import { Skeleton } from '@/components/ui/skeleton'
// Settings: the runtime block (stop / start) and the danger zone (delete).
//   stop   POST /api/servers/[id]/containers/[name]/stop
//   start  POST /api/servers/[id]/containers/[name]/apply (compose guard, then
//          `compose up` of the app service; a stopped container is never just
//          `docker start`ed, lib/app-lifecycle.ts)
//   delete DELETE /api/servers/[id]/containers/[name] with { confirm: name }
//          (admin browser session only)

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { ServerUnreachable } from '@/components/server-unreachable'
import type { Project } from '../_lib/project-context'

type Pending = 'stop' | 'delete' | null

export function AppControls({ project, reload }: { project: Project; reload: () => void }) {
	const router = useRouter()
	const toast = useToast()
	const [pending, setPending] = useState<Pending>(null)
	const [busy, setBusy] = useState<'stop' | 'start' | 'delete' | null>(null)
	const [typed, setTyped] = useState('')
	const name = project.containerName
	const base = `/api/servers/${encodeURIComponent(project.serverId)}/containers/${encodeURIComponent(name)}`
	const c = project.container
	const running = !!c?.exists && c.status.startsWith('running')
	const workingDir = `/opt/apps/${name}`

	useEffect(() => {
		if (pending === 'delete') setTyped('')
	}, [pending])

	async function call(kind: 'stop' | 'start' | 'delete'): Promise<Record<string, unknown> | null> {
		setBusy(kind)
		try {
			const res = await fetch(kind === 'stop' ? `${base}/stop` : kind === 'start' ? `${base}/apply` : base, {
				method: kind === 'delete' ? 'DELETE' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: kind === 'delete' ? JSON.stringify({ confirm: typed }) : undefined,
			})
			const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
			if (!res.ok) {
				toast.error(`${kind} failed: ${typeof data.error === 'string' ? data.error : res.status}`)
				return null
			}
			return data
		} catch {
			toast.error(`${kind} failed: network error`)
			return null
		} finally {
			setBusy(null)
		}
	}

	async function stop() {
		const d = await call('stop')
		setPending(null)
		if (d) {
			toast.success(typeof d.output === 'string' && d.output.startsWith('already stopped') ? 'already stopped' : `${name} stopped`)
			reload()
		}
	}

	async function start() {
		const d = await call('start')
		if (d) {
			toast.success('starting: follow it on the deployments tab')
			router.push(`/projects/${project.id}/deployments`)
		}
	}

	async function remove() {
		if (typed !== name) return
		const d = await call('delete')
		if (d) {
			setPending(null)
			toast.success(`${name} deleted. its directory and volumes are still on the server.`)
			// Only the app container went: another app shares its compose project name.
			if (typeof d.projectNote === 'string') toast.push('info', d.projectNote)
			router.push('/projects')
		}
	}

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>runtime</CardTitle>
				</CardHeader>
				{!c ? (
					<CardContent>
						<Skeleton className="h-10 w-full" />
					</CardContent>
				) : !c.reachable ? (
					<CardContent>
						<ServerUnreachable
							serverId={project.serverId}
							serverName={project.serverName}
							error={c.error}
							onRetry={reload}
							what="whether the app is running"
							className="border-0 bg-transparent p-0 shadow-none sm:p-0"
						/>
					</CardContent>
				) : 'dockerError' in c ? (
					<CardContent>
						<ServerUnreachable
							kind="docker"
							serverId={project.serverId}
							serverName={project.serverName}
							error={c.dockerError}
							onRetry={reload}
							what="whether the app is running"
							className="border-0 bg-transparent p-0 shadow-none sm:p-0"
						/>
					</CardContent>
				) : (
					<CardContent className="p-0 sm:p-0">
						<Row
							title={running ? 'stop the app' : 'start the app'}
							description={
								running ? (
									<>
										stops the <code className="font-mono">{name}</code> container. its database and
										other services keep running. the next push or redeploy starts it again.
									</>
								) : c.exists ? (
									<>
										the container is <span className="font-mono">{c.status}</span>. start runs the
										compose checks, then brings the app service up from its last image.
									</>
								) : (
									<>
										there is no <code className="font-mono">{name}</code> container on{' '}
										{project.serverName}. redeploy to build and start it.
									</>
								)
							}
							action={
								running ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() => setPending('stop')}
										loading={busy === 'stop'}
									>
										stop
									</Button>
								) : (
									<Button
										variant="outline"
										size="sm"
										onClick={start}
										loading={busy === 'start'}
										disabled={!c.exists}
									>
										start
									</Button>
								)
							}
						/>
					</CardContent>
				)}
			</Card>

			<Card className="border-destructive/30">
				<CardHeader>
					<CardTitle>danger zone</CardTitle>
				</CardHeader>
				<CardContent className="p-0 sm:p-0">
					<Row
						title="delete this app"
						description={
							<>
								stops and removes its containers and previews, removes powder's deploy key and webhook
								from the repo, and drops the app from powder. data on the server stays.
							</>
						}
						action={
							<Button variant="destructive-outline" size="sm" onClick={() => setPending('delete')}>
								delete app
							</Button>
						}
					/>
				</CardContent>
			</Card>

			<ConfirmDialog
				open={pending === 'stop'}
				title={`stop ${name}?`}
				description="the app stops serving until you start it, push or redeploy. its database keeps running."
				confirmLabel="stop"
				danger
				loading={busy === 'stop'}
				onConfirm={() => void stop()}
				onClose={() => busy !== 'stop' && setPending(null)}
			/>

			<ConfirmDialog
				open={pending === 'delete'}
				title={`delete ${name}?`}
				danger
				confirmLabel="delete app"
				loading={busy === 'delete'}
				confirmDisabled={typed !== name}
				onConfirm={() => void remove()}
				// the DELETE in flight keeps the dialog open (Escape, backdrop)
				onClose={() => busy !== 'delete' && setPending(null)}
				description={
					<div className="space-y-3">
						<p>
							stops and removes the app's containers (the app and the other services of its compose
							project, such as a bundled database) and its previews, removes its domain redirects from the
							proxy, and drops its crons, custom domains, env vars, uptime check and repo link from powder.
							the GitHub repo itself is not touched.
						</p>
						<div>
							<p className="font-medium text-foreground">kept on the server</p>
							<ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
								<li>
									<code className="font-mono">{workingDir}</code>: compose file, checkout and bind-mounted
									data such as <code className="font-mono">pgdata/</code>
								</li>
								<li>named Docker volumes</li>
								<li>
									the env file, moved to{' '}
									<code className="break-all font-mono">/var/lib/powder/deleted-env/{name}-&lt;time&gt;/</code>
								</li>
							</ul>
							<p className="mt-1.5 text-xs">
								to remove them by hand, on the server: <code className="font-mono">rm -rf {workingDir}</code>
								, <code className="font-mono">docker volume ls</code> then{' '}
								<code className="font-mono">docker volume rm &lt;name&gt;</code>, and the env archive dir.
							</p>
						</div>
						<div>
							<label htmlFor="delete-app-confirm" className="block text-xs font-medium text-foreground">
								type <span className="font-mono">{name}</span> to confirm
							</label>
							<Input
								id="delete-app-confirm"
								data-autofocus
								value={typed}
								onChange={(e) => setTyped(e.target.value)}
								autoComplete="off"
								spellCheck={false}
								className="mt-1.5 font-mono"
							/>
						</div>
					</div>
				}
			/>
		</>
	)
}

function Row({
	title,
	description,
	action,
}: {
	title: string
	description: React.ReactNode
	action: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
			<div className="min-w-0 max-w-xl">
				<p className="text-sm font-medium">{title}</p>
				<CardDescription className="mt-0.5 leading-relaxed">{description}</CardDescription>
			</div>
			<div className="shrink-0">{action}</div>
		</div>
	)
}
