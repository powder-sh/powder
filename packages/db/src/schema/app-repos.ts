import { bigint, boolean, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const appRepos = pgTable(
	'app_repos',
	{
		id: text('id').primaryKey(),
		serverId: text('server_id').notNull(),
		containerName: text('container_name').notNull(),
		repoUrl: text('repo_url').notNull(),
		branch: text('branch').notNull().default('main'),
		webhookToken: text('webhook_token').notNull().unique(),
		webhookSecretEncrypted: text('webhook_secret_encrypted').notNull(),
		deployKeyPub: text('deploy_key_pub').notNull(),
		deployKeyPrivEncrypted: text('deploy_key_priv_encrypted').notNull(),
		hasPostgres: boolean('has_postgres').notNull().default(false),
		hasKv: boolean('has_kv').notNull().default(false),
		ownerUserId: text('owner_user_id'),
		cronTokenEncrypted: text('cron_token_encrypted'),
		mcpTokenEncrypted: text('mcp_token_encrypted'),
		mcpManifestJson: text('mcp_manifest_json'),
		mcpManifestReadAt: timestamp('mcp_manifest_read_at', { withTimezone: true }),
		// Backup-time overrides. Default convention is `<containerName>-db` /
		// app / app — newly-created powder apps fit this. Existing apps using a
		// shared postgres (e.g. `<project>-postgres-1` hosting many DBs for one
		// stack) set these to point at the right container + db.
		//
		// `backupDbHost` is the escape hatch for postgres running on the host OS
		// (not in a docker container we can `docker exec` into). When set, the
		// backup script `docker run --network host`s a throwaway pg_dump
		// container that connects to <host>:<port>. Format: "host:port" or just
		// "host" (defaults to 5432). `backupDbPasswordEncrypted` is required for
		// host-mode (host postgres usually requires password auth over TCP).
		backupDbContainer: text('backup_db_container'),
		backupDbHost: text('backup_db_host'),
		backupDbName: text('backup_db_name'),
		backupDbUser: text('backup_db_user'),
		backupDbPasswordEncrypted: text('backup_db_password_encrypted'),
		// Mono-repo support. When deploymentGroupId is set, this row is a sub-app
		// sharing webhookToken + deploy key with sibling sub-apps via the named
		// repo_deployment_groups row. pathsFilter (text[]) gates whether a push
		// triggers this sub-app's deploy. dockerfilePath + preDeployCommand let
		// each sub-app build/run differently from the same source tree.
		// Single-app rows have deploymentGroupId NULL and dockerfilePath defaulted.
		deploymentGroupId: text('deployment_group_id'),
		dockerfilePath: text('dockerfile_path').notNull().default('./Dockerfile'),
		// 0065: the port the app listens on in its container, as given at create
		// (/new). Previews route to it. NULL on apps created before 0065: previews
		// then read the port from the parent's compose / Traefik label.
		containerPort: integer('container_port'),
		pathsFilter: text('paths_filter').array(),
		preDeployCommand: text('pre_deploy_command'),
		// Uptime checker — see apps/web/src/lib/uptime.ts. When uptimeEnabled is
		// true, the 5-min tick pings the app and emails owners on UP→DOWN.
		// healthUrl is the explicit URL to ping; when NULL the checker resolves
		// it from app_domains (status='live') or falls back to the server base-domain
		// hostname. Default off so adding apps doesn't auto-page on the first
		// failed ping; flip via /projects/[id]/settings (or directly in SQL).
		healthUrl: text('health_url'),
		uptimeEnabled: boolean('uptime_enabled').notNull().default(false),
		// Unused: nothing reads or writes it (alerts do not go to it). Kept so the
		// column is not dropped while older builds may still select it.
		notifyEmail: text('notify_email'),
		// Deploy-mode contract. 'auto' infers the mode from the compose
		// file at deploy time: build: key present → build-on-server, else
		// registry pull. 'build' / 'registry' DECLARE the mode, and the deploy
		// preflight fails loudly when the compose file disagrees — instead of
		// silently taking the other path. (A compose
		// hand-edit that breaks parsing makes HAS_BUILD read empty output as "no",
		// and every deploy then falls back to a registry pull that can never work.)
		buildMode: text('build_mode').notNull().default('auto'),
		// Pre-swap candidate probe (deploy step "swap-check"): start the new image
		// as `<name>-next`, probe it, and only then recreate the live container.
		// false opts this app out; POWDER_SWAP_CHECK=off disables it for every app.
		swapCheck: boolean('swap_check').notNull().default(true),
		// Automatic rollback (0061): an ops hub may roll this app back when a deploy makes it
		// clearly worse (GET /api/internal/auto-rollback is the preflight). false opts it out.
		autoRollback: boolean('auto_rollback').notNull().default(true),
		// Settle window for push deploys (0063, apps/web/src/lib/deploy-settle.ts), in
		// seconds: NULL = the global powder_meta value, 0 = off for this app. Set with SQL.
		deploySettleSeconds: integer('deploy_settle_seconds'),
		// Branch previews are opt-in per app (0047). Set with SQL.
		previewsEnabled: boolean('previews_enabled').notNull().default(false),
		// Commit DEPLOYMENT.md into the app's repo after each successful deploy
		// (lib/sync-deployment-md.ts). Opt-in per app (0051), toggled on the
		// project settings tab.
		syncDeploymentMd: boolean('sync_deployment_md').notNull().default(false),
		// GitHub ids (0055). Deploy key + push webhook powder
		// installed at connect, deleted on GitHub at disconnect; repository.id the
		// push webhook must keep naming. NULL for rows connected before 0055.
		githubDeployKeyId: bigint('github_deploy_key_id', { mode: 'number' }),
		githubHookId: bigint('github_hook_id', { mode: 'number' }),
		githubRepoId: bigint('github_repo_id', { mode: 'number' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		appUnique: uniqueIndex('app_repos_app_unique').on(t.serverId, t.containerName),
	}),
)

export type AppRepo = typeof appRepos.$inferSelect
export type NewAppRepo = typeof appRepos.$inferInsert
