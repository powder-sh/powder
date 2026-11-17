import { bigint, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// A "deployment group" is a shared (repo_url, branch) that backs N sub-apps.
// Holds the webhook token + deploy key everyone in the group shares. The
// webhook handler looks up by token here first; if found, it fans out to
// every app_repos row where deployment_group_id = this.id, applying each
// sub-app's paths_filter to decide whether to fire its deploy.
//
// Single-app behavior (no group) is unchanged: app_repos with NULL
// deployment_group_id keeps its own per-app webhook token + deploy key.

export const repoDeploymentGroups = pgTable(
	'repo_deployment_groups',
	{
		id: text('id').primaryKey(),
		repoUrl: text('repo_url').notNull(),
		branch: text('branch').notNull(),
		webhookToken: text('webhook_token').notNull().unique(),
		webhookSecretEncrypted: text('webhook_secret_encrypted').notNull(),
		deployKeyPub: text('deploy_key_pub').notNull(),
		deployKeyPrivEncrypted: text('deploy_key_priv_encrypted').notNull(),
		ownerUserId: text('owner_user_id'),
		// GitHub's numeric repository.id (0056). A signed push naming another id is
		// refused, like app_repos.github_repo_id. NULL = stored from the first verified push.
		githubRepoId: bigint('github_repo_id', { mode: 'number' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		repoBranchUnique: uniqueIndex('repo_deployment_groups_repo_branch_unique').on(
			t.repoUrl,
			t.branch,
		),
	}),
)

export type RepoDeploymentGroup = typeof repoDeploymentGroups.$inferSelect
export type NewRepoDeploymentGroup = typeof repoDeploymentGroups.$inferInsert
