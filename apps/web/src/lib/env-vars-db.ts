// DB-backed env var storage. Vercel-style: dashboard is the only write path,
// the file on the server is a derived artifact rendered at deploy time.
//
// The contract:
//   - listForProject() returns key + scope + valuePreview ONLY. Never plaintext.
//   - setForProject() takes plaintext, encrypts before insert. Upsert on
//     (app_repo_id, key, scope).
//   - renderEnvFile() decrypts the requested scope and returns KEY=value lines.
//     Used at deploy time; nowhere else.
//   - All decrypt paths go through this module so an audit can grep one place.
//
// Feature flag: POWDER_ENV_VARS_DB_MODE. When false (default), the deploy
// renderer is a no-op and the env file on the server is edited directly.

import { safeStoredPreview } from './secret-text'
import { shq } from './shell'
import { createHash } from 'node:crypto'
import { decryptSecret, encryptSecret } from './crypto'
import { encodeEnvValue, parseRawEnv, RENDER_NOISE_KEYS } from './env-parse'
import {
	ENV_TARGET_CUTOFF_KEY,
	ENV_TARGET_META_PREFIX,
	type EnvTargetCtx,
	envRenderTargetRefusal,
	envTargetHardRefusal,
	envTargetInAppDir,
	envTargetMetaKey,
	pinSql,
	renderRecordDeployIds,
} from './env-target'
import { hqConfigured } from './hq'
import {
	and,
	appEnvVarAudit,
	appEnvVarVersions,
	appEnvVars,
	appRepos,
	createId,
	db,
	deploys,
	desc,
	eq,
	inArray,
	powderMeta,
	prefixes,
	sql,
} from './db'
import type { AppEnvVar, AppEnvVarAudit, AppEnvVarVersion } from './db'
import { dashboardUrl } from './hosts'
import { EnvKeyDeniedError, envKeyDeleteDenied, envKeyWriteDenied, type EnvRefusalCaller, isAdminSession } from './env-key-policy'

export type EnvScope = 'production' | 'preview' | 'development'

// Number of prior values we keep per (project, key, scope). Older snapshots are
// reaped on every write so the table never grows unbounded.
const VERSION_HISTORY_LIMIT = 5

// Audit context — every write path takes this. The userId is the human who
// performed the action; actorKind is currently always 'human_session' but
// becomes meaningful once we add split-auth API tokens.
export interface AuditContext {
	userId: string | null
	actorKind?: 'human_session' | 'api_token' | 'system'
	ip?: string | null
	userAgent?: string | null
	// true only for an admin's browser session (never a token).
	// Without it setForProject refuses runtime-loader keys (lib/env-key-policy.ts).
	adminSession?: boolean
}

// Refusal wording (lib/env-key-policy.ts): a human session only when the
// context says so; a token or system caller keeps the token wording.
function refusalCaller(ctx: AuditContext): EnvRefusalCaller {
	return ctx.actorKind === 'human_session' ? 'session' : 'token'
}

// Helper to pull request context for audit logs from a Next.js Request. Used
// from the API routes so each call captures the IP + UA without manual fiddling.
export function auditCtxFromRequest(
	req: Request,
	userId: string | null,
	actorKind: AuditContext['actorKind'] = 'human_session',
): AuditContext {
	return {
		userId,
		actorKind,
		ip:
			req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
			req.headers.get('x-real-ip') ??
			null,
		userAgent: req.headers.get('user-agent'),
	}
}

// The audit context every env WRITE route builds from its authenticated user:
// actor kind from the token flag, and adminSession for the loader-key policy.
export function envWriteCtx(
	req: Request,
	user: { id: string; isAdmin: boolean; viaToken?: boolean },
): AuditContext {
	return {
		...auditCtxFromRequest(req, user.id, user.viaToken ? 'api_token' : 'human_session'),
		adminSession: isAdminSession(user),
	}
}

export interface EnvVarSummary {
	id: string
	key: string
	scope: EnvScope
	valuePreview: string
	createdAt: string
	updatedAt: string
	lastRotatedAt: string | null
}

