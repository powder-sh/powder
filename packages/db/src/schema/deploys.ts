import { sql } from 'drizzle-orm'
import { integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const deployKind = pgEnum('deploy_kind', [
	'env_change',
	'image_update',
	'manual_apply',
	'restart',
	'git_deploy',
	'rollback',
	// 0059: the dashboard's app stop and delete (apps/web/src/lib/app-lifecycle.ts)
	'stop',
	'delete',
])

// 'queued' = inserted by a web trigger route, not yet claimed by the deploy
// worker. The worker flips it to 'running' when it claims (FOR UPDATE SKIP
// LOCKED). When POWDER_DEPLOY_WORKER is off, rows go straight to 'running'
// (in-web mode: the web process runs them), so 'queued' is never used.
/** The test gate's result as the deploy recorded it (deploys.test_gate, 0066), from the
 *  deploy script's nonced mark, never from a log search: 'passed' = .powder/test.sh ran and
 *  exited 0, 'failed' = the deploy failed at the test gate, 'none' = no .powder/test.sh.
 *  NULL = not recorded (the deploy died before the gate, or a row from before 0066). */
export const TEST_GATE_VALUES = ['passed', 'failed', 'none'] as const
export type TestGate = (typeof TEST_GATE_VALUES)[number]

export const deployStatus = pgEnum('deploy_status', ['queued', 'running', 'success', 'failed'])

export const deploys = pgTable(
	'deploys',
	{
		id: text('id').primaryKey(),
		serverId: text('server_id').notNull(),
		containerName: text('container_name').notNull(),
		kind: deployKind('kind').notNull(),
		status: deployStatus('status').notNull().default('running'),
		// Insert time (0050). Never overwritten; startedAt is reset on claim, so
		// startedAt - queuedAt is the queue wait.
		queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		output: text('output'),
		error: text('error'),
		// Structured failure fields. The full log still lives in `error`/`output`;
		// these let the dashboard show *why* a deploy failed without parsing the
		// blob. Populated on the failed path only (null on success).
		//   failedStep   - the `── <phase> ──` banner the remote script was in
		//                   when it died (from the __POWDER_FAIL__ trap marker)
		//   exitCode     - that phase's shell exit code
		//   errorSummary - one-line human cause (e.g. "container name in use")
		failedStep: text('failed_step'),
		exitCode: integer('exit_code'),
		errorSummary: text('error_summary'),
		triggeredBy: text('triggered_by'),
		// The commit this deploy put into production: set after the swap only, so a failure
		// before the swap leaves it NULL (rollback targets and last-good lookups rely on that).
		gitSha: text('git_sha'),
		gitBranch: text('git_branch'),
		// The commit this deploy synced or built, live or not (0070): written when the deploy
		// ends, on success and failure. NULL = unknown. Displays read it through
		// apps/web/src/lib/deploy-commit.ts, never on its own.
		builtSha: text('built_sha'),
		imageTag: text('image_tag'),
		// sha256 of the resolved compose config this deploy ran with (0056). Set on
		// success only; the next deploy enforces the high-severity compose rules
		// when the config it probes has a different hash (or none is stored).
		composeConfigHash: text('compose_config_hash'),
		// what that structure looked like (0062), with secret-bearing values reduced to
		// key names and short hashes (apps/web/src/lib/deploy/compose-diff.ts). Set with
		// compose_config_hash; the next deploy's guard prints what differs from it.
		composeConfigView: jsonb('compose_config_view'),
		rolledBackFromId: text('rolled_back_from_id'),
		// Per-deploy historical snapshot URL. Spawned on demand when the user
		// clicks "preview" on a past deploy; auto-torn-down after expiry.
		snapshotContainer: text('snapshot_container'),
		snapshotUrl: text('snapshot_url'),
		snapshotExpiresAt: timestamp('snapshot_expires_at', { withTimezone: true }),
		// GitHub Deployments API: the id we get back from POST /deployments
		// at deploy start. Used to PATCH terminal status (success/failure)
		// when the deploy ends. Null if owner has no GH integration or the
		// API call failed (we never block deploys on GH calls).
		githubDeploymentId: text('github_deployment_id'),
		// The commit this deploy must build (0035). Set from the push payload by
		// the webhook; NULL = the configured branch's HEAD at build time.
		requestedSha: text('requested_sha'),
		// Executor liveness (0035): stamped every 30s by the process running the
		// deploy. The watchdog reaps on a stale stamp, not on elapsed time.
		heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
		// Settle window (0063, apps/web/src/lib/deploy-settle.ts): a queued webhook push
		// is not claimed before this time. NULL = claim at once. Status stays 'queued'.
		notBefore: timestamp('not_before', { withTimezone: true }),
		// The test gate's result (0066, TestGate above). Written by finishDeploy on success
		// and failure alike; NULL = not recorded.
		testGate: text('test_gate').$type<TestGate>(),
	},
	(t) => ({
		// The cross-process deploy lock (0035): at most one RUNNING and at most
		// one QUEUED row per app. A second one is turned away without a 23505
		// (insert ON CONFLICT DO NOTHING, updates guarded by NOT EXISTS; postgres
		// logs every unique violation as an ERROR) and the webhook + UI handlers
		// translate that into "already in flight". A
		// push that lands mid-deploy becomes the single queued row (a durable
		// catch-up) instead of being dropped. `deploy-watchdog` reaps stuck rows.
		runningUnique: uniqueIndex('deploys_running_unique')
			.on(t.serverId, t.containerName)
			.where(sql`${t.status} = 'running'`),
		queuedUnique: uniqueIndex('deploys_queued_unique')
			.on(t.serverId, t.containerName)
			.where(sql`${t.status} = 'queued'`),
	}),
)

export type Deploy = typeof deploys.$inferSelect
export type NewDeploy = typeof deploys.$inferInsert
