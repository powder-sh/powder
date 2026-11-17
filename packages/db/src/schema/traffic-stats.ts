import { bigint, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

// Hourly traffic buckets per container on a Traefik server, aggregated from
// Traefik's JSON access log. Populated by a 5-min cron tick that tails the
// log on each Traefik server since the last cursor.
//
// Composite PK (server_id, container_name, hour_bucket): one row per app per
// hour. Aggregator UPSERTs with += on each tick, idempotent within an hour
// because we only process log lines newer than the last cursor.
export const appTrafficStats = pgTable(
	'app_traffic_stats',
	{
		serverId: text('server_id').notNull(),
		containerName: text('container_name').notNull(),
		hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
		requests: integer('requests').notNull().default(0),
		bytesOut: bigint('bytes_out', { mode: 'number' }).notNull().default(0),
		status2xx: integer('status_2xx').notNull().default(0),
		status3xx: integer('status_3xx').notNull().default(0),
		status4xx: integer('status_4xx').notNull().default(0),
		status5xx: integer('status_5xx').notNull().default(0),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.serverId, t.containerName, t.hourBucket] }),
		// For "show me this app's last 7 days" queries.
		containerHourIdx: index('app_traffic_stats_container_hour_idx').on(
			t.serverId,
			t.containerName,
			t.hourBucket,
		),
	}),
)

// One row per Traefik server. Tracks how far we've processed the
// access log so re-runs don't double-count. We process by `time` field
// from Traefik's JSON output, not file offset, so log rotation is safe.
export const trafficCursors = pgTable('traffic_cursors', {
	serverId: text('server_id').primaryKey(),
	lastProcessedAt: timestamp('last_processed_at', { withTimezone: true }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AppTrafficStat = typeof appTrafficStats.$inferSelect
export type NewAppTrafficStat = typeof appTrafficStats.$inferInsert
export type TrafficCursor = typeof trafficCursors.$inferSelect