export function isEnvDbModeEnabled(): boolean {
	const v = (process.env.POWDER_ENV_VARS_DB_MODE ?? '').toLowerCase()
	return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

// Public read path for the dashboard. Returns no plaintext.
export async function listForProject(appRepoId: string): Promise<EnvVarSummary[]> {
	const rows = await db.select().from(appEnvVars).where(eq(appEnvVars.appRepoId, appRepoId))
	return rows
		.map(toSummary)
		.sort((a, b) => a.key.localeCompare(b.key) || a.scope.localeCompare(b.scope))
}

function toSummary(row: AppEnvVar): EnvVarSummary {
	return {
		id: row.id,
		key: row.key,
		scope: row.scope as EnvScope,
		valuePreview: safeStoredPreview(row.valuePreview) ?? '',
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastRotatedAt: row.lastRotatedAt ? row.lastRotatedAt.toISOString() : null,
	}
}

// Set or rotate a value. Idempotent: same (project, key, scope) overwrites.
// Validates the key, snapshots the previous value (if any) into the versions
// table for rollback, writes an audit entry, then upserts the new value.
// Reaps version history beyond VERSION_HISTORY_LIMIT.
//
// One transaction, serialized per (project, key, scope): two concurrent sets
// could otherwise read the same prior row, so one writer's value would never reach
// the version history and both audit rows would name the same old value (or both
// say 'create'). pg_advisory_xact_lock covers the not-yet-existing row too (a
// SELECT ... FOR UPDATE on a missing row locks nothing); FOR UPDATE then pins
// the prior row itself. Both locks end with the transaction.
export async function setForProject(
	appRepoId: string,
	key: string,
	value: string,
	scope: EnvScope,
	ctx: AuditContext,
): Promise<EnvVarSummary> {
	validateKey(key)
	const denied = envKeyWriteDenied(key, value, ctx.adminSession === true, refusalCaller(ctx))
	if (denied) throw new EnvKeyDeniedError(denied)
	const valueEncrypted = encryptSecret(value)
	const valuePreview = makePreview(value)

	const row = await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`env:${appRepoId}:${scope}:${key}`}, 0))`,
		)
		const now = new Date()
		const [prior] = await tx
			.select()
			.from(appEnvVars)
			.where(
				and(
					eq(appEnvVars.appRepoId, appRepoId),
					eq(appEnvVars.key, key),
					eq(appEnvVars.scope, scope),
				),
			)
			.limit(1)
			.for('update')

		if (prior) {
			await tx.insert(appEnvVarVersions).values({
				id: `${createId(prefixes.envVar)}_v`,
				appRepoId: prior.appRepoId,
				key: prior.key,
				scope: prior.scope,
				valueEncrypted: prior.valueEncrypted,
				valuePreview: prior.valuePreview,
				setByUserId: prior.createdByUserId,
			})
			await tx.execute(sql`
				DELETE FROM app_env_var_versions
				WHERE id IN (
					SELECT id FROM app_env_var_versions
					WHERE app_repo_id = ${appRepoId}
					  AND key = ${key}
					  AND scope = ${scope}
					ORDER BY created_at DESC
					OFFSET ${VERSION_HISTORY_LIMIT}
				)
			`)
		}

		const id = createId(prefixes.envVar)
		const [upserted] = await tx
			.insert(appEnvVars)
			.values({
				id,
				appRepoId,
				key,
				scope,
				valueEncrypted,
				valuePreview,
				createdByUserId: ctx.userId,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [appEnvVars.appRepoId, appEnvVars.key, appEnvVars.scope],
				set: {
					valueEncrypted,
					valuePreview,
					updatedAt: now,
					lastRotatedAt: now,
				},
			})
			.returning()

		await tx.insert(appEnvVarAudit).values({
			id: `${createId(prefixes.envVar)}_a`,
			appRepoId,
			key,
			scope,
			action: prior ? 'update' : 'create',
			actorUserId: ctx.userId,
			actorKind: ctx.actorKind ?? 'human_session',
			actorIp: ctx.ip ?? null,
			actorUserAgent: ctx.userAgent ?? null,
			oldValuePreview: prior?.valuePreview ?? null,
			newValuePreview: valuePreview,
		})
		return upserted
	})

	if (!row) throw new Error('env var upsert returned no row')
	return toSummary(row)
}

export async function deleteForProject(
	appRepoId: string,
	key: string,
	scope: EnvScope,
	ctx: AuditContext,
): Promise<{ deleted: boolean }> {
	// a token deletes only the keys it may write (the same rule).
	const denied = envKeyDeleteDenied(key, ctx.adminSession === true, refusalCaller(ctx))
	if (denied) throw new EnvKeyDeniedError(denied)
	// Snapshot before delete so the value isn't lost if the delete was a mistake.
	const [prior] = await db
		.select()
		.from(appEnvVars)
		.where(
			and(
				eq(appEnvVars.appRepoId, appRepoId),
				eq(appEnvVars.key, key),
				eq(appEnvVars.scope, scope),
			),
		)
		.limit(1)
	if (prior) {
		await snapshotVersion(prior)
		await reapOldVersions(appRepoId, key, scope)
	}

	const result = await db
		.delete(appEnvVars)
		.where(
			and(
				eq(appEnvVars.appRepoId, appRepoId),
				eq(appEnvVars.key, key),
				eq(appEnvVars.scope, scope),
			),
		)
		.returning({ id: appEnvVars.id })

	if (result.length > 0) {
		await recordAudit({
			appRepoId,
			key,
			scope,
			action: 'delete',
			oldValuePreview: prior?.valuePreview ?? null,
			newValuePreview: null,
			ctx,
		})
	}
	return { deleted: result.length > 0 }
}

// Restore a previous value from the versions table. Takes a snapshot of the
// current value first (so you can roll back the rollback if needed) and
// records a 'rollback' audit entry.
export async function rollbackToVersion(
	appRepoId: string,
	versionId: string,
	ctx: AuditContext,
	/** the key named in the URL; a version of another key is refused. */
	expectedKey?: string,
): Promise<EnvVarSummary> {
	const [version] = await db
		.select()
		.from(appEnvVarVersions)
		.where(and(eq(appEnvVarVersions.id, versionId), eq(appEnvVarVersions.appRepoId, appRepoId)))
		.limit(1)
	if (!version) throw new Error('version not found or not in this project')
	if (expectedKey !== undefined && version.key !== expectedKey)
		throw new Error('version not found for this key')

	const plaintext = decryptSecret(version.valueEncrypted)
	// setForProject snapshots the current value, then writes the rolled-back
	// value. We record a 'rollback' audit ourselves AFTER so the timeline is
	// "current → rollback → new value" rather than "current → update".
	const result = await setForProject(
		appRepoId,
		version.key,
		plaintext,
		version.scope as EnvScope,
		ctx,
	)

	// Replace the trailing 'update' audit row with a 'rollback' entry so the
	// /env/audit feed clearly shows this was a restore, not a new rotation.
	// Cheapest: insert a separate rollback audit row pointing at the restored
	// version's createdAt for traceability.
	await recordAudit({
		appRepoId,
		key: version.key,
		scope: version.scope as EnvScope,
		action: 'rollback',
		oldValuePreview: null,
		newValuePreview: version.valuePreview,
		ctx,
	})
	return result
}

// Newest-first list of historical values for one var. Used by the UI's
// "history" expansion. Returns previews only — restoring requires hitting
// rollbackToVersion which decrypts server-side.
export async function listVersions(
	appRepoId: string,
	key: string,
	scope: EnvScope,
): Promise<VersionSummary[]> {
	const rows = await db
		.select()
		.from(appEnvVarVersions)
		.where(
			and(
				eq(appEnvVarVersions.appRepoId, appRepoId),
				eq(appEnvVarVersions.key, key),
				eq(appEnvVarVersions.scope, scope),
			),
		)
		.orderBy(desc(appEnvVarVersions.createdAt))
		.limit(VERSION_HISTORY_LIMIT)
	return rows.map(toVersionSummary)
}

export interface VersionSummary {
	id: string
	createdAt: string
	valuePreview: string
	setByUserId: string | null
}

function toVersionSummary(row: AppEnvVarVersion): VersionSummary {
	return {
		id: row.id,
		createdAt: row.createdAt.toISOString(),
		valuePreview: safeStoredPreview(row.valuePreview) ?? '',
		setByUserId: row.setByUserId,
	}
}

// Recent audit entries for the project (across all keys/scopes). Powers the
// "Recent activity" panel on the env tab. Bounded so a noisy project doesn't
// blow the response size.
export async function listAuditForProject(appRepoId: string, limit = 50): Promise<AuditSummary[]> {
	const rows = await db
		.select()
		.from(appEnvVarAudit)
		.where(eq(appEnvVarAudit.appRepoId, appRepoId))
		.orderBy(desc(appEnvVarAudit.createdAt))
		.limit(Math.max(1, Math.min(500, limit)))
	return rows.map(toAuditSummary)
}

export interface AuditSummary {
	id: string
	createdAt: string
	actorUserId: string | null
	actorKind: 'human_session' | 'api_token' | 'system'
	actorIp: string | null
	action: 'create' | 'update' | 'delete' | 'rollback'
	key: string
	scope: EnvScope
	oldValuePreview: string | null
	newValuePreview: string | null
}

function toAuditSummary(row: AppEnvVarAudit): AuditSummary {
	return {
		id: row.id,
		createdAt: row.createdAt.toISOString(),
		actorUserId: row.actorUserId,
		actorKind: row.actorKind as AuditSummary['actorKind'],
		actorIp: row.actorIp,
		action: row.action as AuditSummary['action'],
		key: row.key,
		scope: row.scope as EnvScope,
		oldValuePreview: safeStoredPreview(row.oldValuePreview),
		newValuePreview: safeStoredPreview(row.newValuePreview),
	}
}

// ── internal write helpers ──────────────────────────────────────────────────

async function snapshotVersion(prior: AppEnvVar): Promise<void> {
	await db.insert(appEnvVarVersions).values({
		id: createId(prefixes.envVar) + '_v',
		appRepoId: prior.appRepoId,
		key: prior.key,
		scope: prior.scope,
		valueEncrypted: prior.valueEncrypted,
		valuePreview: prior.valuePreview,
		setByUserId: prior.createdByUserId,
	})
}

// Trim version history to the most recent VERSION_HISTORY_LIMIT per
// (project, key, scope). Cheap: a subquery picks the rows to keep, the outer
// delete removes everything else.
async function reapOldVersions(appRepoId: string, key: string, scope: EnvScope): Promise<void> {
	await db.execute(sql`
		DELETE FROM app_env_var_versions
		WHERE id IN (
			SELECT id FROM app_env_var_versions
			WHERE app_repo_id = ${appRepoId}
			  AND key = ${key}
			  AND scope = ${scope}
			ORDER BY created_at DESC
			OFFSET ${VERSION_HISTORY_LIMIT}
		)
	`)
}

async function recordAudit(opts: {
	appRepoId: string
	key: string
	scope: EnvScope
	action: 'create' | 'update' | 'delete' | 'rollback'
	oldValuePreview: string | null
	newValuePreview: string | null
	ctx: AuditContext
}): Promise<void> {
	await db.insert(appEnvVarAudit).values({
		id: createId(prefixes.envVar) + '_a',
		appRepoId: opts.appRepoId,
		key: opts.key,
		scope: opts.scope,
		action: opts.action,
		actorUserId: opts.ctx.userId,
		actorKind: opts.ctx.actorKind ?? 'human_session',
		actorIp: opts.ctx.ip ?? null,
		actorUserAgent: opts.ctx.userAgent ?? null,
		oldValuePreview: opts.oldValuePreview,
		newValuePreview: opts.newValuePreview,
	})
}

// Deploy-time renderer. Returns one KEY=value line per var of exactly the requested
// scope. No scope inherits another; a preview render never copies a
// production value (a preview runs any pushed branch, docs/SECURITY-COMPOSE.md
// "Previews"). Nothing renders the preview scope today (deploys pass 'production').
// Development isn't rendered server-side (a future CLI could pull it to a local .env).
//
// Prepends a "DO NOT EDIT" header so any agent / human poking at the file on
// disk gets immediate signal that direct edits are pointless (powder will
// re-render on the next deploy): a value edited on disk is replaced by the DB
// copy on the next deploy. The header includes the powder
// URL for the per-project env page so the reader has a one-click path to the
// canonical edit surface.
export async function renderEnvFile(appRepoId: string, scope: EnvScope): Promise<string> {
	const rows = await db.select().from(appEnvVars).where(eq(appEnvVars.appRepoId, appRepoId))

	const merged = new Map<string, string>()
	for (const r of rows) {
		if (r.scope === scope) merged.set(r.key, decryptSecret(r.valueEncrypted))
	}

	const header = [
		'# ============================================================',
		'# DO NOT EDIT THIS FILE',
		'# ============================================================',
		'# This file is generated by powder at deploy time.',
		`# Source of truth: ${dashboardUrl()}/projects/${appRepoId}/env`,
		'# Direct edits (sed, vim, echo >>) will be OVERWRITTEN on the next deploy.',
		`# Rendered at: ${new Date().toISOString()} (scope: ${scope})`,
		'# ============================================================',
		'',
	].join('\n')

	const out: string[] = []
	for (const [k, v] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		out.push(`${k}=${encodeEnvValue(v)}`)
	}
	return header + out.join('\n') + (out.length > 0 ? '\n' : '')
}

