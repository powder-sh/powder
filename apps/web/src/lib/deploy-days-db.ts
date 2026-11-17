// The one query behind the deploy strips: successful and failed deploys per
// UTC day for a set of apps, over the last DEPLOY_DAYS days. Read-only, one
// grouped query for any number of apps. Bucketing is in lib/deploy-days.ts.

import { db, sql } from './db'
import { DEPLOY_DAYS, type DeployDay, type DeployDayRow, bucketDeployDays } from './deploy-days'

export async function deployDaysFor(
	apps: readonly { serverId: string; containerName: string }[],
	now = Date.now(),
): Promise<Map<string, DeployDay[]>> {
	if (apps.length === 0) return new Map()
	const rows = (await db.execute(sql`
		SELECT server_id, container_name,
			to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
			count(*) FILTER (WHERE status = 'success')::int AS ok,
			count(*) FILTER (WHERE status = 'failed')::int AS failed
		FROM deploys
		WHERE started_at >= ${new Date(now - DEPLOY_DAYS * 86_400_000).toISOString()}::timestamptz
			AND (server_id, container_name) IN (
				${sql.join(
					apps.map((a) => sql`(${a.serverId}, ${a.containerName})`),
					sql`, `,
				)}
			)
		GROUP BY 1, 2, 3
	`)) as unknown as DeployDayRow[]
	return bucketDeployDays(rows, now)
}
