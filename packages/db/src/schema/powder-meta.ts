import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Small key/value table for instance-level facts (e.g. the cached update check).
export const powderMeta = pgTable('powder_meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PowderMeta = typeof powderMeta.$inferSelect