// Bulk import (used by the backfill route + UI "paste from .env" affordance).
// Skips lines that don't parse, returns counts so the caller can report.
export async function bulkImportFromText(
	appRepoId: string,
	text: string,
	scope: EnvScope,
	ctx: AuditContext,
	opts: { overwrite: boolean } = { overwrite: true },
): Promise<{ imported: number; skipped: number; existing: number; deniedKeys: string[] }> {
	let imported = 0
	let skipped = 0
	let existing = 0
	const deniedKeys: string[] = []

	// Same parser as every other env reader (unescapes \" \\ \$ \` and \n, drops
	// `export `, strips inline comments). Lines it cannot read as KEY=value
	// (no "=", bad key) are counted as skipped.
	const parsed = parseRawEnv(text)
	const candidates = text.split(/\r?\n/).filter((l) => {
		const t = l.trim()
		return t && !t.startsWith('#')
	}).length
	skipped += Math.max(0, candidates - parsed.length)
	for (const { key, value } of parsed) {
		if (!isValidKey(key)) {
			skipped++
			continue
		}

		if (!opts.overwrite) {
			const [pre] = await db
				.select({ id: appEnvVars.id })
				.from(appEnvVars)
				.where(
					and(
						eq(appEnvVars.appRepoId, appRepoId),
						eq(appEnvVars.key, key),
						eq(appEnvVars.scope, scope),
					),
				)
				.limit(1)
			if (pre) {
				existing++
				continue
			}
		}

		// a loader key this caller may not set is skipped and named,
		// not imported (the rest of the paste still lands).
		if (envKeyWriteDenied(key, value, ctx.adminSession === true)) {
			deniedKeys.push(key)
			skipped++
			continue
		}
		await setForProject(appRepoId, key, value, scope, ctx)
		imported++
	}
	return { imported, skipped, existing, deniedKeys }
}

