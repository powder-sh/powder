import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// One row per app the scheduler is uptime-pinging.
// `is_up` flips on the first 5xx/timeout; flips back on the next 2xx.
// We notify (webhook) on every UP→DOWN transition, throttled by cooldown.
export const appUptimeChecks = pgTable('app_uptime_checks', {
	appRepoId: text('app_repo_id').primaryKey(),
	url: text('url').notNull(),
	lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
	lastStatusCode: integer('last_status_code'),
	isUp: boolean('is_up').notNull().default(true),
	consecutiveFailures: integer('consecutive_failures').notNull().default(0),
	lastDownAt: timestamp('last_down_at', { withTimezone: true }),
	lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AppUptimeCheck = typeof appUptimeChecks.$inferSelect
export type NewAppUptimeCheck = typeof appUptimeChecks.$inferInsert
