import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// Vercel-style env vars. Source of truth for every variable a project uses.
//
// Two big differences from editing the env file on the server (DB mode off):
//   1. Values live encrypted in postgres (AES-256-GCM with POWDER_ENCRYPTION_KEY),
//      not in /opt/apps/<name>.env on the server. The file on the server becomes
//      a derived artifact, rendered fresh at deploy time.
//   2. After save, the API never returns the plaintext value — only key, scope,
//      and a 4-char preview. Rotate via overwrite; if you forgot what it was,
//      it's gone.
//
// Gated behind POWDER_ENV_VARS_DB_MODE so we can roll it out per server / per
// project without breaking the existing flow.

export const envScope = pgEnum('env_scope', ['production', 'preview', 'development'])

export const appEnvVars = pgTable(
	'app_env_vars',
	{
		id: text('id').primaryKey(),
		appRepoId: text('app_repo_id').notNull(),
		key: text('key').notNull(),
		scope: envScope('scope').notNull().default('production'),
		// AES-GCM ciphertext via lib/crypto.ts. Never returned over the wire.
		valueEncrypted: text('value_encrypted').notNull(),
		// First 4 chars of the value, used in the dashboard so the user can tell
		// keys apart at a glance (e.g. "ghp_" vs "sk_l"). Not enough to reconstruct.
		// Skipped (empty string) for values shorter than 8 chars to avoid leaking
		// the whole secret.
		valuePreview: text('value_preview').notNull().default(''),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		lastRotatedAt: timestamp('last_rotated_at', { withTimezone: true }),
		createdByUserId: text('created_by_user_id'),
	},
	(t) => ({
		// One row per (project, key, scope). Set-on-existing becomes an UPSERT
		// keyed by this index.
		uniqByKey: uniqueIndex('app_env_vars_repo_key_scope_uniq').on(t.appRepoId, t.key, t.scope),
		// "Render this project's production env" — main read path during deploy.
		byProject: index('app_env_vars_project_idx').on(t.appRepoId, t.scope),
	}),
)

export type AppEnvVar = typeof appEnvVars.$inferSelect
export type NewAppEnvVar = typeof appEnvVars.$inferInsert
