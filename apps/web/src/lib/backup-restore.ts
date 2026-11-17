// Getting a backup back: presigned download, restore into a NEW database,
// verify (restore into a throwaway database, count tables, drop it), and
// dropping a restore database. Pure parts (name guards, shell builders) live
// in backup-restore-logic.ts.
//
// Restore/verify run like backups: powder writes a script over SFTP and fires
// it detached (setsid) on the app server; the script downloads the encrypted
// object from a presigned GET URL to a 0600 file in /var/tmp (needs free disk
// the size of the encrypted dump, like the backup itself), checks its sha256
// against app_backups.sha256, then runs it through openssl + gunzip into psql
// inside the app's own db container, writing a status file and a log. The dashboard polls the
// log (pollRestore) and the hourly backup tick finalizes rows nobody watched.
//
// Locking: one running row per app (app_backup_restores_running_unique, which
// also covers drops) plus `flock -n` on a per-app lock file on the server. The
// host build lock (lib/build-lock.ts) is deliberately NOT taken: a big
// restore runs for an hour or more and would stall every deploy on the server.
// Backups do not take it either.
//
// Every action writes an app_backup_restores row (requested_by = who), which
// /activity lists.

import {
	type DbTarget,
	assertDroppable,
	assertRestoreTarget,
	buildDownloadCommands,
	buildDropCommand,
	buildRestoreKillCommand,
	buildRestorePollCommand,
	buildRestoreScript,
	dbNameFromUrl,
	isStaleDrop,
	parseRestoreStatus,
	restoreDatabaseUrl,
	restoreDbName,
	restoreCleanupCommand,
	restoreLockFile,
	restoreLogFile,
	restoreScriptPath,
	restoreScriptRemoveCommand,
	restoreStateDirShell,
	restoreStatusFile,
	splitRestorePoll,
} from './backup-restore-logic'
import { buildDetachedFireCommand } from './backup-script'
import { loadConfigForServer, makeClient } from './backups'
import { decryptSecret } from './crypto'
import {
	and,
	appBackupRestores,
	appBackups,
	appEnvVars,
	createId,
	db,
	desc,
	eq,
	prefixes,
} from './db'
import type { AppBackup, AppBackupRestore, AppRepo } from './db'
import { isPgError } from './pg-error'
import { maskUrlPassword } from './secret-mask'
import { redactSecrets, safeSlice } from './secret-text'
import { getServer } from './servers'
import { backupDbContainerFor, dbContainerOwnShell } from './backup-db-owner'
import { shq } from './shell'
import { runCommand, writeFileViaSftp } from './ssh'
import { randomTempPath } from './temp-path'

// Download links are for a human: short. The restore script starts its GET
// within seconds, and a presigned URL is only checked when the request starts.
const DOWNLOAD_URL_TTL_SEC = 15 * 60
const RESTORE_URL_TTL_SEC = 60 * 60
// Script never wrote a status and is gone: it died (reboot, OOM, killed).
const DEAD_GRACE_MS = 2 * 60 * 1000
// Longer than any sane restore; past this the job is killed and failed.
const RUNNING_LIMIT_MS = 48 * 3600 * 1000
const OUTPUT_KEEP_BYTES = 64 * 1024

export class RestoreError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message)
	}
}

interface ResolvedDb {
	target: DbTarget
	password: string | null
}

/** the default `<app>-db` must not be another compose project's container. */
async function assertOwnDbContainer(server: NonNullable<Awaited<ReturnType<typeof getServer>>>, repo: AppRepo): Promise<void> {
	const db = backupDbContainerFor(repo)
	if (!db.isDefault) return
	const r = await runCommand(server, `bash -c ${shq(dbContainerOwnShell(db.container, repo.containerName))}`, 15_000)
	if (r.code !== 0) throw new RestoreError((r.stdout || r.stderr).trim() || 'the db container belongs to another compose project')
}

