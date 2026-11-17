import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const cronJobs = pgTable('cron_jobs', {
	id: text('id').primaryKey(),
	ownerUserId: text('owner_user_id').notNull(),
	serverId: text('server_id').notNull(),
	containerName: text('container_name').notNull(),
	schedule: text('schedule').notNull(), // 5-field cron expression, evaluated in `timezone`
	timezone: text('timezone').notNull().default('UTC'), // IANA zone name (0053)
	kind: text('kind').notNull().default('http'), // 'http' | 'exec'
	urlPath: text('url_path'), // for http: the path on the app, e.g. /api/cron/digest
	httpMethod: text('http_method').notNull().default('POST'), // 'GET' | 'POST' (0053)
	// http: name of an app env var whose value is sent as `Authorization: Bearer`.
	// NULL = the per-app POWDER_CRON_TOKEN (0053).
	bearerEnvVar: text('bearer_env_var'),
	// exec, sh -c form: one string run via `sh -c` in the container. Still run
	// when set; new and edited jobs store execArgv instead.
	execCommand: text('exec_command'),
	// exec: argv passed to `docker exec <container>`. Each element is shell-quoted
	// on the host and never interpreted by a shell (0053).
	execArgv: jsonb('exec_argv').$type<string[]>(),
	timeoutSeconds: integer('timeout_seconds').notNull().default(30), // (0053)
	// Set while a run is in flight: the overlap guard (0053). Treated as stale
	// after timeout + grace so a crashed worker does not block the job forever.
	runningSince: timestamp('running_since', { withTimezone: true }),
	// The host crontab line this job was imported from, if any (0053).
	importedFrom: text('imported_from'),
	description: text('description'),
	enabled: boolean('enabled').notNull().default(true),
	nextRunAt: timestamp('next_run_at', { withTimezone: true }),
	lastRunAt: timestamp('last_run_at', { withTimezone: true }),
	lastRunStatus: text('last_run_status'), // 'success' | 'failed' | 'timeout'
	lastRunError: text('last_run_error'),
	lastRunHttpStatus: integer('last_run_http_status'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CronJob = typeof cronJobs.$inferSelect
export type NewCronJob = typeof cronJobs.$inferInsert

// One row per run of a powder-managed job (scheduled, manual, or skipped for
// overlap). Not to be confused with cron_runs, which records observed HOST cron
// firings. Pruned to the newest runs per job after each run (cron-scheduler.ts).
export const cronJobRuns = pgTable(
	'cron_job_runs',
	{
		id: text('id').primaryKey(),
		cronJobId: text('cron_job_id').notNull(),
		trigger: text('trigger').notNull(), // 'schedule' | 'manual'
		status: text('status').notNull(), // 'running' | 'success' | 'failed' | 'timeout' | 'skipped'
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		durationMs: integer('duration_ms'),
		httpStatus: integer('http_status'),
		exitCode: integer('exit_code'),
		output: text('output'), // capped head + tail (lib/capped-output.ts)
		error: text('error'),
	},
	(t) => ({
		byJob: index('cron_job_runs_job_idx').on(t.cronJobId, t.startedAt),
	}),
)

export type CronJobRun = typeof cronJobRuns.$inferSelect
export type NewCronJobRun = typeof cronJobRuns.$inferInsert
