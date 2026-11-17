// Pure halves of backup download / restore / verify / drop (backup-restore.ts
// does the DB, SSH and S3 parts). No DB/SSH imports, so the name guards and
// the shell builders are unit-tested directly.
//
// Format (backup-script.ts, read before changing anything here): a backup is
// a PLAIN-SQL pg_dump, gzipped, then `openssl enc -aes-256-cbc -pbkdf2 -salt`
// with POWDER_BACKUP_KEY as the passphrase. So the way back is
//   openssl enc -d -aes-256-cbc -pbkdf2 -pass file:<key> | gunzip | psql
// (psql, not pg_restore: there is no custom-format archive).
//
// Safety rule: the live database is never a target. Restore and verify create
// a NEW database named `<db>_restore_<yyyymmdd_hhmm>` (verify adds `_verify`)
// and refuse when it already exists; drop only accepts names of that shape,
// never the live name, never the name the app's DATABASE_URL points at.

import { randomBytes } from 'node:crypto'
import { assertCurlConfigSafeUrl, scriptPathPattern, selfDeleteLine } from './backup-script'
import { assertSafeName, shq } from './shell'
import { postgresToolImage } from './tool-images'
import { SIDE_RUN_CAPS } from './side-run'

// Postgres identifiers are cut at 63 bytes; a longer name would be silently
// truncated and could collide.
const PG_IDENT_MAX = 63

const RESTORE_DB_RE = /^[a-z0-9_]+_restore_\d{8}_\d{4}(_verify)?$/

/** UTC `yyyymmdd_hhmm`. */
function restoreStamp(at: Date): string {
	const p = (n: number) => String(n).padStart(2, '0')
	return `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}_${p(at.getUTCHours())}${p(at.getUTCMinutes())}`
}

/** `<db>_restore_<yyyymmdd_hhmm>` (+ `_verify`), lowercase, [a-z0-9_] only, max 63 chars. */
export function restoreDbName(sourceDb: string, at: Date, verify = false): string {
	const tail = `_restore_${restoreStamp(at)}${verify ? '_verify' : ''}`
	let base = sourceDb.toLowerCase().replace(/[^a-z0-9_]/g, '_')
	base = base.slice(0, PG_IDENT_MAX - tail.length)
	if (!base) base = 'db'
	return `${base}${tail}`
}

export function isRestoreDbName(name: string): boolean {
	return name.length <= PG_IDENT_MAX && RESTORE_DB_RE.test(name)
}

const sameDb = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Throws unless `target` is a restore-pattern name and not the live database. */
export function assertRestoreTarget(target: string, liveDb: string): string {
	if (!isRestoreDbName(target))
		throw new Error(`refusing: ${target} is not a restore database name`)
	if (sameDb(target, liveDb)) throw new Error(`refusing: ${target} is the live database`)
	return target
}

/** Drop guard: restore-pattern only, never the live db, never what DATABASE_URL uses. */
export function assertDroppable(target: string, liveDb: string, appUrlDb: string | null): string {
	assertRestoreTarget(target, liveDb)
	if (appUrlDb && sameDb(target, appUrlDb)) {
		throw new Error(`refusing: the app's DATABASE_URL points at ${target}; switch it back first`)
	}
	return target
}