// Same resolution as runBackupForApp: backup_db_* overrides, else <app>-db / app / app.
// Host-mode postgres (backup_db_host) is not a container powder can create a
// database in, so restore refuses it; download still works.
function resolveRestoreDb(repo: AppRepo): ResolvedDb {
	if (repo.backupDbHost) {
		throw new RestoreError(
			'restore needs the app db in a docker container; this app uses host postgres (backup_db_host). use download instead.',
		)
	}
	return {
		target: {
			container: backupDbContainerFor(repo).container,
			user: repo.backupDbUser || 'app',
			liveDb: repo.backupDbName || 'app',
			withPassword: !!repo.backupDbPasswordEncrypted,
		},
		password: repo.backupDbPasswordEncrypted ? decryptSecret(repo.backupDbPasswordEncrypted) : null,
	}
}

async function loadRestorableBackup(repo: AppRepo, backupId: string): Promise<AppBackup> {
	const [bkp] = await db
		.select()
		.from(appBackups)
		.where(
			and(
				eq(appBackups.id, backupId),
				eq(appBackups.serverId, repo.serverId),
				eq(appBackups.containerName, repo.containerName),
			),
		)
		.limit(1)
	if (!bkp) throw new RestoreError('backup not found', 404)
	if (bkp.status !== 'success') throw new RestoreError(`backup is ${bkp.status}, not restorable`)
	if (bkp.prunedAt) throw new RestoreError('backup was pruned by retention; its object is gone')
	return bkp
}

/** The app's production DATABASE_URL from powder's env DB, or null. */
async function appDatabaseUrl(repo: AppRepo): Promise<string | null> {
	const [row] = await db
		.select({ v: appEnvVars.valueEncrypted })
		.from(appEnvVars)
		.where(
			and(
				eq(appEnvVars.appRepoId, repo.id),
				eq(appEnvVars.key, 'DATABASE_URL'),
				eq(appEnvVars.scope, 'production'),
			),
		)
		.limit(1)
	if (!row) return null
	try {
		return decryptSecret(row.v)
	} catch {
		return null
	}
}

/** Masked DATABASE_URL for the restore db (password `****`), or a template. */
export async function restoreUrlHint(repo: AppRepo, target: string): Promise<string> {
	const live = await appDatabaseUrl(repo)
	const swapped = restoreDatabaseUrl(live, target)
	if (swapped) return maskUrlPassword(swapped) ?? swapped
	const user = repo.backupDbUser || 'app'
	return `postgres://${user}:<password>@<db host>:5432/${target}`
}

// ── Download ────────────────────────────────────────────────────────────────

export async function presignBackupDownload(repo: AppRepo, backupId: string, by: string) {
	const bkp = await loadRestorableBackup(repo, backupId)
	const cfg = await loadConfigForServer(repo.serverId)
	if (!cfg) throw new RestoreError('backup storage not configured', 503)
	const url = await makeClient(cfg).presignedGetObject(cfg.bucket, bkp.s3Key, DOWNLOAD_URL_TTL_SEC)
	const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SEC * 1000)
	await db.insert(appBackupRestores).values({
		id: createId(prefixes.backupRestore),
		kind: 'download',
		backupId: bkp.id,
		serverId: repo.serverId,
		containerName: repo.containerName,
		status: 'success',
		requestedBy: by,
		finishedAt: new Date(),
	})
	const liveDb = repo.backupDbName || 'app'
	return {
		url,
		expiresAt: expiresAt.toISOString(),
		sha256: bkp.sha256,
		sizeBytes: bkp.sizeBytes,
		commands: buildDownloadCommands({
			url,
			s3Key: bkp.s3Key,
			containerName: repo.containerName,
			sha256: bkp.sha256,
			dbUser: repo.backupDbUser || 'app',
			dbContainer: backupDbContainerFor(repo).container,
			newDb: restoreDbName(liveDb, bkp.startedAt),
		}),
	}
}

// ── Restore / verify ────────────────────────────────────────────────────────

