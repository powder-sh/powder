import { requireContainerAccess } from '@/lib/access'
import { checkComposeForRecreate, owningAppFor, unregisteredApproval } from '@/lib/recreate-guard'
import { chunkPublisher, publishTerminal } from '@/lib/deploy-bus'
import { finishDeploy, tryStartDeploy } from '@/lib/deploys'
import { composeUpService, inspectContainer } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access
	if (server.kind !== 'compose') {
		return Response.json({ error: 'apply only works on compose servers for now' }, { status: 400 })
	}

	const detail = await inspectContainer(server, name)
	const { configFile, service, workingDir, configFiles } = detail.compose
	if (!configFile || !service) {
		return Response.json(
			{ error: 'no compose config file or service on this container' },
			{ status: 400 },
		)
	}

	// the project-name check needs the app name. The app is the container's own
	// app_repos row, else the app whose compose project the container is in (a sidecar); a
	// container no app owns skips the project-name check and the deploy's compose guard.
	const owner = await owningAppFor(id, name, detail.compose.project)

	const deployOrResp = await tryStartDeploy({
		serverId: id,
		containerName: name,
		kind: 'manual_apply',
		inline: true, // this route runs the work itself — the worker must not claim it
	})
	if (deployOrResp instanceof Response) return deployOrResp
	const deploy = deployOrResp

	// Fire-and-forget. The browser opens an SSE stream on /api/deploys/[id]/stream
	// to watch this deploy's output live.
	void (async () => {
		const stream = chunkPublisher(deploy.id)
		try {
			const wd = workingDir || configFile.replace(/\/[^/]*$/, '')
			const approval = owner
				? await checkComposeForRecreate(server, { app: owner, configFile, composeFiles: configFiles, workingDir: wd, what: 'apply' })
				: unregisteredApproval(name)
			stream.chunk(approval.log)
			const { stdout } = await composeUpService(
				server,
				configFile,
				service,
				(chunk) => stream.chunk(chunk),
				{
					workingDir: wd,
					composeFiles: configFiles,
					approval,
					...(owner ? { app: owner } : {}),
				},
			)
			stream.flush()
			await finishDeploy(deploy.id, { status: 'success', output: approval.log + stdout })
			publishTerminal(deploy.id, 'end', 'success')
		} catch (err) {
			const message = clientErrorMessage(err, 'unknown error', 'servers/:id/containers/:name/apply')
			stream.flush()
			await finishDeploy(deploy.id, { status: 'failed', error: message })
			publishTerminal(deploy.id, 'error', message)
		}
	})()

	return Response.json({ deployId: deploy.id }, { status: 202 })
}
