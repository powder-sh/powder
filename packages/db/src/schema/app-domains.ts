import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// Custom domains attached to an app (in addition to the
// app's default host, <name>.<server base_domain>). One row per (app, hostname).
//
// Lifecycle (CNAME path):
//   1. user pastes "widget.com" → row inserted with status='pending'
//   2. UI shows DNS record to add (CNAME or A)
//   3. user clicks "verify" → resolveCname/resolve4 hits dns; if it points
//      at our cluster, status='live' AND we update the app's compose file
//      with `|| Host(\`widget.com\`)` and recreate
//   4. on first https hit, Traefik auto-issues a cert via HTTP-01
//
// Lifecycle (TXT-challenge path, mono migration):
//   1. user adds domain via /projects/[id]/domains → status='pending',
//      verifyChallenge is a random 32-char token
//   2. user adds a `_powder.<hostname>` TXT record with the challenge
//   3. POST .../verify → resolveTxt; on match status='verified', else
//      status='verify_failed' with statusError
//   4. POST .../apply → only when verified; injects Traefik labels into
//      the app's compose file, recreates the container; status='live'.
//      On failure status='apply_failed' with statusError.
export const appDomains = pgTable(
	'app_domains',
	{
		id: text('id').primaryKey(),
		appRepoId: text('app_repo_id').notNull(),
		// When set, the domain is attached to a specific preview deploy (per-branch
		// container) instead of the parent app. NULL = parent-app domain.
		previewDeployId: text('preview_deploy_id'),
		hostname: text('hostname').notNull(),
		// pending | live | failed (CNAME path)
		// pending | verified | verify_failed | live | apply_failed (TXT-challenge path)
		status: text('status').notNull().default('pending'),
		statusError: text('status_error'),
		verifiedAt: timestamp('verified_at', { withTimezone: true }),
		// Random 32-char token published by the user as a TXT record at
		// `_powder.<hostname>` to prove ownership. Set on insert by addDomain().
		verifyChallenge: text('verify_challenge'),
		// Set when applyDomain() successfully writes Traefik labels and the
		// container recreate exits 0. Null until then.
		appliedAt: timestamp('applied_at', { withTimezone: true }),
		// Last apply error (cleared on next successful apply).
		appliedError: text('applied_error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		uniq: uniqueIndex('app_domains_unique').on(t.appRepoId, t.hostname),
		// A hostname belongs to exactly one app (hand-applied, 0038).
		hostnameGlobal: uniqueIndex('app_domains_hostname_global').on(sql`lower(${t.hostname})`),
	}),
)

export type AppDomain = typeof appDomains.$inferSelect
export type NewAppDomain = typeof appDomains.$inferInsert
