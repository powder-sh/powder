import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Pinned SSH host keys, trust-on-first-use (0035). Keyed by the host string
// powder dials (IP or hostname), so builder hosts are covered too. A mismatch
// is refused; a legitimately rebuilt server needs its row deleted.
export const sshHostKeys = pgTable('ssh_host_keys', {
	host: text('host').primaryKey(),
	keyType: text('key_type').notNull(),
	sha256: text('sha256').notNull(),
	firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SshHostKey = typeof sshHostKeys.$inferSelect
