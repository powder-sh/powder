// Per-app postgres backups → S3-compatible object storage.
//
// Pipeline (always multipart):
//   1. Powder calls InitiateMultipartUpload → gets uploadId, persisted to
//      app_backups.s3_upload_id.
//   2. Powder presigns N UploadPart URLs (one per planned part).
//   3. Powder SSH-execs on the app server: pg_dump | gzip | openssl enc to
//      $DUMPFILE, verifies it (decrypt + gunzip + pg_dump trailer) and
//      sha256s it, then for each part: dd a 100 MiB chunk → curl PUT it →
//      capture ETag from response header → next part. (backup-script.ts)
//   4. Script writes status=uploaded_pending_complete + parts CSV to a status
//      file. pollPendingBackups reads it and calls CompleteMultipartUpload.
//      On any failure, AbortMultipartUpload releases the store's parts so
//      we don't accrue billing for orphaned uploads.
//
// Why multipart unconditionally: some S3-compatible stores (Hetzner Object
// Storage, for one) cap a single PUT at 5 GiB with HTTP 400 EntityTooLarge, so a
// larger encrypted dump would fail on every tick. The multipart minimum part size is 5 MiB
// and the smallest apps' encrypted dumps are >5 MiB after openssl headers, so
// a single code path works for every app - a 60 KB dump uploads as one
// final-part-only multipart.
//
// Encryption: client-side AES-256-CBC + PBKDF2 via openssl, passphrase from
// POWDER_BACKUP_KEY env var. Passphrase is materialized briefly to a tmp
// file on the app server (not via cmdline) so it doesn't appear in `ps aux`.
//
// Powder is the only system that holds the S3 credentials. App servers only
// ever see presigned URLs, valid for a few hours and scoped to one S3 key.
//
// To get one back: backup-restore.ts (presigned download, restore into a new
// <db>_restore_<yyyymmdd_hhmm> database, verify, drop restore db).

import { backupDbContainerFor, dbContainerOwnShell } from './backup-db-owner'
import { redactSecrets, safeSlice } from './secret-text'
import { Client as MinioClient } from 'minio'
import {
	backupObjectKey,
	canDeleteObject,
	isBackupDue,
	isConnectFailure,
	landedObjectMatches,
	newestLooksShrunk,
	parseStatusFile,
	planRetention,
} from './backup-logic'
import {
	buildBackupScript,
	backupCleanupCommand,
	buildBackupFireCommand,
	backupScriptPath,
	backupScriptRemoveCommand,
	buildKillCommand,
	buildPollCommand,
	shq,
	splitPollOutput,
} from './backup-script'
import { decryptSecret } from './crypto'
import { isPgError } from './pg-error'
import { postgresToolImage } from './tool-images'
import { TOOL_RUN_HARDEN } from './side-run'
import { reportCronToHq } from './hq'
import { notify } from './notifications'
import {
	and,
	appBackups,
	appRepos,
	asc,
	createId,
	db,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	or,
	prefixes,
	servers,
} from './db'
import type { AppBackup, AppRepo } from './db'
import { getServer } from './servers'
import { runCommand, writeFileViaSftp } from './ssh'

export interface BackupConfig {
	endpoint: string
	region: string
	accessKeyId: string
	secretAccessKey: string
	bucket: string
	passphrase: string
}

// Loads the global default config from env vars. Per-server overrides are
// merged on top in `loadConfigForServer`. The passphrase is always global —
// uniform across servers means a single key restores any backup.
function loadDefaultConfig(): Partial<BackupConfig> {
	return {
		endpoint: process.env.BACKUP_S3_ENDPOINT,
		region: process.env.BACKUP_S3_REGION ?? 'us-east-1',
		bucket: process.env.BACKUP_S3_BUCKET,
		accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID,
		secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
		passphrase: process.env.POWDER_BACKUP_KEY,
	}
}

// Returns the resolved backup destination for an app on `serverId`. Server
// row's backup_* columns win over env vars; passphrase always comes from env.
export async function loadConfigForServer(serverId: string): Promise<BackupConfig | null> {
	const defaults = loadDefaultConfig()
	const [row] = await db.select().from(servers).where(eq(servers.id, serverId))
	const endpoint = row?.backupS3Endpoint || defaults.endpoint
	const region = row?.backupS3Region || defaults.region
	const bucket = row?.backupS3Bucket || defaults.bucket
	const accessKeyId =
		(row?.backupS3AccessKeyIdEncrypted ? decryptSecret(row.backupS3AccessKeyIdEncrypted) : null) ||
		defaults.accessKeyId
	const secretAccessKey =
		(row?.backupS3SecretAccessKeyEncrypted
			? decryptSecret(row.backupS3SecretAccessKeyEncrypted)
			: null) || defaults.secretAccessKey
	const passphrase = defaults.passphrase
	if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey || !passphrase) {
		return null
	}
	return { endpoint, region, bucket, accessKeyId, secretAccessKey, passphrase }
}

// True if at least the global env-var defaults are set. Per-server overrides
// can fill gaps but the passphrase + at least one bucket must be configured.
export function isBackupConfigured(): boolean {
	const d = loadDefaultConfig()
	return !!d.passphrase && (!!d.endpoint || !!process.env.BACKUP_S3_ENDPOINT)
}

export function makeClient(cfg: BackupConfig): MinioClient {
	const url = new URL(cfg.endpoint)
	return new MinioClient({
		endPoint: url.hostname,
		port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
		useSSL: url.protocol === 'https:',
		region: cfg.region,
		accessKey: cfg.accessKeyId,
		secretKey: cfg.secretAccessKey,
	})
}

// Multipart sizing. 100 MiB × 500 parts = 50 GiB cap per backup, headroom over a
// large encrypted dump. S3's
// hard limits are higher (10000 parts × 5 GiB/part = 5 TiB) but 500 keeps the
// presigned-URL list payload reasonable (~250 KB inlined into the bash script).
const MAX_PARTS = 500
// 24h, not 4h. URLs are minted up front at dispatch, and a 4h clock would
// expire mid-upload for big DBs: a large dump takes long to create before a
// single part uploads, and the remaining window is too short to push every part
// (HTTP 000 = the store dropping the expired-URL connection). 24h gives ample headroom for big/growing DBs; SigV4 max is 7 days.
const PART_URL_EXPIRY_SECONDS = 24 * 3600

