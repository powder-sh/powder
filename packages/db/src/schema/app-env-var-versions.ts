import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { envScope } from './app-env-vars'

// Snapshot of every previous value for an env var. Powers one-click rollback
// after a bad rotation. We retain the last 5 versions per (project, key, scope)
// — anything older is reaped by the setForProject path so the table doesn't
// grow unbounded.
//
// Value is encrypted with the same key as appEnvVars (POWDER_ENCRYPTION_KEY,
// AES-GCM via lib/crypto). Rolling back decrypts the snapshot and writes it
// as the new current value (which itself takes a snapshot of the "wrong"
// current value, so you can roll back the rollback if needed).

export const appEnvVarVersions = pgTable(
	'app_env_var_versions',
	{
		id: text('id').primaryKey(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		appRepoId: text('app_repo_id').notNull(),
		key: text('key').notNull(),
		scope: envScope('scope').notNull(),
		valueEncrypted: text('value_encrypted').notNull(),
		valuePreview: text('value_preview').notNull().default(''),
		// Who set the value that this snapshot captures (i.e. who set the value
		// that was later replaced). For rollback UI: "you're about to restore
		// the value set by <user> on <date>."
		setByUserId: text('set_by_user_id'),
	},
	(t) => ({
		// Fetched by (project, key, scope) → list versions newest first.
		byKey: index('app_env_var_versions_key_idx').on(t.appRepoId, t.key, t.scope, t.createdAt),
	}),
)

export type AppEnvVarVersion = typeof appEnvVarVersions.$inferSelect
export type NewAppEnvVarVersion = typeof appEnvVarVersions.$inferInsert