async function insertRunning(
	values: typeof appBackupRestores.$inferInsert,
): Promise<AppBackupRestore> {
	// app_backup_restores_running_unique is the per-app lock. ON CONFLICT DO
	// NOTHING makes "already running" an empty result instead of a 23505 that
	// postgres logs as an ERROR; the catch stays as a fallback.
	let row: AppBackupRestore | undefined
	try {
		;[row] = await db.insert(appBackupRestores).values(values).onConflictDoNothing().returning()
	} catch (err) {
		if (!isPgError(err, '23505')) throw err
		row = undefined
	}
	if (!row) throw new RestoreError('a restore, verify or drop is already running for this app', 409)
	return row
}

async function failRow(id: string, error: string, output?: string): Promise<void> {
	await db
		.update(appBackupRestores)
		.set({
			status: 'failed',
			error: safeSlice(redactSecrets(error), 0, 1000),
			finishedAt: new Date(),
			...(output !== undefined
				? { output: safeSlice(redactSecrets(output), -OUTPUT_KEEP_BYTES) }
				: {}),
		})
		.where(and(eq(appBackupRestores.id, id), eq(appBackupRestores.status, 'running')))
}

// Finalize this app's running rows first, so a job that finished while no one
// was watching does not hold the per-app slot until the next hourly tick.
async function settleRunningForApp(repo: AppRepo): Promise<void> {
	const rows = await db
		.select()
		.from(appBackupRestores)
		.where(
			and(
				eq(appBackupRestores.serverId, repo.serverId),
				eq(appBackupRestores.containerName, repo.containerName),
				eq(appBackupRestores.status, 'running'),
			),
		)
	for (const r of rows) await pollRestore(r).catch(() => {})
}

export async function startRestore(
	repo: AppRepo,
	backupId: string,
	mode: 'restore' | 'verify',
	by: string,
): Promise<AppBackupRestore> {
	if (!repo.hasPostgres) throw new RestoreError('app has no postgres')
	const { target: dbt, password } = resolveRestoreDb(repo)
	const bkp = await loadRestorableBackup(repo, backupId)
	const cfg = await loadConfigForServer(repo.serverId)
	if (!cfg) throw new RestoreError('backup storage not configured', 503)
	const server = await getServer(repo.serverId)
	if (!server) throw new RestoreError(`unknown server ${repo.serverId}`, 404)
	await assertOwnDbContainer(server, repo)

	const target = assertRestoreTarget(
		restoreDbName(dbt.liveDb, new Date(), mode === 'verify'),
		dbt.liveDb,
	)

	await settleRunningForApp(repo)
	const row = await insertRunning({
		id: createId(prefixes.backupRestore),
		kind: mode,
		backupId: bkp.id,
		serverId: repo.serverId,
		containerName: repo.containerName,
		targetDb: target,
		status: 'running',
		requestedBy: by,
	})

	// set before the script is written: a failed write or fire removes it (it holds the passphrase).
	let scriptPath: string | null = null
	try {
		// Fail fast with a clear message if the object is gone.
		const stat = await makeClient(cfg).statObject(cfg.bucket, bkp.s3Key)
		const url = await makeClient(cfg).presignedGetObject(cfg.bucket, bkp.s3Key, RESTORE_URL_TTL_SEC)
		// Same PGPASSWORD env-file lines as the backup script: 0600, cleaned in the trap.
		const preLines = password
			? [
					'PGPASS_FILE=$(mktemp)',
					`chmod 600 "$PGPASS_FILE"`,
					`printf 'PGPASSWORD=%s\\n' "$(printf '%s' '${Buffer.from(password, 'utf8').toString('base64')}' | base64 -d)" > "$PGPASS_FILE"`,
				]
			: []
		const script = buildRestoreScript({
			id: row.id,
			mode,
			db: dbt,
			target,
			passB64: Buffer.from(cfg.passphrase, 'utf8').toString('base64'),
			urlB64: Buffer.from(url, 'utf8').toString('base64'),
			sha256: bkp.sha256 ?? null,
			preLines,
			statusFile: restoreStatusFile(row.id),
			lockFile: restoreLockFile(repo.containerName),
			objectSize: typeof stat?.size === 'number' ? stat.size : null,
		})
		const path = restoreScriptPath(row.id)
		scriptPath = path
		await writeFileViaSftp(server, path, script, 0o700, 30_000, false, true)
		// umask 077 inside: the log (psql error context can quote rows) is 0600.
		// status, log and lock live in the root-only RESTORE_STATE_DIR.
		const fire = `${restoreStateDirShell()}\n${buildDetachedFireCommand(path, restoreLogFile(row.id), 'fired')}`
		const { code, stdout, stderr } = await runCommand(server, fire, 30_000)
		if (code !== 0)
			throw new Error(`failed to start restore (exit ${code}): ${(stderr || stdout).slice(-500)}`)
		return row
	} catch (err) {
		if (scriptPath) await runCommand(server, restoreScriptRemoveCommand(scriptPath), 10_000).catch(() => {})
		await failRow(row.id, err instanceof Error ? err.message : String(err))
		throw err
	}
}