// Initiate multipart and presign every UploadPart URL up front. Presigning is
// purely local AWS-sig-v4 signing — no S3 round trip per URL — so generating
// 500 of them is cheap. The script uses only as many as the dump needs.
async function initiateMultipart(
	cfg: BackupConfig,
	key: string,
): Promise<{ uploadId: string; partUrls: string[] }> {
	const client = makeClient(cfg)
	const uploadId = await client.initiateNewMultipartUpload(cfg.bucket, key, {})
	const partUrls: string[] = []
	for (let i = 1; i <= MAX_PARTS; i++) {
		const url = await client.presignedUrl(
			'PUT',
			cfg.bucket,
			key,
			PART_URL_EXPIRY_SECONDS,
			{ uploadId, partNumber: String(i) },
		)
		partUrls.push(url)
	}
	return { uploadId, partUrls }
}

// Cleanly release parts held by the store for an unfinished multipart upload.
// Failure here is non-fatal; orphaned parts cost a small amount of storage
// until the store's own multipart lifecycle policy expires them, but we never
// want abort failure to mask the underlying backup failure to the caller.
async function abortMultipart(cfg: BackupConfig, key: string, uploadId: string): Promise<void> {
	try {
		await abortMultipartOrThrow(cfg, key, uploadId)
	} catch (err) {
		console.warn(
			`[backup] abortMultipartUpload(${key}, ${uploadId}) failed:`,
			err instanceof Error ? err.message : err,
		)
	}
}

// The abort itself; an upload the store no longer knows (already aborted or
// completed, or expired by its lifecycle policy) counts as aborted.
async function abortMultipartOrThrow(cfg: BackupConfig, key: string, uploadId: string): Promise<void> {
	try {
		await makeClient(cfg).abortMultipartUpload(cfg.bucket, key, uploadId)
	} catch (err) {
		if ((err as { code?: unknown } | null)?.code === 'NoSuchUpload') return
		throw err
	}
}

// A failed row that still holds s3_upload_id may hold multipart parts nobody
// will complete: the 0064 duplicate cleanup marks rows failed without aborting,
// and the failure paths here abort without clearing the id (a swallowed abort
// error leaves parts behind). Abort each such upload and clear the id. Idempotent
// (a gone upload counts as aborted). Oldest first (finished_at). A failed abort
// counts in abort_attempts (0065) and is retried on the next tick; after
// DANGLING_ABORT_MAX_ATTEMPTS failures, or at once on an error no retry can fix
// (the bucket is gone, the key may not abort), the id is cleared with a logged
// error. So rows that can never be aborted leave the batch and cannot starve the
// ones behind them.
const DANGLING_UPLOADS_PER_TICK = 50
export const DANGLING_ABORT_MAX_ATTEMPTS = 5
const DANGLING_ABORT_FINAL_CODES = new Set(['NoSuchBucket', 'AccessDenied'])

export async function abortDanglingUploads(): Promise<{ aborted: number; errors: number; givenUp: number }> {
	const rows = await db
		.select({
			id: appBackups.id,
			serverId: appBackups.serverId,
			s3Key: appBackups.s3Key,
			s3UploadId: appBackups.s3UploadId,
			abortAttempts: appBackups.abortAttempts,
		})
		.from(appBackups)
		.where(and(eq(appBackups.status, 'failed'), isNotNull(appBackups.s3UploadId)))
		.orderBy(asc(appBackups.finishedAt), asc(appBackups.id))
		.limit(DANGLING_UPLOADS_PER_TICK)
	const result = { aborted: 0, errors: 0, givenUp: 0 }
	for (const row of rows) {
		if (!row.s3UploadId) continue
		const sameUpload = and(eq(appBackups.id, row.id), eq(appBackups.s3UploadId, row.s3UploadId))
		try {
			const cfg = await loadConfigForServer(row.serverId)
			if (!cfg) throw new Error('backup config not set for this server')
			await abortMultipartOrThrow(cfg, row.s3Key, row.s3UploadId)
			await db.update(appBackups).set({ s3UploadId: null }).where(sameUpload)
			result.aborted++
		} catch (err) {
			result.errors++
			const msg = err instanceof Error ? err.message : String(err)
			const code = (err as { code?: unknown } | null)?.code
			const attempts = (row.abortAttempts ?? 0) + 1
			const final = typeof code === 'string' && DANGLING_ABORT_FINAL_CODES.has(code)
			if (final || attempts >= DANGLING_ABORT_MAX_ATTEMPTS) {
				await db.update(appBackups).set({ s3UploadId: null, abortAttempts: attempts }).where(sameUpload)
				result.givenUp++
				console.error(
					`[backup] gave up aborting the dangling upload ${row.s3UploadId} of ${row.id} (${row.s3Key}) after ${attempts} attempt(s)${final ? ` (${code})` : ''}: ${msg}. Its parts may stay in the bucket until its lifecycle policy expires them.`,
				)
			} else {
				await db.update(appBackups).set({ abortAttempts: attempts }).where(sameUpload)
				console.warn(
					`[backup] abort of the dangling upload of ${row.id} failed (attempt ${attempts}/${DANGLING_ABORT_MAX_ATTEMPTS}), retrying next tick: ${msg}`,
				)
			}
		}
	}
	return result
}

// ── In-flight guard ──────────────────────────────────────────────────────────
// One backup per app at a time: a second trigger while one runs is refused
// (BackupInFlightError), backed by the partial unique index
// app_backups_in_flight_unique (0064). A row still in flight after the
// presigned URLs expired (STALE_IN_FLIGHT_MS) cannot succeed (a crashed
// run the poller never reaped): the next trigger reaps it and goes ahead.
export class BackupInFlightError extends Error {
	constructor(readonly backupId: string | null) {
		super('a backup of this app is already running')
	}
}

export type BackupSource = 'scheduled' | 'manual'

export function isStaleInFlight(startedAt: Date, now = Date.now()): boolean {
	return now - startedAt.getTime() > STALE_IN_FLIGHT_MS
}

async function inFlightBackups(serverId: string, containerName: string): Promise<AppBackup[]> {
	return db
		.select()
		.from(appBackups)
		.where(
			and(
				eq(appBackups.serverId, serverId),
				eq(appBackups.containerName, containerName),
				inArray(appBackups.status, ['running', 'uploaded_pending_complete']),
			),
		)
}

/** The in-flight backup of this app that is not stale, or null. */
export async function liveInFlightBackup(
	serverId: string,
	containerName: string,
): Promise<AppBackup | null> {
	return (await inFlightBackups(serverId, containerName)).find((b) => !isStaleInFlight(b.startedAt)) ?? null
}

