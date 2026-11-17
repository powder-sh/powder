import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// One row per (parent app, branch) preview environment. Created on first push
// to a non-default branch on an app on a Traefik server; redeployed on
// subsequent pushes; torn down via the UI.
export const previewDeploys = pgTable(
	'preview_deploys',
	{
		id: text('id').primaryKey(),
		appRepoId: text('app_repo_id').notNull(),
		branch: text('branch').notNull(),
		branchSlug: text('branch_slug').notNull(),
		containerName: text('container_name').notNull(), // <parent>-<branchSlug>
		workingDir: text('working_dir').notNull(),
		url: text('url'),
		status: text('status').notNull().default('pending'), // pending | running | failed | torn-down
		lastDeployedAt: timestamp('last_deployed_at', { withTimezone: true }),
		lastError: text('last_error'),
		// Commit of the last successful deploy of this preview (webhook replay guard).
		lastSha: text('last_sha'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		uniq: uniqueIndex('preview_deploys_app_branch_unique').on(t.appRepoId, t.branchSlug),
	}),
)

export type PreviewDeploy = typeof previewDeploys.$inferSelect
export type NewPreviewDeploy = typeof previewDeploys.$inferInsert
