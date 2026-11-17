import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth'

// Long-lived bearer tokens for MCP / CLI access. Issued per user, hashed at rest.
// Usage: client sends `Authorization: Bearer <token>` to powder API.
// `getCurrentUser` looks up by hash, resolves to the owning user.
export const userApiTokens = pgTable('user_api_tokens', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	prefix: text('prefix').notNull(),
	hash: text('hash').notNull(),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	// NULL = full access. Otherwise "METHOD /path/pattern" entries the
	// token is restricted to (apps/web/src/lib/token-scopes.ts). Migration 0036.
	scopes: text('scopes').array(),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
})