// `source` defaults to manual: only the scheduled tick passes 'scheduled', so a
// new caller can never run retention by accident.
export async function runBackupForApp(
	repo: AppRepo,
	opts: { source?: BackupSource } = {},
): Promise<AppBackup> {
	const source: BackupSource = opts.source ?? 'manual'
	if (!repo.hasPostgres) throw new Error('app has no postgres sibling')
	// Every server is the operator's, so the global POWDER_BACKUP_KEY may go to any of them.
	const cfg = await loadConfigForServer(repo.serverId)
	if (!cfg) throw new Error('backup config not set (env vars or per-server override required)')

	const server = await getServer(repo.serverId)
	if (!server) throw new Error(`unknown server ${repo.serverId}`)

	// Per-app overrides for shared-postgres setups (e.g. a <project>-postgres-1 container
	// hosting many DBs). Default convention is <name>-db / app / app for newly-created
	// powder apps that get their own postgres sibling. `backupDbHost` triggers
	// host-postgres mode (postgres running on the OS, not in docker).
	const dbName = repo.backupDbName || 'app'
	const dbUser = repo.backupDbUser || 'app'
	const dbHost = repo.backupDbHost
	const { container: dbContainer, isDefault: dbDefault } = backupDbContainerFor(repo)
	const dbPassword = repo.backupDbPasswordEncrypted
		? decryptSecret(repo.backupDbPasswordEncrypted)
		: null
	const isHostMode = !!dbHost
	if (isHostMode && !dbPassword) {
		throw new Error('a backup from a database host needs a password (database form on the backups tab)')
	}
	for (const prev of await inFlightBackups(repo.serverId, repo.containerName)) {
		if (!isStaleInFlight(prev.startedAt)) throw new BackupInFlightError(prev.id)
		await reapBackup(prev, `still in flight after ${STALE_IN_FLIGHT_MS / 3_600_000}h, superseded by a new backup`, server, true)
	}
	const id = createId(prefixes.backup)
	// Unique per backup row (server + container + row id). See backupObjectKey.
	const s3Key = backupObjectKey({
		serverId: repo.serverId,
		containerName: repo.containerName,
		backupId: id,
		at: new Date(),
	})
	// app_backups_in_flight_unique is the per-app lock: another trigger may insert
	// its row between the check above and here. ON CONFLICT DO NOTHING makes that an
	// empty result instead of a 23505 that postgres logs as an ERROR; the catch
	// stays as a fallback.
	let row: AppBackup | undefined
	try {
		;[row] = await db
			.insert(appBackups)
			.values({
				id,
				serverId: repo.serverId,
				containerName: repo.containerName,
				s3Key,
				status: 'running',
				source,
			})
			.onConflictDoNothing()
			.returning()
	} catch (err) {
		if (!isPgError(err, '23505')) throw err
		row = undefined
	}
	if (!row) throw new BackupInFlightError(null)

	let uploadId: string | null = null
	// set before the script is written: a failed write or fire removes it (it holds the passphrase).
	let scriptPath: string | null = null

	try {
		const initiated = await initiateMultipart(cfg, s3Key)
		uploadId = initiated.uploadId
		// Persist uploadId immediately. If powder restarts mid-flight, the
		// reaper / poller still has enough context to call AbortMultipartUpload
		// and not leak parts.
		await db
			.update(appBackups)
			.set({ s3UploadId: uploadId })
			.where(eq(appBackups.id, id))

		// One newline-separated string of presigned part URLs, base64'd, decoded
		// inside the script. Up to MAX_PARTS lines; the script reads only as many
		// as ceil(dumpSize/PART_SIZE_BYTES). Each URL is valid for
		// PART_URL_EXPIRY_SECONDS (24h).
		const urlsB64 = Buffer.from(initiated.partUrls.join('\n'), 'utf8').toString('base64')

		// Pass passphrase via temp file (avoids ps-aux exposure during openssl invocation).
		// Base64 the passphrase to dodge any shell-interpolation hazard if it contains
		// quotes/backslashes.
		const passB64 = Buffer.from(cfg.passphrase, 'utf8').toString('base64')

		// Build the dump command. Two flavors:
		//   docker-exec  → DB runs in a container we can reach: `docker exec <c> pg_dump -U user db`
		//   host-network → DB runs on the host OS (e.g. an app on a client server):
		//                  spawn a throwaway pg_dump container with --network=host so it can
		//                  reach 127.0.0.1:5432 directly. Pull image once; subsequent backups
		//                  reuse it. Postgres image picked at version-17 because pg_dump 17
		//                  can dump from any postgres ≥ 9.
		let dumpCmd: string
		const envFileMount: string[] = []
		// Pre-script lines that write a 600-mode PGPASSWORD env file when needed.
		// docker --env-file reads it; the password never appears in argv (so not
		// visible in `ps aux`). Cleaned up via the trap on script exit.
		const writePgPassFile = (pw: string) => [
			`PGPASS_FILE=$(mktemp)`,
			`chmod 600 "$PGPASS_FILE"`,
			`printf 'PGPASSWORD=%s\\n' "$(printf '%s' '${Buffer.from(pw, 'utf8').toString('base64')}' | base64 -d)" > "$PGPASS_FILE"`,
		]

		if (isHostMode) {
			// Parse "host:port" or just "host"
			const [hostPart = '', portPart] = (dbHost ?? '').split(':')
			const port = portPart || '5432'
			envFileMount.push(...writePgPassFile(dbPassword ?? ''))
			// --log-driver=none keeps the dump out of the Docker log driver, which
			// would otherwise store a plaintext copy on the host next to the pipe
			// read here. The docker-exec branches below are unaffected: exec
			// output never goes through a log driver.
			dumpCmd =
				`docker run --rm --log-driver=none --network host ${TOOL_RUN_HARDEN} --env-file "$PGPASS_FILE" --entrypoint pg_dump ${shq(postgresToolImage())} ` +
				`-h ${shq(hostPart)} -p ${shq(port)} -U ${shq(dbUser)} ${shq(dbName)}`
		} else if (dbPassword) {
			// docker-exec mode with explicit password (rare — most convention apps
			// use socket trust auth and skip this branch).
			envFileMount.push(...writePgPassFile(dbPassword))
			dumpCmd = `docker exec --env-file "$PGPASS_FILE" ${shq(dbContainer)} pg_dump -U ${shq(dbUser)} ${shq(dbName)}`
		} else {
			// docker-exec mode, socket trust auth (default).
			dumpCmd = `docker exec ${shq(dbContainer)} pg_dump -U ${shq(dbUser)} ${shq(dbName)}`
		}

		// Status file written by the backup script. `pollPendingBackups` reads it
		// later to learn the outcome. Keyed by backup id so concurrent backups
		// on the same server don't collide.
		// dump → gzip → encrypt → verify → sha256 → chunked multipart upload.
		// See backup-script.ts for the stage-by-stage notes.
		// the default <app>-db only when no other compose project owns it.
		if (!isHostMode && dbDefault)
			envFileMount.push(
				`if ! __dbo=$(${dbContainerOwnShell(dbContainer, repo.containerName)}); then printf 'status=failed\\nerror=db_container_other_project\\nupload_id=%s\\nfinished_at=%s\\n' "$UPLOAD_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS_FILE"; echo "$__dbo" >&2; exit 1; fi`,
			)
		const innerScript = buildBackupScript({
			dumpCmd,
			preLines: envFileMount,
			passB64,
			urlsB64,
			uploadId,
			maxParts: MAX_PARTS,
		})

		// Upload the script via SFTP rather than embedding it in the SSH exec
		// command. The script can be ~440 KB (500 × ~600-char presigned URLs)
		// and embedding that in a CHANNEL_REQUEST exec triggers EPIPE /
		// ECONNRESET on transmit — exec payloads are bounded by max_packet_size
		// (commonly 32 KB), while SFTP runs on its own windowed channel.
		// random name, created exclusively over SFTP.
		const path = backupScriptPath(id)
		scriptPath = path
		await writeFileViaSftp(server, path, innerScript, 0o700, 30_000, false, true)

		// Detached fire. setsid + new session + redirected stdio = survives our
		// SSH session ending. The outer SSH command returns in seconds; the
		// backup may run for hours. pollPendingBackups picks up the result.
		// Run via bash (NOT sh — Ubuntu's /bin/sh is dash which rejects
		// `set -o pipefail`. The dump pipeline NEEDS pipefail; without it a
		// pg_dump failure is silently masked by gzip succeeding on empty input).
		// Self-delete the script file once done so /tmp doesn't fill up.
		const fireCmd = buildBackupFireCommand(path, id)

		// 30s timeout — only need enough for setsid + fire.
		const { stdout, stderr, code } = await runCommand(server, fireCmd, 30_000)
		if (code !== 0) {
			throw new Error(`failed to fire detached backup (exit ${code}): ${(stderr || stdout).slice(-500)}`)
		}

		// Row stays in `running` status. pollPendingBackups will finalize it
		// on a future tick when the script writes the status file.
		return row
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'unknown error'
		if (scriptPath) await runCommand(server, backupScriptRemoveCommand(scriptPath), 10_000).catch(() => {})
		// If we got far enough to initiate the multipart upload, release its
		// parts before marking the row failed, otherwise the store holds them
		// (and bills for them) until its own lifecycle policy expires them.
		if (uploadId) {
			await abortMultipart(cfg, s3Key, uploadId)
		}
		await db
			.update(appBackups)
			.set({ status: 'failed', finishedAt: new Date(), error: safeSlice(redactSecrets(msg), 0, 1000) })
			.where(eq(appBackups.id, id))
		void reportCronToHq({
			job: `backup:${repo.containerName}`,
			server: repo.serverId,
			status: 'failure',
			error: safeSlice(redactSecrets(msg), 0, 300),
		})
		// No backup_failed notification for a server powder never reached: during an
		// outage that would fire every hour per app. The ssh probe, the BLIND
		// watchers and the 36h backup-stale alarm already cover a dark server.
		if (!isConnectFailure({ status: 'failed', error: msg })) {
			notifyBackupFailed(repo.serverId, repo.containerName, msg, repo.id)
		}
		throw err
	}
}