// Deploy-time hook. Called from each deploy path BEFORE rebuildDeploy runs
// so the env file the build/runtime reads is fresh from the DB. No-op when
// POWDER_ENV_VARS_DB_MODE is off: deploys then read the env file on the server as it is.
//
// Resolves the target path via envFileCandidatesFor, same as the
// dashboard env-file write flow, so the file landing point is the one the compose
// config actually reads.
//
// Drift guard: before rendering DB → disk, diff the current disk file. If
// disk has keys with non-empty values that aren't in the DB (after filtering
// known runtime/observability noise), REFUSE the render and return a
// `refused` result with the conflict list. A value edited on disk is replaced
// by the DB copy on the next deploy, so a key that exists only on disk would be
// lost silently; this makes it a loud, surfaced failure instead. The deploy
// still proceeds with the EXISTING disk file (which still has the on-disk
// edit), and the conflict is logged so the dashboard can show it and the
// operator can sync the missing keys into the DB via the UI.
export interface PrepareEnvDiff {
	key: string
}

export type PrepareEnvResult =
	| { rendered: false; reason: 'db_mode_off' | 'no_vars' | 'no_candidate_path' }
	| { rendered: true; path: string; bytes: number }
	| { rendered: false; refused: true; path: string; conflicts: PrepareEnvDiff[] }
	/** the target is not a path powder may write (env-target.ts); nothing written. */
	| { rendered: false; unsafeTarget: true; path: string; message: string }

