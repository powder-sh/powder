import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { appRepos } from './app-repos'

// Where notifications go (lib/notifications.ts, migration 0052). kind 'webhook'
// keeps its URL encrypted (urlEncrypted, lib/crypto.ts); kind 'email' keeps a
// plain address. events = subscribed event names; appRepoId NULL = all apps.
// The env webhook POWDER_NOTIFY_WEBHOOK_URL is an implicit extra target and has
// no row here.
export const notificationTargets = pgTable('notification_targets', {
	id: text('id').primaryKey(),
	kind: text('kind').notNull(),
	urlEncrypted: text('url_encrypted'),
	email: text('email'),
	events: text('events').array().notNull().default([]),
	appRepoId: text('app_repo_id').references(() => appRepos.id, { onDelete: 'cascade' }),
	enabled: boolean('enabled').notNull().default(true),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type NotificationTarget = typeof notificationTargets.$inferSelect
export type NewNotificationTarget = typeof notificationTargets.$inferInsert
