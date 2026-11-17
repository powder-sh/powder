// Manual redeploy from the /projects/[id] page.
// Re-fires the same code path as a github push webhook would: git pull, build,
// up -d --force-recreate. Records as a fresh deploy row.

import { requireProjectAccess } from '@/lib/access'
import { runInWeb } from '@/lib/deploy-runner'
import { deployWorkerEnabled, tryStartDeploy } from '@/lib/deploys'
import { notifyDeploymentStarted } from '@/lib/github-deployments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const { repo, user } = access

	const deployOrResp = await tryStartDeploy({
		serverId: repo.serverId,
		containerName: repo.containerName,
		kind: 'git_deploy',
		triggeredBy: `manual:${user.email ?? user.id}`,
		// never held on the settle window; a held queued push is released instead
		// (tryStartDeploy answers 200 with that row's id)
		urgent: true,
	})
	if (deployOrResp instanceof Response) return deployOrResp
	const deploy = deployOrResp

	await notifyDeploymentStarted(repo, deploy, repo.branch)

	// Hand off execution. executeDeploy re-derives compose info from the running
	// container (falling back to the /opt/apps/<name> convention when the
	// container doesn't exist yet — the first-deploy-failed case). Worker mode:
	// 'queued', worker runs it. In-web mode: run it here. UI polls the deploy row.
	if (!deployWorkerEnabled()) {
		runInWeb(deploy)
	}

	return Response.json({ ok: true, deployId: deploy.id })
}