/** Database name in a postgres URL, or null. */
export function dbNameFromUrl(url: string | null | undefined): string | null {
	if (!url) return null
	try {
		const name = decodeURIComponent(new URL(url.trim()).pathname.replace(/^\//, ''))
		return name || null
	} catch {
		return null
	}
}

/** The app's DATABASE_URL with only the database name swapped. Null if it does not parse. */
export function restoreDatabaseUrl(
	liveUrl: string | null | undefined,
	target: string,
): string | null {
	if (!liveUrl) return null
	try {
		const u = new URL(liveUrl.trim())
		if (!u.host) return null
		u.pathname = `/${target}`
		return u.toString()
	} catch {
		return null
	}
}

// ── Shell builders ───────────────────────────────────────────────────────────

export interface DbTarget {
	// The app's postgres container (backup_db_container or <app>-db).
	container: string
	user: string
	// The live database. Only used as the connection for catalog queries and
	// CREATE/DROP DATABASE (cluster-level statements); never written to.
	liveDb: string
	// True when backup_db_password_encrypted is set: psql gets PGPASSWORD from
	// "$PGPASS_FILE" (a 0600 env file), never from argv.
	withPassword: boolean
}

/** `docker exec [-i] [--env-file "$PGPASS_FILE"] '<c>' psql -X -U '<u>' -d '<db>' -v ON_ERROR_STOP=1`. */
export function psqlCmd(t: DbTarget, db: string, stdin = false): string {
	assertSafeName(t.container)
	return [
		'docker exec',
		stdin ? '-i' : '',
		t.withPassword ? '--env-file "$PGPASS_FILE"' : '',
		shq(t.container),
		'psql -X',
		`-U ${shq(t.user)}`,
		`-d ${shq(db)}`,
		'-v ON_ERROR_STOP=1',
	]
		.filter(Boolean)
		.join(' ')
}

export interface RestoreScriptOpts {
	id: string
	mode: 'restore' | 'verify'
	db: DbTarget
	target: string
	// base64 of the passphrase and of the presigned GET URL (decoded into 0600
	// files inside the script, never put in argv).
	passB64: string
	urlB64: string
	// app_backups.sha256 of the ENCRYPTED object. The script downloads to a
	// 0600 file, checks it, and only then feeds psql. Null for a row
	// with no recorded hash (check skipped, logged).
	sha256: string | null
	// Lines that write "$PGPASS_FILE" (withPassword only).
	preLines: string[]
	statusFile: string
	lockFile: string
	// Size in bytes of the encrypted object (statObject). The download needs it
	// free on /var/tmp plus 10% headroom; null/undefined = unknown, check skipped.
	objectSize?: number | null
}

/** refuse before the download (and before creating the target
 *  database) when /var/tmp cannot hold the object plus 10% headroom. */
function diskSpaceCheck(objectSize: number | null | undefined): string[] {
	if (objectSize == null || !Number.isFinite(objectSize) || objectSize < 0)
		return ['echo "backup size unknown, free-space check skipped"']
	const needKb = Math.ceil((objectSize * 1.1) / 1024)
	return [
		`echo "── check free space on /var/tmp ──"`,
		`NEED_KB=${needKb}`,
		`FREE_KB=$(df -Pk /var/tmp 2>/dev/null | awk 'NR==2 {print $4}' || true)`,
		`if ! [[ "$FREE_KB" =~ ^[0-9]+$ ]]; then echo "could not read free space on /var/tmp, continuing"; elif [ "$FREE_KB" -lt "$NEED_KB" ]; then echo "not enough free space on /var/tmp: the backup needs $NEED_KB KiB (size + 10%), $FREE_KB KiB free. Free some space on the server and try again."; fail not_enough_disk_space_on_var_tmp; else echo "free space ok: $FREE_KB KiB free, $NEED_KB KiB needed"; fi`,
	]
}

/** restore status, log and lock files live in this root-only (0700) dir, not
 *  at predictable names in world-writable /var/tmp, where another local user could
 *  plant the status file (or a link at the log or lock path) first. */
export const RESTORE_STATE_DIR = '/var/lib/powder/restores'

export function restoreStatusFile(id: string): string {
	return `${RESTORE_STATE_DIR}/powder-restore-${id}.status`
}
export function restoreLogFile(id: string): string {
	return `${RESTORE_STATE_DIR}/powder-restore-${id}.log`
}
/** Status and log of a restore under /var/tmp, outside RESTORE_STATE_DIR. Powder never
 *  writes them; the poll reads them only when root owns the file and it is no symlink,
 *  and the cleanup removes them. */
function varTmpRestoreStatusFile(id: string): string {
	return `/var/tmp/powder-restore-${id}.status`
}
function varTmpRestoreLogFile(id: string): string {
	return `/var/tmp/powder-restore-${id}.log`
}
/** Shell: make RESTORE_STATE_DIR (0700), refusing a symlinked dir. Runs before the
 *  restore's fire command writes the log there. */
export function restoreStateDirShell(dir = RESTORE_STATE_DIR): string {
	return [
		`RS_P=${shq(dir)}`,
		`if [ -L "$RS_P" ]; then echo "restore: $RS_P is a symlink, refusing"; exit 1; fi`,
		`mkdir -p "$RS_P" && chmod 700 "$RS_P" || { echo "restore: cannot create $RS_P"; exit 1; }`,
	].join('\n')
}
/** Shell: remove the status and log of restore `id`, in the state dir and under /var/tmp. */
export function restoreCleanupCommand(id: string): string {
	return `rm -f ${shq(restoreStatusFile(id))} ${shq(restoreLogFile(id))} ${shq(varTmpRestoreStatusFile(id))} ${shq(varTmpRestoreLogFile(id))}`
}
const RESTORE_SCRIPT_DIR = '/tmp'
const restoreScriptName = (id: string) => `powder-restore-${id}`
/** a random suffix (the SFTP write creates it exclusively). */
export function restoreScriptPath(id: string): string {
	return `${RESTORE_SCRIPT_DIR}/${restoreScriptName(id)}.${randomBytes(8).toString('hex')}.sh`
}
/** pgrep -f pattern matching exactly the shape restoreScriptPath(id) builds,
 *  bracketed so it never matches the shell running the pgrep. */
export function restoreScriptPattern(id: string): string {
	return scriptPathPattern(RESTORE_SCRIPT_DIR, restoreScriptName(id), '\\.[0-9a-f]{16}\\.sh')
}
/** Shell glob for every restoreScriptPath of `id` (rm on kill). */
function restoreScriptGlob(id: string): string {
	return `${shq(`${RESTORE_SCRIPT_DIR}/${restoreScriptName(id)}.`)}*.sh`
}
/** Shell glob (case pattern) matching any restoreScriptPath. */
const RESTORE_SCRIPT_ANY = `${RESTORE_SCRIPT_DIR}/powder-restore-*.sh`
/** Shell: remove a restore script file (best effort; the script removes itself first). */
export function restoreScriptRemoveCommand(scriptPath: string): string {
	return `rm -f -- ${shq(scriptPath)}`
}
/** One restore per app per server at a time (flock -n). */
export function restoreLockFile(container: string): string {
	return `${RESTORE_STATE_DIR}/powder-restore-${assertSafeName(container)}.lock`
}

const B64 = /^[A-Za-z0-9+/=]*$/

// Detached script (same shape as backup-script.ts): status file + log file,
// ERR trap for every unplanned exit. Downloads the ENCRYPTED object to a 0600
// file in /var/tmp, checks its sha256 against app_backups.sha256 (a wrong or
// swapped object fails before psql runs), then decrypts that file through
// gunzip into psql; the plaintext dump never lands on disk. The download is
// removed on every exit. Created database is dropped again on failure
// (and always, for verify); only a database THIS script created, guarded by
// CREATED=1 and the pattern check at the top.
export function buildRestoreScript(o: RestoreScriptOpts): string {
	const target = assertRestoreTarget(o.target, o.db.liveDb)
	if (!B64.test(o.passB64) || !B64.test(o.urlB64)) throw new Error('payload must be base64')
	if (o.sha256 !== null && !/^[0-9a-f]{64}$/.test(o.sha256))
		throw new Error('sha256 must be 64 hex')
	// The URL file is a curl config (`curl -K`), so the presigned URL never
	// appears in curl's argv (world-readable /proc/<pid>/cmdline).
	const url = assertCurlConfigSafeUrl(Buffer.from(o.urlB64, 'base64').toString('utf8'))
	const curlCfgB64 = Buffer.from(`url = "${url}"\n`, 'utf8').toString('base64')
	const sf = shq(o.statusFile)
	const now = `"$(date -u +%Y-%m-%dT%H:%M:%SZ)"`
	const onLive = (sql: string) => `${psqlCmd(o.db, o.db.liveDb)} -tA -c ${shq(sql)}`
	const onTarget = (sql: string) => `${psqlCmd(o.db, target)} -tA -c ${shq(sql)}`
	const verify = o.mode === 'verify'
	return [
		selfDeleteLine(RESTORE_SCRIPT_ANY),
		'set -eo pipefail',
		`STATUS_FILE=${sf}`,
		`TARGET=${shq(target)}`,
		`LIVE=${shq(o.db.liveDb)}`,
		'CREATED=0',
		'PROG=',
		`trap 'rc=$?; printf "status=failed\\nerror=script_error_line_%s_exit_%s\\nfinished_at=%s\\n" "$LINENO" "$rc" ${now} > "$STATUS_FILE"; exit $rc' ERR`,
		`fail() { printf 'status=failed\\nerror=%s\\nfinished_at=%s\\n' "$1" ${now} > "$STATUS_FILE"; echo "✗ $1"; exit 1; }`,
		// Belt and braces: the TS guard already checked both.
		`[[ "$TARGET" =~ ^[a-z0-9_]+_restore_[0-9]{8}_[0-9]{4}(_verify)?$ ]] || fail target_not_restore_pattern`,
		`[ "$TARGET" != "$LIVE" ] || fail target_is_live_db`,
		// the EXIT cleanup is armed BEFORE the first mktemp/write, so a
		// failing mktemp or write never leaves the passphrase or URL file behind.
		'KEYFILE=',
		'URLFILE=',
		'DLFILE=',
		'cleanup() {',
		`  [ -n "$PROG" ] && kill "$PROG" 2>/dev/null || true`,
		`  rm -f "$KEYFILE" "$URLFILE" "$DLFILE" "\${PGPASS_FILE:-}"`,
		`  if [ "$CREATED" = 1 ]; then`,
		`    echo "── drop $TARGET ──"`,
		`    ${onLive(`DROP DATABASE IF EXISTS "${target}"`)} || echo "could not drop $TARGET, drop it from the dashboard"`,
		'  fi',
		'}',
		'trap cleanup EXIT',
		'KEYFILE=$(mktemp)',
		'URLFILE=$(mktemp)',
		'DLFILE=$(mktemp -p /var/tmp powder-restore-dl-XXXXXX.bin)',
		`chmod 600 "$KEYFILE" "$URLFILE" "$DLFILE"`,
		`printf '%s' '${o.passB64}' | base64 -d > "$KEYFILE"`,
		`printf '%s' '${curlCfgB64}' | base64 -d > "$URLFILE"`,
		...o.preLines,
		`printf 'status=running\\n' > ${sf}`,
		`exec 9>${shq(o.lockFile)}`,
		'flock -n 9 || fail another_restore_running_for_this_app',
		...diskSpaceCheck(o.objectSize),
		`echo "── check $TARGET does not exist ──"`,
		`EXISTS=$(${onLive(`SELECT 1 FROM pg_database WHERE datname = '${target}'`)})`,
		`[ -z "$EXISTS" ] || fail target_db_exists`,
		`echo "── create database $TARGET ──"`,
		`${onLive(`CREATE DATABASE "${target}"`)} > /dev/null`,
		'CREATED=1',
		`echo "── download ──"`,
		`if ! curl -fsS --max-time 86400 -o "$DLFILE" -K "$URLFILE"; then fail download_failed; fi`,
		...(o.sha256
			? [
					`GOT=$(sha256sum "$DLFILE" | cut -d' ' -f1)`,
					`if [ "$GOT" != ${shq(o.sha256)} ]; then echo "sha256 mismatch: got $GOT, expected ${o.sha256}"; fail sha256_mismatch; fi`,
					`echo "sha256 ok"`,
				]
			: [`echo "no sha256 recorded for this backup, integrity check skipped"`]),
		`echo "── decrypt, gunzip, psql into $TARGET ──"`,
		`( while sleep 15 > /dev/null 2>&1; do S=$(${onTarget('SELECT pg_size_pretty(pg_database_size(current_database()))')} 2>/dev/null || true); echo "restored so far: $S"; done ) &`,
		// sleep gets its own stdio so killing the loop does not leave an orphan holding the log open.
		'PROG=$!',
		`if ! { openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$KEYFILE" < "$DLFILE" | gunzip | ${psqlCmd(o.db, target, true)} -q > /dev/null; }; then`,
		'  fail decrypt_or_psql_failed',
		'fi',
		`kill "$PROG" 2>/dev/null || true`,
		'PROG=',
		`TABLES=$(${onTarget(`SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`)})`,
		`SIZE=$(${onTarget('SELECT pg_database_size(current_database())')})`,
		// only digits reach the status file (psql output from a restored dump, which
		// the dump's author controls, must not add status lines).
		`case "$TABLES" in ''|*[!0-9]*) TABLES='';; esac`,
		`case "$SIZE" in ''|*[!0-9]*) SIZE='';; esac`,
		`echo "restored: $TABLES tables, $SIZE bytes"`,
		// Restore keeps its database. Verify drops it here, before reporting
		// success, so a failed drop fails the verify instead of leaking a db.
		...(verify
			? [
					`echo "── drop throwaway $TARGET ──"`,
					`${onLive(`DROP DATABASE "${target}"`)} > /dev/null`,
				]
			: []),
		'CREATED=0',
		`printf 'status=success\\ntables=%s\\nsize=%s\\nfinished_at=%s\\n' "$TABLES" "$SIZE" ${now} > ${sf}`,
		`echo "✓ done"`,
	].join('\n')
}

const POLL_MARKER = '---powder-status---'
const LOG_MARKER = '---powder-log---'

/** ALIVE/DEAD, then the status file (or MISSING), then the log tail. */
export function buildRestorePollCommand(id: string, tailBytes = 16_384): string {
	const sf = shq(restoreStatusFile(id))
	const lf = shq(restoreLogFile(id))
	// a restore fired before the upgrade still writes to /var/tmp; read those
	// only when root owns them and they are no symlinks.
	const lsf = shq(varTmpRestoreStatusFile(id))
	const llf = shq(varTmpRestoreLogFile(id))
	const rootOwned = (f: string) =>
		`[ -f ${f} ] && [ ! -L ${f} ] && [ "$(stat -c %u ${f} 2>/dev/null)" = 0 ]`
	const tail = Math.max(1, Math.floor(tailBytes))
	return [
		`if pgrep -f ${shq(restoreScriptPattern(id))} >/dev/null; then echo ALIVE; else echo DEAD; fi`,
		`echo '${POLL_MARKER}'`,
		`if [ -f ${sf} ]; then cat ${sf}; elif ${rootOwned(lsf)}; then cat ${lsf}; else echo MISSING; fi`,
		`echo '${LOG_MARKER}'`,
		`if [ -f ${lf} ]; then tail -c ${tail} ${lf}; elif ${rootOwned(llf)}; then tail -c ${tail} ${llf}; fi`,
	].join('\n')
}

export function splitRestorePoll(out: string): {
	alive: boolean | null
	status: string
	log: string
} {
	const a = out.indexOf(POLL_MARKER)
	const b = out.indexOf(LOG_MARKER)
	if (a < 0 || b < a) return { alive: null, status: out.trim(), log: '' }
	const proc = out.slice(0, a).trim()
	return {
		alive: proc === 'ALIVE' ? true : proc === 'DEAD' ? false : null,
		status: out.slice(a + POLL_MARKER.length, b).trim(),
		log: out.slice(b + LOG_MARKER.length).replace(/^\n/, ''),
	}
}

export interface RestoreStatus {
	status: 'running' | 'success' | 'failed' | null
	error?: string
	tables?: number
	size?: number
	finishedAt?: Date
}

export function parseRestoreStatus(text: string): RestoreStatus {
	const out: RestoreStatus = { status: null }
	for (const line of text.split('\n')) {
		const i = line.indexOf('=')
		if (i < 0) continue
		const k = line.slice(0, i).trim()
		const v = line.slice(i + 1).trim()
		if (k === 'status' && (v === 'running' || v === 'success' || v === 'failed')) out.status = v
		else if (k === 'error') out.error = v
		else if (k === 'tables' && /^\d+$/.test(v)) out.tables = Number(v)
		else if (k === 'size' && /^\d+$/.test(v)) out.size = Number(v)
		else if (k === 'finished_at') {
			const d = new Date(v)
			if (!Number.isNaN(d.getTime())) out.finishedAt = d
		}
	}
	return out
}

// A drop runs inline with a 60s SSH cap. Past this it can only still be
// `running` because its process died (powder restart mid-call).
export const DROP_STALE_MS = 5 * 60 * 1000

/** A `running` drop row older than DROP_STALE_MS: orphaned, must be failed to free the app's slot. */
export function isStaleDrop(
	row: { kind: string; status: string; startedAt: Date },
	nowMs: number,
): boolean {
	return (
		row.kind === 'drop' &&
		row.status === 'running' &&
		nowMs - row.startedAt.getTime() > DROP_STALE_MS
	)
}

/** Kill the detached restore's process group (same as buildKillCommand for backups),
 *  then remove any script file of it still left in /tmp. */
export function buildRestoreKillCommand(id: string): string {
	return [
		`for P in $(pgrep -f ${shq(restoreScriptPattern(id))}); do`,
		`  G=$(ps -o pgid= -p "$P" | tr -d ' ')`,
		`  [ -n "$G" ] && kill -TERM -- "-$G" 2>/dev/null || true`,
		'done',
		`rm -f -- ${restoreScriptGlob(id)} 2>/dev/null`,
		'true',
	].join('\n')
}

/** Synchronous drop. No FORCE: postgres refuses while anything is connected to it. */
export function buildDropCommand(db: DbTarget, target: string, appUrlDb: string | null): string {
	const name = assertDroppable(target, db.liveDb, appUrlDb)
	return [
		'set -eo pipefail',
		`${psqlCmd(db, db.liveDb)} -tA -c ${shq(`DROP DATABASE IF EXISTS "${name}"`)}`,
		`echo "dropped ${name}"`,
	].join('\n')
}

/** The exact commands to fetch, check and open a downloaded backup on any machine. */
export function buildDownloadCommands(o: {
	url: string
	s3Key: string
	containerName: string
	sha256: string | null
	dbUser: string
	dbContainer: string
	newDb: string
}): string {
	const file = `${o.containerName}-${o.s3Key.split('/').pop() ?? 'backup.sql.gz.enc'}`
	const sql = file.replace(/\.gz\.enc$/, '')
	return [
		'# 1. download (the link expires; ask the dashboard for a new one if it did)',
		`curl -fSL -o ${shq(file)} ${shq(o.url)}`,
		...(o.sha256
			? [`# 2. check it: must print ${o.sha256}`, `sha256sum ${shq(file)}`]
			: ['# 2. (no sha256 recorded for this backup)']),
		'# 3. decrypt + decompress. Passphrase = POWDER_BACKUP_KEY, in a 0600 file. Needs OpenSSL 1.1.1+.',
		`openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/root/backup.key < ${shq(file)} | gunzip > ${shq(sql)}`,
		'# WARNING: the dump is produced by the app (its own database) and may contain psql',
		'# meta-commands (\\! runs a shell command). Never load it with psql on a host: use',
		"# powder's restore (dashboard), or load it only inside an isolated postgres container.",
		'# 4. plain SQL dump: load with psql (not pg_restore) into a NEW database in a throwaway',
		'#    postgres container with no network that sees only the .sql file (read-only):',
		`docker run -d --rm --name powder-dump-check --network none ${SIDE_RUN_CAPS} -e POSTGRES_HOST_AUTH_METHOD=trust -v "$PWD/"${shq(sql)}:/w/dump.sql:ro ${shq(postgresToolImage())}`,
		'until docker exec powder-dump-check pg_isready -q -U postgres -h 127.0.0.1; do sleep 1; done',
		`docker exec powder-dump-check createdb -U postgres ${shq(o.newDb)}`,
		`docker exec powder-dump-check psql -X -U postgres -v ON_ERROR_STOP=1 -d ${shq(o.newDb)} -f /w/dump.sql`,
		`#    look around: docker exec -it powder-dump-check psql -U postgres -d ${shq(o.newDb)}`,
		'#    done: docker rm -f powder-dump-check',
		'# or, on the app server, straight into a new database in its db container:',
		`docker exec ${shq(o.dbContainer)} createdb -U ${shq(o.dbUser)} ${shq(o.newDb)}`,
		`docker exec -i ${shq(o.dbContainer)} psql -X -U ${shq(o.dbUser)} -d ${shq(o.newDb)} -v ON_ERROR_STOP=1 < ${shq(sql)}`,
		'# delete the key file and the .sql when done',
	].join('\n')
}
