import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// Observed cron firings, scraped from each server's journalctl CRON output by
// the cron-observer tick (lib/cron-observer.ts). One row per discovered
// CRON[pid]: CMD line. Deduped by (server, time, command-snippet) so re-scraping
// is idempotent.
//
// Why this exists: cron_jobs rows hold the *schedule* but are mostly
// `enabled = false` (the real crons live in host crontabs). The activity feed
// needs "what fired and when" — that's this table.
export const cronRuns = pgTable(
	'cron_runs',
	{
		id: text('id').primaryKey(),
		serverId: text('server_id').notNull(),
		// Derived from `docker exec <name>` in the command, or `(host)` when the
		// cron isn't container-scoped. Activity feed joins on this to limit rows
		// to apps the user owns.
		containerName: text('container_name').notNull(),
		// First ~120 chars of the command after stripping leading env vars and
		// `cd … && `. Used for dedup + display.
		commandSnippet: text('command_snippet').notNull(),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		cronRunsDedup: uniqueIndex('cron_runs_dedup').on(t.serverId, t.startedAt, t.commandSnippet),
		cronRunsByApp: index('cron_runs_by_app_idx').on(t.serverId, t.containerName, t.startedAt),
		cronRunsByAt: index('cron_runs_by_at_idx').on(t.startedAt),
	}),
)

export type CronRun = typeof cronRuns.$inferSelect
export type NewCronRun = typeof cronRuns.$inferInsert