// Reads status files for all in-flight backups and finalizes the DB row when
// the script reports done. Called on every backup tick before firing new ones.
//
// Reaping. The poll also asks the server whether the detached
// script is still ALIVE, instead of a blind 8h clock:
//   - script DEAD but status still running/missing → it died without writing a
//     terminal status (reboot, OOM-kill) → reap now (after a short grace).
//   - script ALIVE → leave it alone until its presigned URLs expire (24h); past
//     that it cannot succeed → kill its process group, then reap. Reaping a row
//     whose script still runs would let the next tick fire a SECOND pg_dump next
//     to it on the same server (multi-GB dumps).
//   - server unreachable / liveness unknown → fall back to the 8h clock.
// Every reap reports to HQ, so a reaped row does not wait for the 36h staleness
// alarm.
const STUCK_AFTER_HOURS = 8
const DEAD_GRACE_MS = 10 * 60 * 1000
const ALIVE_LIMIT_MS = PART_URL_EXPIRY_SECONDS * 1000
// Past this a run cannot succeed (its part URLs expired), so it no longer holds
// the app's in-flight slot (runBackupForApp reaps it).
const STALE_IN_FLIGHT_MS = ALIVE_LIMIT_MS

async function reapBackup(
	bkp: AppBackup,
	reason: string,
	server: Awaited<ReturnType<typeof getServer>> | null,
	kill: boolean,
): Promise<void> {
	if (server) {
		if (kill) await runCommand(server, buildKillCommand(bkp.id), 15_000).catch(() => {})
		await runCommand(
			server,
			backupCleanupCommand(bkp.id),
			5_000,
		).catch(() => {})
	}
	// Release the multipart parts, or the store holds (and bills for) them until
	// its own lifecycle policy expires them.
	if (bkp.s3UploadId) {
		const cfg = await loadConfigForServer(bkp.serverId)
		if (cfg) await abortMultipart(cfg, bkp.s3Key, bkp.s3UploadId)
	}
	await db
		.update(appBackups)
		.set({ status: 'failed', finishedAt: new Date(), error: `[watchdog] ${reason}` })
		.where(eq(appBackups.id, bkp.id))
	console.warn(`[backup] watchdog reaped ${bkp.containerName}/${bkp.id}: ${reason}`)
	void reportCronToHq({
		job: `backup:${bkp.containerName}`,
		server: bkp.serverId,
		status: 'failure',
		error: safeSlice(redactSecrets(`[watchdog] ${reason}`), 0, 300),
	})
	notifyBackupFailed(bkp.serverId, bkp.containerName, `[watchdog] ${reason}`)
}

// Target notification (lib/notifications.ts) for a backup row that just went
// to 'failed'. Fire and forget; HQ reporting above is separate.
function notifyBackupFailed(serverId: string, containerName: string, error: string, appRepoId?: string): void {
	void notify('backup_failed', {
		app: containerName,
		server: serverId,
		appRepoId,
		message: redactSecrets(`backup failed: ${error.slice(0, 300)}`),
	})
}

