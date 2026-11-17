// Insert one managed cron job (validated by parseJobInput). Shared by the
// create route and the server-side host-cron import.
import { ensureAppCronToken } from './cron-scheduler'
import type { CronTokenState } from './cron-token-reveal'
import { createId, cronJobs, db, prefixes } from './db'
import { type JobInput, computeNextRun } from './managed-crons'

export async function insertCronJob(
	ownerUserId: string,
	serverId: string,
	containerName: string,
	j: JobInput,
): Promise<{ id: string; cronToken: CronTokenState }> {
	const cronId = createId(prefixes.cronJob)
	await db.insert(cronJobs).values({
		id: cronId,
		ownerUserId,
		serverId,
		containerName,
		schedule: j.schedule,
		timezone: j.timezone,
		kind: j.kind,
		httpMethod: j.httpMethod,
		urlPath: j.urlPath,
		bearerEnvVar: j.bearerEnvVar,
		execCommand: null,
		execArgv: j.execArgv,
		timeoutSeconds: j.timeoutSeconds,
		description: j.description,
		importedFrom: j.importedFrom,
		enabled: j.enabled,
		nextRunAt: j.enabled ? computeNextRun(j.schedule, new Date(), j.timezone) : null,
	})
	// http jobs without a named bearer var use the per-app POWDER_CRON_TOKEN: create it
	// now. The route reveals it only when this call minted it (cronTokenField).
	const t =
		j.kind === 'http' && !j.bearerEnvVar ? await ensureAppCronToken(serverId, containerName) : null
	return { id: cronId, cronToken: t ? { value: t.token, minted: t.minted } : null }
}