export async function prepareEnvFileForDeploy(
	server: import('./servers').ServerConfig,
	repo: { id: string; containerName: string },
	scope: EnvScope,
	/** beforeWrite runs right before the file is overwritten (never on a refused or skipped render). */
	hooks: { beforeWrite?: (path: string) => Promise<void> } = {},
): Promise<PrepareEnvResult> {
	if (!isEnvDbModeEnabled()) return { rendered: false, reason: 'db_mode_off' }

	// Skip if the project has no vars yet — don't blow away an existing file
	// with empty contents during the migration window.
	const count = await db
		.select({ id: appEnvVars.id })
		.from(appEnvVars)
		.where(eq(appEnvVars.appRepoId, repo.id))
		.limit(1)
	if (count.length === 0) return { rendered: false, reason: 'no_vars' }

	const { clearEnvRestoreMarker, envFileCandidatesFor, findEnvFile, readEnvRestoreMarker, writeEnvFile } =
		await import('./ssh')
	const candidates = await envFileCandidatesFor(server, repo.containerName)
	const path = candidates[0]
	if (!path) return { rendered: false, reason: 'no_candidate_path' }

	// Read what the DB wants the file to look like (the source-of-truth set
	// of keys, minus the comment header).
	const renderedText = await renderEnvFile(repo.id, scope)
	const renderedKeys = new Set(
		parseRawEnv(renderedText)
			.map((e) => e.key)
			.filter(Boolean),
	)

	// Inject deploy-time observability vars that are intentionally NOT stored
	// in the DB (see RENDER_NOISE_KEYS). HQ_PROJECT lets the app's error
	// reporter attribute SERVER-side errors to this
	// app instead of "unknown" — without it, reportError falls back to
	// npm_package_name (undefined in a standalone prod build) → "unknown".
	// Append only when the DB didn't already define it, so an explicit DB value
	// still wins. Purely additive: HQ_PROJECT is drift-guard noise, so this
	// can't trigger a refusal or wipe any key.
	// Gated on POWDER_HQ_* being configured: without an HQ nothing consumes it.
	const finalText = renderedKeys.has('HQ_PROJECT') || !hqConfigured()
		? renderedText
		: `${renderedText}HQ_PROJECT=${encodeEnvValue(repo.containerName)}\n`

	// Read what's currently on disk. If the file doesn't exist yet (first
	// deploy of a fresh app), there's nothing to conflict with. A FAILED read
	// throws (no `.catch(() => null)`): treating "couldn't read" as "nothing
	// there" skipped the guard and let the render overwrite disk-only secrets.
	const existing = await findEnvFile(server, repo.containerName)
	// A rollback may have restored an older rendered snapshot (restoreEnvSnapshot
	// in ssh/files.ts), which can carry keys since deleted from the DB. When the disk
	// is byte-for-byte what powder restored, it's powder's own file, not a hand
	// edit — re-render without the guard. Any edit after the restore changes the
	// hash and the guard applies as usual.
	const restoredSha = existing.exists ? await readEnvRestoreMarker(server, existing.path).catch(() => null) : null
	const diskIsPowderRestore =
		!!restoredSha && createHash('sha256').update(existing.contents, 'utf8').digest('hex') === restoredSha
	if (existing.exists && existing.contents && !diskIsPowderRestore) {
		const diskEntries = parseRawEnv(existing.contents).filter(
			(e) => e.key && e.value && e.value.length > 0,
		)
		const conflicts: PrepareEnvDiff[] = []
		for (const e of diskEntries) {
			if (renderedKeys.has(e.key)) continue
			if (RENDER_NOISE_KEYS.has(e.key)) continue
			// Key name only: no value preview of any kind (the old 4-char prefix
			// ended up in the deploy log once).
			conflicts.push({ key: e.key })
		}
		if (conflicts.length > 0) {
			console.warn(
				`[prepareEnvFileForDeploy] REFUSED render for ${repo.containerName} (${repo.id}): ` +
					`${conflicts.length} disk-only key${conflicts.length === 1 ? '' : 's'} ` +
					`not in powder DB: ${conflicts.map((c) => c.key).join(', ')}. ` +
					`Keeping existing disk file intact. Sync these to powder DB to allow render.`,
			)
			return { rendered: false, refused: true, path, conflicts }
		}
	}

	// containment, checked only now that powder is about to WRITE (a skipped
	// or drift-refused render touches nothing and must not fail on it).
	const target = await checkEnvRenderTarget(server, repo.containerName, path, { allowPin: true })
	if (target) return { rendered: false, unsafeTarget: true, path, message: target }

	await hooks.beforeWrite?.(path)
	await writeEnvFile(server, path, finalText, {
		noSymlinkBelow: envTargetInAppDir(path, repo.containerName) ? `/opt/apps/${repo.containerName}` : undefined,
	})
	if (restoredSha) await clearEnvRestoreMarker(server, existing.path).catch(() => {})
	return { rendered: true, path, bytes: finalText.length }
}