/**
 * The retention pool a successful backup prunes: its own source, with that
 * source's keep floor. Scheduled and manual backups are counted and pruned
 * separately, so manual ones (a token can trigger those) never push scheduled
 * ones out and scheduled ones never push manual ones out. null for an unknown
 * source: nothing is pruned.
 */
export function retentionPoolFor(bkp: Pick<AppBackup, 'source'>): { source: BackupSource; keep: number } | null {
	if (bkp.source === 'scheduled') return { source: 'scheduled', keep: KEEP_PER_APP }
	if (bkp.source === 'manual') return { source: 'manual', keep: KEEP_MANUAL_PER_APP }
	return null
}

async function markBackupSuccess(
	bkp: AppBackup,
	parsed: ReturnType<typeof parseStatusFile>,
): Promise<void> {
	await db
		.update(appBackups)
		.set({
			status: 'success',
			finishedAt: parsed.finishedAt ?? new Date(),
			sizeBytes: parsed.size ?? null,
			sha256: parsed.sha256 ?? null,
		})
		.where(eq(appBackups.id, bkp.id))
	// Close any open backup / backup-stale failure for this app at the ops
	// endpoint (POWDER_HQ_*). heartbeat:false: reportStaleBackups is the
	// staleness alarm; a per-app heartbeat would double it and outlive a
	// removed app. Nothing is sent when nothing was open.
	for (const job of [`backup:${bkp.containerName}`, `backup-stale:${bkp.containerName}`]) {
		void reportCronToHq({ job, server: bkp.serverId, status: 'success', heartbeat: false })
	}
	// Retention: a fresh success just landed, so pruning its own pool past that
	// pool's keep floor is safe. A manual success prunes manual rows only (a
	// token may trigger those, backups is in TOKEN_ROUTES), a scheduled one
	// scheduled rows only. Failure here never fails the backup.
	const pool = retentionPoolFor(bkp)
	if (!pool) return
	await pruneBackupsForApp(bkp.serverId, bkp.containerName, pool.source, pool.keep, false, false).catch((err) =>
		console.warn(`[backup-prune] ${bkp.containerName} sweep failed:`, err),
	)
}

export async function pollPendingBackups(): Promise<void> {
	// Poll both 'running' (script hasn't reported back) and 'uploaded_pending_complete'
	// (script done, powder owes S3 a CompleteMultipartUpload call — retry on
	// next tick if a previous attempt crashed).
	const pending = await db
		.select()
		.from(appBackups)
		.where(
			or(
				eq(appBackups.status, 'running'),
				eq(appBackups.status, 'uploaded_pending_complete'),
			),
		)

	for (const bkp of pending) {
		const ageMs = Date.now() - bkp.startedAt.getTime()
		const isStuck = ageMs > STUCK_AFTER_HOURS * 60 * 60 * 1000

		const server = await getServer(bkp.serverId)
		if (!server) {
			if (isStuck) await reapBackup(bkp, 'server not registered', null, false)
			continue
		}

		try {
			// One SSH: status file (<1 KB) + whether the script process is alive.
			let out: string
			let alive: boolean | null
			try {
				const res = await runCommand(server, buildPollCommand(bkp.id), 15_000)
				if (res.code !== 0) throw new Error(`poll exit ${res.code}`)
				;({ status: out, alive } = splitPollOutput(res.stdout))
			} catch (err) {
				// Server unreachable. Can't see the script, so only the clock can decide.
				if (isStuck) {
					const msg = err instanceof Error ? err.message : String(err)
					await reapBackup(
						bkp,
						`server unreachable for ${STUCK_AFTER_HOURS}h+ (${msg.slice(0, 120)})`,
						null,
						false,
					)
				}
				continue
			}

			const parsed = out === 'MISSING' ? null : parseStatusFile(out)
			if (!parsed || parsed.status === 'running' || parsed.status === null) {
				const what = parsed ? `status 'running'` : 'no status file'
				if (alive === false && ageMs > DEAD_GRACE_MS) {
					await reapBackup(bkp, `script exited with ${what} (died mid-run)`, server, false)
				} else if (alive === true && ageMs > ALIVE_LIMIT_MS) {
					await reapBackup(
						bkp,
						`script still running after ${PART_URL_EXPIRY_SECONDS / 3600}h (presigned URLs expired) — killed`,
						server,
						true,
					)
				} else if (alive === null && isStuck) {
					await reapBackup(bkp, `${what} after ${STUCK_AFTER_HOURS}h`, server, true)
				}
				continue
			}

			if (parsed.status === 'uploaded_pending_complete') {
				// Script finished all parts; powder owes S3 CompleteMultipartUpload.
				// Source of truth for uploadId is the DB column (set at initiate
				// time), with the status-file copy as belt-and-braces.
				const uploadId = bkp.s3UploadId ?? parsed.uploadId
				const cfg = await loadConfigForServer(bkp.serverId)
				if (!cfg || !uploadId || !parsed.parts || parsed.parts.length === 0) {
					// Release whatever we CAN identify before failing the row.
					if (cfg && uploadId) await abortMultipart(cfg, bkp.s3Key, uploadId)
					await db
						.update(appBackups)
						.set({
							status: 'failed',
							finishedAt: new Date(),
							error: 'pending_complete missing config/uploadId/parts',
							sizeBytes: parsed.size ?? null,
						})
						.where(eq(appBackups.id, bkp.id))
					notifyBackupFailed(bkp.serverId, bkp.containerName, 'pending_complete missing config/uploadId/parts')
					console.warn(
						`[backup] ✗ ${bkp.containerName}: pending_complete missing data — cfg=${!!cfg} uploadId=${!!uploadId} parts=${parsed.parts?.length ?? 0}`,
					)
				} else {
					try {
						await makeClient(cfg).completeMultipartUpload(
							cfg.bucket,
							bkp.s3Key,
							uploadId,
							parsed.parts,
						)
						await markBackupSuccess(bkp, parsed)
						console.log(
							`[backup] ✓ ${bkp.containerName} (${parsed.size ?? '?'} bytes, ${parsed.parts.length} parts, sha256 ${parsed.sha256 ?? 'none'})`,
						)
					} catch (err) {
						// Complete can fail because parts disappeared (TTL expired,
						// orphaned-multipart janitor swept them, etc) — OR because the
						// complete actually LANDED and only the response was lost
						// (network blip, or an earlier tick already completed it).
						// Blind mark-failed+abort in the second case orphaned a GOOD
						// object behind a failed row. HEAD the object first: if it
						// exists AND its size is the size this script uploaded, the
						// backup is real: record success. Existence alone is not proof
						// (an old-format key could hold another app's object).
						const msg = err instanceof Error ? err.message : 'unknown'
						const stat = await makeClient(cfg)
							.statObject(cfg.bucket, bkp.s3Key)
							.catch(() => null)
						const landed = landedObjectMatches(stat, parsed.size)
						if (landed) {
							console.warn(
								`[backup] complete errored for ${bkp.containerName} (${msg}) but the object EXISTS with the expected size, recording success`,
							)
							await markBackupSuccess(bkp, parsed)
						} else {
							console.warn(`[backup] complete failed for ${bkp.containerName}: ${msg}`)
							await abortMultipart(cfg, bkp.s3Key, uploadId)
							await db
								.update(appBackups)
								.set({
									status: 'failed',
									finishedAt: new Date(),
									error: safeSlice(redactSecrets(`complete_failed: ${msg}`), 0, 1000),
									sizeBytes: parsed.size ?? null,
								})
								.where(eq(appBackups.id, bkp.id))
							notifyBackupFailed(bkp.serverId, bkp.containerName, `complete_failed: ${msg}`)
						}
					}
				}
			} else if (parsed.status === 'success') {
				// Single-PUT status. The backup script emits
				// 'uploaded_pending_complete' (multipart); a plain 'success' status
				// is still finalized here so such a row never stays running.
				await markBackupSuccess(bkp, parsed)
				console.log(`[backup] ✓ ${bkp.containerName} (${parsed.size ?? '?'} bytes)`)
			} else if (parsed.status === 'failed') {
				// Script reported failure. If it got far enough to hold an upload,
				// release the parts before marking the row failed.
				const uploadId = bkp.s3UploadId ?? parsed.uploadId
				if (uploadId) {
					const cfg = await loadConfigForServer(bkp.serverId)
					if (cfg) await abortMultipart(cfg, bkp.s3Key, uploadId)
				}
				await db
					.update(appBackups)
					.set({
						status: 'failed',
						finishedAt: parsed.finishedAt ?? new Date(),
						error: safeSlice(redactSecrets(parsed.error || 'unknown'), 0, 1000),
						sizeBytes: parsed.size ?? null,
					})
					.where(eq(appBackups.id, bkp.id))
				console.warn(`[backup] ✗ ${bkp.containerName}: ${parsed.error}`)
				// Report dump/upload failures to the ops endpoint (POWDER_HQ_*). They
				// are finalized here, not in the dispatch catch in runBackupForApp, so
				// this is the only place that reports them. reportCronToHq
				// fingerprints per job: one alert per app per day, so retries don't spam.
				void reportCronToHq({
					job: `backup:${bkp.containerName}`,
					server: bkp.serverId,
					status: 'failure',
					error: safeSlice(redactSecrets(parsed.error || 'unknown'), 0, 300),
				})
				notifyBackupFailed(bkp.serverId, bkp.containerName, parsed.error || 'unknown')
			}

			// Cleanup files on the server now that DB is updated.
			await runCommand(
				server,
				backupCleanupCommand(bkp.id),
				5_000,
			).catch(() => {})
		} catch (err) {
			console.error(`[backup-poll] ${bkp.containerName} read failed:`, err)
		}
	}
	// After the pass above, so rows it just failed are cleaned in the same tick.
	await abortDanglingUploads().catch((err) =>
		console.warn('[backup] dangling upload cleanup failed:', err instanceof Error ? err.message : err),
	)
}

