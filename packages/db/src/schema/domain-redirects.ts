import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// One row per (server, container, hostname) — describes how Powder should
// massage requests for that hostname before they reach the app.
export const domainRedirects = pgTable(
	'domain_redirects',
	{
		id: text('id').primaryKey(),
		ownerUserId: text('owner_user_id').notNull(),
		serverId: text('server_id').notNull(),
		containerName: text('container_name').notNull(),
		hostname: text('hostname').notNull(), // e.g. old-name.example.com
		// 'none'   — no www-related rewrite
		// 'apex'   — www.<host> → <host> (recommended default)
		// 'www'    — <host> → www.<host>
		wwwMode: text('www_mode').notNull().default('none'),
		// JSON array of { from: string, to: string, status: 301|302 }
		// from/to are paths starting with '/'. Match is exact for v1.
		customRedirectsJson: text('custom_redirects_json').notNull().default('[]'),
		appliedAt: timestamp('applied_at', { withTimezone: true }),
		appliedError: text('applied_error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		uniq: uniqueIndex('domain_redirects_unique').on(
			t.serverId,
			t.containerName,
			t.hostname,
		),
	}),
)

export type DomainRedirect = typeof domainRedirects.$inferSelect
export type NewDomainRedirect = typeof domainRedirects.$inferInsert
