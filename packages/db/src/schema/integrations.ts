import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const userIntegrations = pgTable(
	'user_integrations',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		provider: text('provider').notNull(),
		username: text('username'),
		accessTokenEncrypted: text('access_token_encrypted').notNull(),
		scopes: text('scopes'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		userProviderUnique: uniqueIndex('user_integrations_user_provider_unique').on(
			t.userId,
			t.provider,
		),
	}),
)

export type UserIntegration = typeof userIntegrations.$inferSelect
export type NewUserIntegration = typeof userIntegrations.$inferInsert