// Cron-friendly wrapper, called hourly by cron-scheduler. Fires a backup for
// every postgres app that isDueBackup() (23h after a success; exponential
// backoff after consecutive failures, see backup-logic.ts). Detached execution
// means each runBackupForApp returns in seconds; the dump + upload run on the
// app servers.
//
// Hang-proofing: without a deadline on the tick, one hung
// await (the pool-starvation class that can stall the worker) leaves
// tickRunning=true forever: no more backups AND, since the staleness check
// runs inside the same tick, no alarm either. Now:
//   - the tick races a TICK_TIMEOUT_MS deadline; on timeout it reports to HQ
//     and releases the guard. A generation counter stops a hung tick that
//     later wakes up from firing backups next to its successor.
//   - the staleness check runs on its own guard + deadline. It runs AFTER the
//     fire step (in the tick's finally, so also after a deadline or a throw),
//     never before it: a check started before the fire step reads app_backups
//     before this tick's first-ever backup row exists, and alerts "NO successful
//     backup on record" for an app whose first backup starts the same second.
//     When a previous tick still holds the guard, this tick runs the check at
//     once, so a stuck tick can't silence it. backup-stale-order.db.test.ts fails if the check moves back
//     in front of the fire step.
const TICK_TIMEOUT_MS = 30 * 60 * 1000
const STALE_CHECK_TIMEOUT_MS = 5 * 60 * 1000
let tickRunning = false
let tickGeneration = 0
let staleCheckRunning = false

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms / 60000} min`)), ms)
	})
	return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

export async function backupTick(): Promise<void> {
	if (!isBackupConfigured()) return

	if (tickRunning) {
		console.log('[backup] tick already running, skipping')
		// The running tick may be stuck: check staleness now, not after it.
		await runStaleCheck()
		return
	}
	tickRunning = true
	const gen = ++tickGeneration
	try {
		await withDeadline(runBackupTick(gen), TICK_TIMEOUT_MS, 'backup tick')
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		console.error('[backup] tick failed:', msg)
		void reportCronToHq({
			job: 'backup-tick',
			server: 'powder',
			status: 'failure',
			error: safeSlice(redactSecrets(msg), 0, 300),
		})
	} finally {
		tickRunning = false
		// After the fire step, so this tick's new rows are visible to the check.
		await runStaleCheck()
	}
}

async function runBackupTick(gen: number): Promise<void> {
	// Step 1: finalize any in-flight detached backups from previous ticks, and
	// any restore/verify nobody is watching in the dashboard.
	await pollPendingBackups()
	// Dynamic import: backup-restore.ts imports this module (no static cycle).
	await import('./backup-restore')
		.then((m) => m.pollPendingRestores())
		.catch((err) =>
			console.warn('[restore-poll] failed:', err instanceof Error ? err.message : err),
		)
	if (gen !== tickGeneration) return

	// Step 2: fire new backups for apps due for one.
	const repos = await db.select().from(appRepos).where(eq(appRepos.hasPostgres, true))
	for (const repo of repos) {
		// A newer tick took over (this one blew its deadline) — stop firing.
		if (gen !== tickGeneration) return
		const history = await db
			.select({ startedAt: appBackups.startedAt, status: appBackups.status, error: appBackups.error })
			.from(appBackups)
			.where(
				and(
					eq(appBackups.serverId, repo.serverId),
					eq(appBackups.containerName, repo.containerName),
				),
			)
			.orderBy(desc(appBackups.startedAt))
			.limit(10)
		if (!isBackupDue(history, Date.now())) continue

		try {
			await runBackupForApp(repo, { source: 'scheduled' })
			console.log(`[backup] fired ${repo.containerName}`)
		} catch (err) {
			console.error(
				`[backup] ✗ failed to fire ${repo.containerName}:`,
				err instanceof Error ? err.message : err,
			)
		}
	}
}

async function runStaleCheck(): Promise<void> {
	if (staleCheckRunning) return
	staleCheckRunning = true
	try {
		const repos = await withDeadline(
			db.select().from(appRepos).where(eq(appRepos.hasPostgres, true)),
			STALE_CHECK_TIMEOUT_MS,
			'backup stale check (repos)',
		)
		await withDeadline(reportStaleBackups(repos), STALE_CHECK_TIMEOUT_MS, 'backup stale check')
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		console.error('[backup] stale check failed:', msg)
		void reportCronToHq({
			job: 'backup-stale-check',
			server: 'powder',
			status: 'failure',
			error: safeSlice(redactSecrets(msg), 0, 300),
		})
	} finally {
		staleCheckRunning = false
	}
}

// Staleness alert. Individual failures retry (with backoff) and aren't worth
// paging on; what matters is an app whose backups have gone dark — no SUCCESS
// within STALE_BACKUP_HOURS means restore-when-you-need-it is broken. Checks
// the source of truth (hasPostgres apps), so it catches both active failures
// and apps that silently stopped attempting. reportCronToHq fingerprints per
// job → one alert/app/day.
//
// 36h, not 26h: backups run on a ~daily cadence and the schedule drifts a few
// hours (big DBs upload in many parts and take longer). 26h gave
// only 2h slack and false-alarmed on normal drift; 36h still catches a fully
// missed day.
const STALE_BACKUP_HOURS = 36

async function reportStaleBackups(repos: AppRepo[]): Promise<void> {
	const cutoff = Date.now() - STALE_BACKUP_HOURS * 60 * 60 * 1000
	for (const repo of repos) {
		const [lastOk] = await db
			.select({ startedAt: appBackups.startedAt })
			.from(appBackups)
			.where(
				and(
					eq(appBackups.serverId, repo.serverId),
					eq(appBackups.containerName, repo.containerName),
					eq(appBackups.status, 'success'),
				),
			)
			.orderBy(desc(appBackups.startedAt))
			.limit(1)
		const okMs = lastOk?.startedAt.getTime()
		if (okMs && okMs > cutoff) continue // healthy — a recent success
		// Stale or never-succeeded. Suppress ONLY the genuine first-backup case: a
		// just-registered app whose first-EVER backup is still in flight (no success
		// AND no failure on record). Skipping ANY app with an in-flight backup is
		// wrong: a chronically FAILING app re-fires a 'running' row every tick, so it
		// would hide behind its own retry forever. A
		// stale-success or ever-failed app must still alert even while a retry runs.
		if (!okMs) {
			const [inflight] = await db
				.select({ id: appBackups.id })
				.from(appBackups)
				.where(
					and(
						eq(appBackups.serverId, repo.serverId),
						eq(appBackups.containerName, repo.containerName),
						inArray(appBackups.status, ['running', 'uploaded_pending_complete']),
					),
				)
				.limit(1)
			if (inflight) {
				const [everFailed] = await db
					.select({ id: appBackups.id })
					.from(appBackups)
					.where(
						and(
							eq(appBackups.serverId, repo.serverId),
							eq(appBackups.containerName, repo.containerName),
							eq(appBackups.status, 'failed'),
						),
					)
					.limit(1)
				if (!everFailed) continue // truly first backup, mid-flight — not stale
			}
		}
		const detail = okMs
			? `last successful backup ${Math.round((Date.now() - okMs) / 3.6e6)}h ago`
			: `NO successful backup on record`
		void reportCronToHq({
			job: `backup-stale:${repo.containerName}`,
			server: repo.serverId,
			status: 'failure',
			error: redactSecrets(`${repo.containerName}: ${detail} (threshold ${STALE_BACKUP_HOURS}h) - restore is not guaranteed`),
		})
		// Hourly check; notify() holds backup_stale to one alert per app per 23h.
		void notify('backup_stale', {
			app: repo.containerName,
			server: repo.serverId,
			appRepoId: repo.id,
			message: redactSecrets(`${detail} (threshold ${STALE_BACKUP_HOURS}h), restore is not guaranteed`),
		})
	}
}

export async function listBackupsForApp(
	serverId: string,
	containerName: string,
	limit = 60,
): Promise<AppBackup[]> {
	// Pruned rows are hidden: their S3 object is gone, so showing them in the
	// dashboard would offer restores that can't happen.
	return db
		.select()
		.from(appBackups)
		.where(
			and(
				eq(appBackups.serverId, serverId),
				eq(appBackups.containerName, containerName),
				isNull(appBackups.prunedAt),
			),
		)
		.orderBy(desc(appBackups.startedAt))
		.limit(limit)
}

/**
 * Manual backup rows of this app started in the last `windowMs` (any status),
 * and when the oldest of them started. Read from the DB so a restart does not
 * reset the daily cap on manual triggers (app/api/projects/[id]/backups).
 */
export async function recentManualBackups(
	serverId: string,
	containerName: string,
	windowMs: number,
	now = Date.now(),
): Promise<{ count: number; oldestAt: Date | null }> {
	const rows = await db
		.select({ startedAt: appBackups.startedAt })
		.from(appBackups)
		.where(
			and(
				eq(appBackups.serverId, serverId),
				eq(appBackups.containerName, containerName),
				eq(appBackups.source, 'manual'),
				gte(appBackups.startedAt, new Date(now - windowMs)),
			),
		)
		.orderBy(appBackups.startedAt)
	return { count: rows.length, oldestAt: rows[0]?.startedAt ?? null }
}

// ── Retention (keep-N-per-app) ───────────────────────────────────────────────
// Keep the newest KEEP_PER_APP successful scheduled backups per app, and the
// newest KEEP_MANUAL_PER_APP manual ones, plus older ones while too few of the
// kept ones are "sizeable" (planRetention in backup-logic.ts: tiny successful
// dumps can't push out the real ones); delete older objects from S3 and stamp
// their rows pruned_at (row stays as history). Runs right after a backup
// succeeds in pollPendingBackups, over that backup's own pool only (scheduled or
// manual, see retentionPoolFor), so the retained count of a pool never drops
// below its keep floor, and an app whose backups stop succeeding is never
// pruned further. Without it nothing expires the objects and they pile up.
const KEEP_PER_APP = Math.max(1, Number(process.env.BACKUP_KEEP_PER_APP) || 7)
const KEEP_MANUAL_PER_APP = Math.max(1, Number(process.env.BACKUP_KEEP_MANUAL_PER_APP) || 3)

export interface PruneResult {
	server: string
	app: string
	// The retention pool these numbers are for: every prune counts one pool only.
	pool: BackupSource
	kept: number
	// Kept beyond the keep floor because newer backups look too small (size guard).
	held: number
	pruned: number
	freedBytes: number
	errors: number
}

/**
 * Prune one retention pool of one app. The pool is required: rows of the other
 * source are never counted or pruned, so manual backups can never push
 * scheduled ones out (or the reverse). To sweep both pools use
 * pruneBackupPools.
 */
export async function pruneBackupsForApp(
	serverId: string,
	containerName: string,
	pool: BackupSource,
	keep: number,
	dryRun = false,
	// Bypass the size guard (plain keep-newest-N). Admin-only via the prune
	// route, for after a legitimate >50% DB shrink.
	force = false,
): Promise<PruneResult> {
	const rows = await db
		.select()
		.from(appBackups)
		.where(
			and(
				eq(appBackups.serverId, serverId),
				eq(appBackups.containerName, containerName),
				eq(appBackups.status, 'success'),
				isNull(appBackups.prunedAt),
				eq(appBackups.source, pool),
			),
		)
		.orderBy(desc(appBackups.startedAt))

	// a keep that is not a finite number keeps everything (never "prune all").
	const floor = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : Math.max(1, rows.length)
	const plan = force
		? { keep: rows.slice(0, floor), prune: rows.slice(floor), held: 0 }
		: planRetention(rows, floor)
	const result: PruneResult = {
		server: serverId,
		app: containerName,
		pool,
		kept: plan.keep.length,
		held: plan.held,
		pruned: 0,
		freedBytes: 0,
		errors: 0,
	}
	if (!dryRun && !force && newestLooksShrunk(rows)) {
		// The newest "successful" backup is under half its predecessors — an
		// empty/wrong DB dumping cleanly looks exactly like this. Retention is
		// already holding the older sizeable dumps; say so out loud.
		const [newest] = rows
		void reportCronToHq({
			job: `backup-size:${containerName}`,
			server: serverId,
			status: 'failure',
			error: safeSlice(redactSecrets(`${containerName}: newest backup ${newest?.sizeBytes ?? '?'} bytes is <50% of recent backups - wrong/empty DB? older backups are held from pruning (${plan.held} extra); prune with force after a legitimate shrink`), 0, 300),
		})
	}
	if (plan.prune.length === 0) return result

	const cfg = await loadConfigForServer(serverId)
	if (!cfg) {
		result.errors = plan.prune.length
		return result
	}
	const client = makeClient(cfg)
	// Keys still referenced by any other unpruned row (this app's kept rows, or
	// another app whose old-format key collided). Those objects are not ours
	// alone to delete: stamp the row pruned, leave the object.
	const pruneIds = new Set(plan.prune.map((r) => r.id))
	const pruneKeys = [...new Set(plan.prune.map((r) => r.s3Key))]
	const refRows = pruneKeys.length
		? await db
				.select({ id: appBackups.id, s3Key: appBackups.s3Key })
				.from(appBackups)
				.where(and(inArray(appBackups.s3Key, pruneKeys), isNull(appBackups.prunedAt)))
		: []
	for (const row of plan.prune) {
		const otherRefs = new Set(
			refRows.filter((r) => r.id !== row.id && !pruneIds.has(r.id)).map((r) => r.s3Key),
		)
		if (dryRun) {
			result.pruned++
			result.freedBytes += row.sizeBytes ?? 0
			continue
		}
		try {
			// removeObject is idempotent (no error for an already-gone key), so a
			// crash between delete and the DB stamp self-heals on the next pass.
			if (canDeleteObject(row.s3Key, otherRefs)) {
				await client.removeObject(cfg.bucket, row.s3Key)
			} else {
				console.warn(
					`[backup-prune] ${containerName}: ${row.s3Key} is still referenced by another backup row, not deleting the object`,
				)
			}
			await db
				.update(appBackups)
				.set({ prunedAt: new Date() })
				.where(eq(appBackups.id, row.id))
			result.pruned++
			result.freedBytes += row.sizeBytes ?? 0
		} catch (err) {
			// pruned_at stays null → retried after the app's next successful backup.
			result.errors++
			console.warn(
				`[backup-prune] ${containerName}: removeObject(${row.s3Key}) failed:`,
				err instanceof Error ? err.message : err,
			)
		}
	}
	if (!dryRun && result.pruned > 0) {
		console.log(
			`[backup-prune] ${containerName}: pruned ${result.pruned} old ${pool} backup(s), freed ${result.freedBytes} bytes, kept ${result.kept}${result.held ? ` (${result.held} held by size guard)` : ''}`,
		)
	}
	return result
}

/**
 * Prune both retention pools of one app, each on its own: scheduled backups at
 * scheduledKeep (default BACKUP_KEEP_PER_APP), manual ones at
 * BACKUP_KEEP_MANUAL_PER_APP. One result per pool, scheduled first. The admin
 * prune route uses this, so an explicit keep never counts manual rows against
 * scheduled ones.
 */
export async function pruneBackupPools(
	serverId: string,
	containerName: string,
	opts: { scheduledKeep?: number; dryRun?: boolean; force?: boolean } = {},
): Promise<PruneResult[]> {
	const dryRun = opts.dryRun ?? false
	const force = opts.force ?? false
	return [
		await pruneBackupsForApp(serverId, containerName, 'scheduled', opts.scheduledKeep ?? KEEP_PER_APP, dryRun, force),
		await pruneBackupsForApp(serverId, containerName, 'manual', KEEP_MANUAL_PER_APP, dryRun, force),
	]
}