/** the containment context for one app on one server (pins, other apps,
 *  powder's env file) and the cutoff of migration 0057. */
export async function loadEnvTargetCtx(
	serverId: string,
	appName: string,
): Promise<{ ctx: EnvTargetCtx; key: string; cutoff: Date | null }> {
	const key = envTargetMetaKey(serverId, appName)
	const prefix = `${ENV_TARGET_META_PREFIX}${serverId}:`
	const meta = await db.select().from(powderMeta)
	const cutoffRaw = meta.find((r) => r.key === ENV_TARGET_CUTOFF_KEY)?.value ?? null
	const cutoff = cutoffRaw && !Number.isNaN(new Date(cutoffRaw).getTime()) ? new Date(cutoffRaw) : null
	const otherApps = (
		await db.select({ name: appRepos.containerName }).from(appRepos).where(eq(appRepos.serverId, serverId))
	)
		.map((r) => r.name)
		.filter((n) => n !== appName)
	return {
		key,
		cutoff,
		ctx: {
			appName,
			pinned: meta.find((r) => r.key === key)?.value ?? null,
			otherApps,
			otherPins: meta.filter((r) => r.key.startsWith(prefix) && r.key !== key).map((r) => r.value),
			powderEnvFile: process.env.POWDER_ENV_FILE ?? null,
		},
	}
}

