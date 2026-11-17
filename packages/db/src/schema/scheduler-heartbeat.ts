import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Single-row liveness stamp for the in-process cron scheduler.
//
// The scheduler can run in the separate deploy-worker process
// (POWDER_DEPLOY_WORKER), where the web process cannot see an in-memory stamp:
// they're different processes. So the heartbeat lives in this DB row:
// whoever owns the scheduler upserts `id='scheduler'` each tick, and the web
// /api/health route reads it back to know the scheduler is alive cross-process.
export const schedulerHeartbeat = pgTable('scheduler_heartbeat', {
	// Always the literal 'scheduler' — this table holds exactly one row.
	id: text('id').primaryKey(),
	started: boolean('started').notNull().default(false),
	lastTickAt: timestamp('last_tick_at', { withTimezone: true }),
	// Which process owns the scheduler: 'worker' (normal) or 'web' (in-web
	// mode, POWDER_DEPLOY_WORKER off). Purely informational for debugging the /api/health output.
	owner: text('owner'),
})

export type SchedulerHeartbeat = typeof schedulerHeartbeat.$inferSelect
export type NewSchedulerHeartbeat = typeof schedulerHeartbeat.$inferInsert
