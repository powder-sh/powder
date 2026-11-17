import { requireContainerAccess, requireUser } from '@/lib/access'
import { and, appRepos, db, deploys, desc, eq, isNotNull, sql } from '@/lib/db'
import { redactNullable } from '@/lib/secret-text'
import { heldSql, settleNote } from '@/lib/deploy-settle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ deployId: string }> }) {
	// authenticate before the lookup so unknown and known ids look alike.
	const user = await requireUser()
	if (user instanceof Response) return user
	const { deployId } = await ctx.params
	const [deploy] = await db.select().from(deploys).where(eq(deploys.id, deployId))
	if (!deploy) return Response.json({ error: 'unknown deploy' }, { status: 404 })
	const access = await requireContainerAccess(deploy.serverId, deploy.containerName)
	if (access instanceof Response) return access
	// Next steps for the page header: the app to redeploy, and the newest good
	// deploy with an image to roll back to (what the rollback route accepts).
	const [app] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, deploy.serverId), eq(appRepos.containerName, deploy.containerName)))
		.limit(1)
	const [lastGood] = await db
		.select({ id: deploys.id, gitSha: deploys.gitSha })
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, deploy.serverId),
				eq(deploys.containerName, deploy.containerName),
				eq(deploys.status, 'success'),
				isNotNull(deploys.imageTag),
				sql`${deploys.id} <> ${deploy.id}`,
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	const [latest] = await db
		.select({ id: deploys.id, status: deploys.status, held: sql<boolean>`${sql.raw(heldSql('"deploys"'))}` })
		.from(deploys)
		.where(and(eq(deploys.serverId, deploy.serverId), eq(deploys.containerName, deploy.containerName)))
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	// masked at read like every other deploy-text reader (a row the write-side
	// mask missed, or text only a newer pattern catches).
	return Response.json({
		deploy: {
			...deploy,
			output: redactNullable(deploy.output),
			error: redactNullable(deploy.error),
			errorSummary: redactNullable(deploy.errorSummary),
			// failedStep is parsed from the script output, masked like MCP does.
			failedStep: redactNullable(deploy.failedStep),
		},
		// held on the settle window (lib/deploy-settle.ts): when it deploys, how to skip it
		waiting: settleNote(deploy),
		appId: app?.id ?? null,
		isLatest: latest?.id === deploy.id,
		// A newer deploy of this app still in flight: the page shows redeploy and
		// roll back disabled instead of hiding them. A push held on the settle window is
		// not in flight: rollback cancels it, redeploy releases it.
		activeDeployId:
			latest && latest.id !== deploy.id && latest.held !== true && (latest.status === 'running' || latest.status === 'queued')
				? latest.id
				: null,
		lastGood: access.server.kind === 'compose' ? (lastGood ?? null) : null,
	})
}