/** why powder must not render this app's env to `path` (env-target.ts), or
 *  null. A target outside /opt/apps/<app>.env and /opt/apps/<app>/ is only allowed
 *  when it is pinned for this app. With `allowPin` (the deploy render only, never
 *  the dashboard write) a missing pin is created from evidence that predates the
 *  0057 cutoff (envTargetEvidence). A new app has none, so it never gets a pin. */
export async function checkEnvRenderTarget(
	server: import('./servers').ServerConfig,
	appName: string,
	path: string,
	opts: { allowPin: boolean },
): Promise<string | null> {
	// The app's own convention file or a file in its own dir needs no lookup.
	if (path === `/opt/apps/${appName}.env` || envTargetInAppDir(path, appName))
		return envRenderTargetRefusal(path, { appName, pinned: null })
	const { ctx, key, cutoff } = await loadEnvTargetCtx(server.id, appName)
	let refusal = envRenderTargetRefusal(path, ctx)
	if (refusal && !ctx.pinned && opts.allowPin && cutoff && !envTargetHardRefusal(path, ctx)) {
		const evidence = await envTargetEvidence(server, appName, path, cutoff)
		if (evidence) {
			await db.insert(powderMeta).values({ key, value: path }).onConflictDoNothing()
			const again = await db.select().from(powderMeta).where(eq(powderMeta.key, key))
			ctx.pinned = again.find((r) => r.key === key)?.value ?? null
			console.log(
				`[env-target] ${appName} on ${server.id}: pre-upgrade env render target recorded as ${ctx.pinned} (evidence: ${evidence})`,
			)
			refusal = envRenderTargetRefusal(path, ctx)
		}
	}
	return refusal
		? envTargetRefusalMessage(refusal, server.id, appName, path, ctx, opts.allowPin, !!envTargetHardRefusal(path, ctx))
		: null
}

