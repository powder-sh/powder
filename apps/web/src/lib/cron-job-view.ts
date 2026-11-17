// JSON shape of a managed cron job (+ its recent runs) for the Crons tab.
// Run errors and output are masked on write since the secret-text change; the
// read masks them again for rows stored before it.
import type { CronJob, CronJobRun } from './db'
import { redactNullable } from './secret-text'

export function serializeJob(m: CronJob, runs: CronJobRun[]) {
	return {
		id: m.id,
		schedule: m.schedule,
		timezone: m.timezone,
		kind: m.kind,
		httpMethod: m.httpMethod,
		urlPath: m.urlPath,
		bearerEnvVar: m.bearerEnvVar,
		execCommand: m.execCommand,
		execArgv: m.execArgv,
		timeoutSeconds: m.timeoutSeconds,
		description: m.description,
		importedFrom: m.importedFrom,
		enabled: m.enabled,
		running: m.runningSince !== null,
		nextRunAt: m.nextRunAt,
		lastRunAt: m.lastRunAt,
		lastRunStatus: m.lastRunStatus,
		lastRunError: redactNullable(m.lastRunError),
		lastRunHttpStatus: m.lastRunHttpStatus,
		runs: runs.map((r) => ({
			id: r.id,
			trigger: r.trigger,
			status: r.status,
			startedAt: r.startedAt,
			finishedAt: r.finishedAt,
			durationMs: r.durationMs,
			httpStatus: r.httpStatus,
			exitCode: r.exitCode,
			error: redactNullable(r.error),
			output: redactNullable(r.output),
		})),
	}
}
