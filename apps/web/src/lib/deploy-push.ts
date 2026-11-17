// the DB side of deployPushDecision (deploy-push-policy.ts): the push history
// before the 0058 cutoff and the registered apps. Fails closed: no cutoff row or a DB
// error skips the push (the deploy still succeeds, the tag stays local).

import { appRepos, db, eq, powderMeta, sql } from './db'
import {
	DEPLOY_PUSH_CUTOFF_KEY,
	type PushDecision,
	type PushHistoryRow,
	deployPushDecision,
	pushRepoOf,
	refusedPush,
} from './deploy-push-policy'

export async function loadDeployPushDecision(app: string, image: string): Promise<PushDecision> {
	try {
		const meta = await db
			.select()
			.from(powderMeta)
			.where(eq(powderMeta.key, DEPLOY_PUSH_CUTOFF_KEY))
		const raw = meta[0]?.value ?? null
		const cutoff = raw && !Number.isNaN(new Date(raw).getTime()) ? new Date(raw) : null
		if (!cutoff)
			return refusedPush(`no ${DEPLOY_PUSH_CUTOFF_KEY} row in powder_meta (migration 0058 has not run)`)
		const rows = (await db.execute(sql`
			SELECT container_name AS app, regexp_replace(image_tag, ':deploy-[^:/]*$', '') AS tag, max(started_at) AS last
			FROM deploys
			WHERE status = 'success' AND image_tag IS NOT NULL AND started_at < ${cutoff.toISOString()}::timestamptz
			GROUP BY 1, 2`)) as unknown as Array<{ app: string; tag: string; last: string | Date }>
		const history: PushHistoryRow[] = rows.map((r) => ({
			app: r.app,
			repo: pushRepoOf(r.tag),
			last: new Date(r.last),
		}))
		const registered = (await db.select({ name: appRepos.containerName }).from(appRepos)).map(
			(r) => r.name,
		)
		return deployPushDecision(app, image, history, registered)
	} catch (err) {
		return refusedPush(`could not read the push history (${err instanceof Error ? err.message : String(err)})`)
	}
}