/** `-U <user> <db>` for psql on powder's own database: POWDER_DB_USER / POWDER_DB_NAME
 *  when set (as in powder.env), else admin / powder. A value that is not a plain word
 *  is shell-quoted, so the hint can be pasted as is. */
export function powderPsqlArgs(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const arg = (v: string | undefined, fallback: string) => {
		const s = v?.trim() || fallback
		return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) ? s : shq(s)
	}
	return `-U ${arg(env.POWDER_DB_USER, 'admin')} ${arg(env.POWDER_DB_NAME, 'powder')}`
}

/** The operator-facing refusal, with the exact way to pin a checked path. */
export function envTargetRefusalMessage(
	refusal: string,
	serverId: string,
	appName: string,
	path: string,
	ctx: Pick<EnvTargetCtx, 'pinned'>,
	fromDeploy: boolean,
	/** The refusal holds even with a pin (envTargetHardRefusal). */
	hard: boolean,
): string {
	const how = hard
		? 'This path can never be pinned: point env_file at /opt/apps/<app>.env or a file inside /opt/apps/<app>/.'
		: `To keep this target, check that it really is this app's env file, then pin it in powder's database (on the powder server: docker exec -i powder-postgres psql ${powderPsqlArgs()}, or postgres on the shared-network layout) with: ${pinSql(serverId, appName, path)} ${fromDeploy ? 'and redeploy.' : 'and save again.'} Or point env_file at /opt/apps/${appName}.env or a file inside /opt/apps/${appName}/.`
	return `${refusal}. powder writes the rendered env only to /opt/apps/${appName}.env, a file inside /opt/apps/${appName}/, or this app's pinned target${ctx.pinned ? ` (${ctx.pinned})` : ' (none pinned)'}. The env file on disk was left as is. ${how} (bin/self-deploy.sh --pin-report lists every app's target and evidence.)`
}

/** evidence that `path` was this app's env target BEFORE the cutoff, or null:
 *  powder's own env snapshot of exactly that path (`deploy-<id>` in the env state dir,
 *  or an in-place `<path>.deploy-<id>` older than the cutoff) from a SUCCESSFUL deploy
 *  of this app that started before the cutoff. Nothing else counts (no compose or
 *  container state: a repo can steer those); without a snapshot an operator pins by
 *  hand (bin/self-deploy.sh --pin-report prints the SQL). */
export async function envTargetEvidence(
	server: import('./servers').ServerConfig,
	appName: string,
	path: string,
	cutoff: Date,
): Promise<'snapshot' | null> {
	const { listEnvSnapshots } = await import('./ssh/files')
	const ids = renderRecordDeployIds(await listEnvSnapshots(server, path).catch(() => ''), cutoff)
	if (ids.length > 0 && (await successBeforeCutoff(server.id, appName, cutoff, ids))) return 'snapshot'
	return null
}

/** A successful deploy of this app that started before the cutoff (one of `ids`). */
async function successBeforeCutoff(
	serverId: string,
	appName: string,
	cutoff: Date,
	ids: string[],
): Promise<boolean> {
	const rows = await db
		.select({ id: deploys.id })
		.from(deploys)
		.where(
			and(
				inArray(deploys.id, ids),
				eq(deploys.serverId, serverId),
				eq(deploys.containerName, appName),
				eq(deploys.status, 'success'),
				sql`${deploys.startedAt} < ${cutoff.toISOString()}`,
			),
		)
		.limit(1)
	return rows.length > 0
}

// ── helpers ──────────────────────────────────────────────────────────────────

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isValidKey(key: string): boolean {
	return KEY_RE.test(key) && key.length <= 200
}

function validateKey(key: string): void {
	if (!isValidKey(key)) {
		throw new Error(
			`invalid env var name "${key}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/ and be ≤200 chars`,
		)
	}
}

// no plaintext prefix is stored (a 4-char hint of every secret in the DB +
// audit log + version history would narrow brute force and leak token kinds
// like `sk_l`). The preview is the length only; '' for an empty value.
export function makePreview(value: string): string {
	if (value.length === 0) return ''
	return `\u2022\u2022\u2022\u2022 (${value.length} chars)`
}