export interface RestorePoll {
	row: AppBackupRestore
	// Live log tail while running; the saved output once finished.
	log: string
	reachable: boolean
}

export async function pollRestore(row: AppBackupRestore): Promise<RestorePoll> {
	// A drop is synchronous (60s SSH cap). One still running past DROP_STALE_MS
	// lost its process (powder restart mid-call); without this it would hold
	// the per-app running slot forever and 409 every later restore/verify/drop.
	if (isStaleDrop(row, Date.now())) {
		await failRow(
			row.id,
			'drop interrupted (powder restarted during the call); check whether the database still exists and drop again if needed',
		)
		return { row: await reload(row), log: row.output ?? '', reachable: true }
	}
	if (row.status !== 'running' || (row.kind !== 'restore' && row.kind !== 'verify')) {
		return { row, log: row.output ?? '', reachable: true }
	}
	const age = Date.now() - row.startedAt.getTime()
	const server = await getServer(row.serverId)
	if (!server) {
		if (age > RUNNING_LIMIT_MS) await failRow(row.id, 'server not registered')
		return { row: await reload(row), log: '', reachable: false }
	}
	let polled: ReturnType<typeof splitRestorePoll>
	try {
		const res = await runCommand(server, buildRestorePollCommand(row.id), 15_000)
		if (res.code !== 0) throw new Error(`poll exit ${res.code}`)
		polled = splitRestorePoll(res.stdout)
	} catch {
		if (age > RUNNING_LIMIT_MS) await failRow(row.id, 'server unreachable')
		return { row: await reload(row), log: redactSecrets(row.output ?? ''), reachable: false }
	}

	const parsed = polled.status === 'MISSING' ? null : parseRestoreStatus(polled.status)
	const cleanup = () => runCommand(server, restoreCleanupCommand(row.id), 5_000).catch(() => {})

	if (parsed?.status === 'success') {
		await db
			.update(appBackupRestores)
			.set({
				status: 'success',
				tableCount: parsed.tables ?? null,
				sizeBytes: parsed.size ?? null,
				output: safeSlice(redactSecrets(polled.log), -OUTPUT_KEEP_BYTES),
				finishedAt: parsed.finishedAt ?? new Date(),
				// A verify database is dropped by the script before it reports success.
				...(row.kind === 'verify' ? { droppedAt: new Date() } : {}),
			})
			.where(and(eq(appBackupRestores.id, row.id), eq(appBackupRestores.status, 'running')))
		await cleanup()
	} else if (parsed?.status === 'failed') {
		await failRow(row.id, parsed.error || 'unknown', polled.log)
		await cleanup()
	} else if (polled.alive === false && age > DEAD_GRACE_MS) {
		await failRow(row.id, 'script exited without a status (died mid-run)', polled.log)
		await cleanup()
	} else if (polled.alive === true && age > RUNNING_LIMIT_MS) {
		await runCommand(server, buildRestoreKillCommand(row.id), 15_000).catch(() => {})
		await failRow(row.id, `still running after ${RUNNING_LIMIT_MS / 3.6e6}h, killed`, polled.log)
		await cleanup()
	}
	return { row: await reload(row), log: redactSecrets(polled.log), reachable: true }
}

