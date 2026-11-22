import { requireContainerAccess, requireUser } from '@/lib/access'
import { and, appRepos, db, deploys, desc, eq, gte, isNotNull, sql } from '@/lib/db'
import { failedBeforeSwap, rollbackChangesNothing } from '@/lib/deploy-swap'
import { deployListOrder } from '@/lib/deploy-order-db'
import { redactNullable } from '@/lib/secret-text'
import { heldSql, settleNote } from '@/lib/deploy-settle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// deploys read to decide whether a rollback would change anything; more than this
// (a busy app) and the page offers the rollback as before
const SINCE_LIMIT = 50

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
		.select({ id: deploys.id, gitSha: deploys.gitSha, startedAt: deploys.startedAt })
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
		// started_at, not the list order: lastGood is the success that swapped last
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	// the newest deploy of the app in list order (lib/deploy-order.ts), as the lists show it
	const [latest] = await db
		.select({ id: deploys.id, status: deploys.status, held: sql<boolean>`${sql.raw(heldSql('"deploys"'))}` })
		.from(deploys)
		.where(and(eq(deploys.serverId, deploy.serverId), eq(deploys.containerName, deploy.containerName)))
		.orderBy(...deployListOrder())
		.limit(1)
	// A failure before the swap left the running version alone: when nothing since the last
	// good deploy succeeded or may have swapped, that version is what runs, and a rollback
	// to it would only recreate the same container (lib/deploy-swap.ts).
	let rollbackUnchanged = false
	if (lastGood && deploy.status === 'failed' && failedBeforeSwap(deploy.failedStep)) {
		const since = await db
			.select({ id: deploys.id, status: deploys.status, failedStep: deploys.failedStep })
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, deploy.serverId),
					eq(deploys.containerName, deploy.containerName),
					gte(deploys.startedAt, lastGood.startedAt),
				),
			)
			.limit(SINCE_LIMIT + 1)
		rollbackUnchanged = rollbackChangesNothing(deploy, lastGood, since.slice(0, SINCE_LIMIT), since.length <= SINCE_LIMIT)
	}
	// masked at read like every other deploy-text reader (a row the write-side
	// mask missed, or text only a newer pattern catches).
	return Response.json({
		// an explicit pick, never a spread of the row: no raw text column can ride along
		// (the deploy page and MCP get_deploy read these)
		deploy: {
			id: deploy.id,
			serverId: deploy.serverId,
			containerName: deploy.containerName,
			kind: deploy.kind,
			status: deploy.status,
			queuedAt: deploy.queuedAt,
			startedAt: deploy.startedAt,
			finishedAt: deploy.finishedAt,
			heartbeatAt: deploy.heartbeatAt,
			notBefore: deploy.notBefore,
			triggeredBy: deploy.triggeredBy,
			gitSha: deploy.gitSha,
			builtSha: deploy.builtSha,
			requestedSha: deploy.requestedSha,
			gitBranch: deploy.gitBranch,
			imageTag: deploy.imageTag,
			composeConfigHash: deploy.composeConfigHash,
			composeConfigView: deploy.composeConfigView,
			rolledBackFromId: deploy.rolledBackFromId,
			snapshotContainer: deploy.snapshotContainer,
			snapshotUrl: deploy.snapshotUrl,
			snapshotExpiresAt: deploy.snapshotExpiresAt,
			githubDeploymentId: deploy.githubDeploymentId,
			testGate: deploy.testGate,
			exitCode: deploy.exitCode,
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
		lastGood: access.server.kind === 'compose' && lastGood ? { id: lastGood.id, gitSha: lastGood.gitSha } : null,
		// true: lastGood is the version running now, a rollback to it would change nothing
		rollbackUnchanged,
	})
}
