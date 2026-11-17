import { index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { envScope } from './app-env-vars'

// Append-only audit trail for every env var write. Never stores values — only
// 4-char previews of before/after, plus who/when/from. Two questions this
// table is designed to answer in five seconds:
//   1. "What changed in the last hour and who did it?"
//   2. "Which session clobbered DATABASE_URL yesterday?"
//
// Indexed by (app_repo_id, created_at) for the project-scoped read; (actor)
// for the auditor read.

export const auditAction = pgEnum('env_audit_action', ['create', 'update', 'delete', 'rollback'])
export const auditActorKind = pgEnum('env_audit_actor_kind', [
	'human_session',
	'api_token',
	'system',
])

export const appEnvVarAudit = pgTable(
	'app_env_var_audit',
	{
		id: text('id').primaryKey(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		appRepoId: text('app_repo_id').notNull(),
		actorUserId: text('actor_user_id'),
		actorKind: auditActorKind('actor_kind').notNull().default('human_session'),
		actorIp: text('actor_ip'),
		actorUserAgent: text('actor_user_agent'),
		action: auditAction('action').notNull(),
		key: text('key').notNull(),
		scope: envScope('scope').notNull(),
		// 4-char previews of the before/after values — same format as
		// appEnvVars.valuePreview. NEVER stores plaintext.
		oldValuePreview: text('old_value_preview'),
		newValuePreview: text('new_value_preview'),
	},
	(t) => ({
		byProject: index('app_env_var_audit_project_idx').on(t.appRepoId, t.createdAt),
		byActor: index('app_env_var_audit_actor_idx').on(t.actorUserId, t.createdAt),
	}),
)

export type AppEnvVarAudit = typeof appEnvVarAudit.$inferSelect
export type NewAppEnvVarAudit = typeof appEnvVarAudit.$inferInsert