async function reload(row: AppBackupRestore): Promise<AppBackupRestore> {
	const [r] = await db
		.select()
		.from(appBackupRestores)
		.where(eq(appBackupRestores.id, row.id))
		.limit(1)
	return r ?? row
}

export async function pollPendingRestores(): Promise<void> {
	const rows = await db
		.select()
		.from(appBackupRestores)
		.where(eq(appBackupRestores.status, 'running'))
	for (const r of rows) {
		await pollRestore(r).catch((err) =>
			console.warn(
				`[restore-poll] ${r.containerName}/${r.id}:`,
				err instanceof Error ? err.message : err,
			),
		)
	}
}

// ── Drop ────────────────────────────────────────────────────────────────────

export async function dropRestoreDb(
	repo: AppRepo,
	targetDb: string,
	by: string,
): Promise<AppBackupRestore> {
	const { target: dbt, password } = resolveRestoreDb(repo)
	const appUrlDb = dbNameFromUrl(await appDatabaseUrl(repo))
	try {
		assertDroppable(targetDb, dbt.liveDb, appUrlDb)
	} catch (err) {
		throw new RestoreError(err instanceof Error ? err.message : String(err))
	}
	const server = await getServer(repo.serverId)
	if (!server) throw new RestoreError(`unknown server ${repo.serverId}`, 404)
	await assertOwnDbContainer(server, repo)

	await settleRunningForApp(repo)
	const row = await insertRunning({
		id: createId(prefixes.backupRestore),
		kind: 'drop',
		serverId: repo.serverId,
		containerName: repo.containerName,
		targetDb,
		status: 'running',
		requestedBy: by,
	})

	// The password (if any) goes over SFTP into a 0600 file, never into argv.
	const envTmp = password ? randomTempPath(`/tmp/powder-pgenv-${row.id}`) : null
	try {
		if (envTmp && password) {
			await writeFileViaSftp(server, envTmp, `PGPASSWORD=${password}\n`, 0o600, 10_000, true, true)
		}
		const cmd = [
			...(envTmp ? [`PGPASS_FILE=${shq(envTmp)}`, `trap 'rm -f "$PGPASS_FILE"' EXIT`] : []),
			buildDropCommand(dbt, targetDb, appUrlDb),
		].join('\n')
		const { code, stdout, stderr } = await runCommand(server, cmd, 60_000)
		const out = safeSlice(redactSecrets(`${stdout}${stderr}`), -OUTPUT_KEEP_BYTES)
		if (code !== 0) {
			// e.g. "database ... is being accessed by other users": something is
			// still connected to it (maybe the app). That refusal is the point.
			await failRow(row.id, (stderr || stdout).trim().slice(-500) || `exit ${code}`, out)
			throw new RestoreError(`drop failed: ${(stderr || stdout).trim().slice(-300)}`, 409)
		}
		const now = new Date()
		await db
			.update(appBackupRestores)
			.set({ status: 'success', output: out, finishedAt: now })
			.where(eq(appBackupRestores.id, row.id))
		await db
			.update(appBackupRestores)
			.set({ droppedAt: now })
			.where(
				and(
					eq(appBackupRestores.serverId, repo.serverId),
					eq(appBackupRestores.containerName, repo.containerName),
					eq(appBackupRestores.targetDb, targetDb),
					eq(appBackupRestores.kind, 'restore'),
				),
			)
		return reload(row)
	} catch (err) {
		if (!(err instanceof RestoreError))
			await failRow(row.id, err instanceof Error ? err.message : String(err))
		throw err
	} finally {
		if (envTmp) await runCommand(server, `rm -f ${shq(envTmp)}`, 5_000).catch(() => {})
	}
}

export async function listRestoresForApp(
	serverId: string,
	containerName: string,
	limit = 30,
): Promise<AppBackupRestore[]> {
	return db
		.select()
		.from(appBackupRestores)
		.where(
			and(
				eq(appBackupRestores.serverId, serverId),
				eq(appBackupRestores.containerName, containerName),
			),
		)
		.orderBy(desc(appBackupRestores.startedAt))
		.limit(limit)
}
