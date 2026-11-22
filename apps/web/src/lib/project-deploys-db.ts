// The per-app deploy list of GET /api/projects/<id>: the newest RECENT_DEPLOYS deploys, with
// windows of the log columns (a log can be megabytes; lib/deploy-log-read.ts masks them).
// The ids are picked first in a subquery (order + LIMIT on plain columns), and the windows
// are computed only for those rows: left()/right() on every row of the app before the LIMIT
// decompressed every log the app ever wrote, on a route the dashboard polls during deploys.
import { and, db, deploys, eq, inArray, sql } from './db'
import { LOG_WINDOW_CHARS } from './deploy-log-read'
import { deployListOrder } from './deploy-order-db'

export const RECENT_DEPLOYS = 30
// how much of a deploy's output the preview reads (the preview shows 500 characters)
export const PREVIEW_HEAD_CHARS = 8 * 1024

export function recentDeploysQuery(serverId: string, containerName: string) {
	const recentIds = db
		.select({ id: deploys.id })
		.from(deploys)
		.where(and(eq(deploys.serverId, serverId), eq(deploys.containerName, containerName)))
		// newest push first, like every deploy list (lib/deploy-order.ts)
		.orderBy(...deployListOrder())
		.limit(RECENT_DEPLOYS)
	const failed = sql`${deploys.status} = 'failed'`
	return db
		.select({
			id: deploys.id,
			status: deploys.status,
			kind: deploys.kind,
			queuedAt: deploys.queuedAt,
			startedAt: deploys.startedAt,
			finishedAt: deploys.finishedAt,
			gitSha: deploys.gitSha,
			builtSha: deploys.builtSha,
			requestedSha: deploys.requestedSha,
			gitBranch: deploys.gitBranch,
			imageTag: deploys.imageTag,
			failedStep: deploys.failedStep,
			exitCode: deploys.exitCode,
			errorSummary: deploys.errorSummary,
			notBefore: deploys.notBefore,
			// the preview is cut to 500 characters after masking; this head leaves room for that
			output: sql<string | null>`left(${deploys.output}, ${PREVIEW_HEAD_CHARS})`,
			outputWindow: sql<string | null>`CASE WHEN ${failed} THEN right(${deploys.output}, ${LOG_WINDOW_CHARS}) END`,
			error: sql<string | null>`CASE WHEN ${failed} THEN right(${deploys.error}, ${LOG_WINDOW_CHARS}) END`,
		})
		.from(deploys)
		.where(inArray(deploys.id, recentIds))
		.orderBy(...deployListOrder())
}
