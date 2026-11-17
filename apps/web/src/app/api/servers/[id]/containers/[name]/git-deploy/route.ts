import { requireContainerAccess } from '@/lib/access'
import { and, appRepos, db, eq } from '@/lib/db'
import { runInWeb } from '@/lib/deploy-runner'
import { deployWorkerEnabled, tryStartDeploy } from '@/lib/deploys'
import { notifyDeploymentStarted } from '@/lib/github-deployments'
import { inspectContainer } from '@/lib/ssh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access
	if (server.kind !== 'compose') {
		return Response.json({ error: 'git deploy needs a compose-style server' }, { status: 400 })
	}

	const detail = await inspectContainer(server, name)
	const { workingDir, configFile, service } = detail.compose
	if (!workingDir || !configFile || !service) {
		return Response.json(
			{ error: 'container has no compose working dir / config / service labels' },
			{ status: 400 },
		)
	}

	const deployOrResp = await tryStartDeploy({
		serverId: id,
		containerName: name,
		kind: 'git_deploy',
		// manual: never held on the settle window, and releases a held queued push
		urgent: true,
	})
	if (deployOrResp instanceof Response) return deployOrResp
	const deploy = deployOrResp

	// Pre-fetch the app_repo so we can post GH deploy status. Used both for
	// the start notification here and for the failure-email lookup later.
	const [repoForGh] = await db
		.select()
		.from(appRepos)
		.where(and(eq(appRepos.serverId, id), eq(appRepos.containerName, name)))
	if (repoForGh) await notifyDeploymentStarted(repoForGh, deploy, repoForGh.branch)

	// Hand off execution. Worker mode: the row is 'queued', the deploy worker
	// runs it and flushes partial output to the row (the SSE stream route polls
	// the row for live logs cross-process). In-web mode: run it here;
	// executeDeploy publishes chunks + the terminal event to the in-process
	// deploy-bus, which the SSE subscriber in this process picks up.
	if (!deployWorkerEnabled()) {
		runInWeb(deploy)
	}

	return Response.json({ deployId: deploy.id }, { status: 202 })
}
