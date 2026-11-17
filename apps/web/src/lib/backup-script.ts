import { shq } from './shell'
import { RANDOM_TEMP_SUFFIX_ERE, randomTempPath } from './temp-path'
export { shq }
// Builds the detached bash script backups.ts fires on the app server.
// Pure string construction (no DB/SSH), so the script can be syntax-checked
// and exercised in tests.
//
// Stages: dump → gzip → encrypt to $DUMPFILE → VERIFY → sha256 → chunked
// multipart upload → status file. Every exit path writes a terminal status:
// explicit failures write their own error, anything else `set -e` catches is
// written by the ERR trap. (Before the trap, a failing dd/stat/mktemp — disk
// full — left status=running until the 8h watchdog.)
//
// VERIFY: the encryption is AES-256-CBC with no MAC, so
// nothing downstream can tell a truncated/corrupt object from a good one.
// Before uploading, the script decrypts + gunzips the whole file (gzip's CRC
// catches corruption) and requires pg_dump's closing
// "PostgreSQL database dump complete" trailer (catches a dump cut short in a
// way pipefail missed). Then sha256 of the ENCRYPTED file goes into the status
// file → app_backups.sha256, which restore-drill compares against the object
// it downloads. Cost: one extra read+decrypt+gunzip pass (a few minutes for
// multi-GB dumps), no format change: old backups restore exactly as before.

export const PART_SIZE_BYTES = 100 * 1024 * 1024

export interface BackupScriptOpts {
	dumpCmd: string
	// Pre-script lines (e.g. writing a 600-mode PGPASSWORD env file).
	preLines: string[]
	passB64: string
	urlsB64: string
	uploadId: string
	/** Fixed status file path (tests). Unset (production): the script writes
	 *  `$1/status`, $1 being the per-backup dir the fire command made with mktemp -d. */
	statusFile?: string
	maxParts: number
}

/** per-backup state (status + log) lives in a `mktemp -d` dir under this
 *  root-only (0700) directory, not at a predictable name in world-writable /var/tmp
 *  where another local user could plant the status file first. */
const BACKUP_STATE_DIR = '/var/lib/powder/backups'

/** Shell: set BK_D to the state dir of backup `id` (empty when there is none). */
function backupDirShell(id: string, parent: string): string {
	return `BK_D=$(ls -d ${shq(`${parent}/${id}.`)}* 2>/dev/null | head -n 1)`
}

/** Shell: remove the state of backup `id`: its dir, and its /var/tmp files. */
export function backupCleanupCommand(id: string, parent = BACKUP_STATE_DIR): string {
	return `rm -rf -- ${shq(`${parent}/${id}.`)}* 2>/dev/null; rm -f ${shq(varTmpStatusFile(id))} ${shq(`/var/tmp/powder-backup-${id}.log`)}`
}

/** A backup status file under /var/tmp, outside the state dir. Powder never writes
 *  it; the poll reads it only when the backup has no state dir, and only when the file
 *  is root's and no symlink (not a planted one). */
export function varTmpStatusFile(id: string): string {
	return `/var/tmp/powder-backup-${id}.status`
}

/** `s` as a literal inside a POSIX extended regex (pgrep -f). */
function ereLiteral(s: string): string {
	return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

/** ERE matching exactly the paths `randomTempPath(dir/name)` + ext builds
 *  (`<dir>/<name>.tmp.<16 hex><ext>`), for pgrep -f. The first character of
 *  `name` goes in brackets so the pattern never matches the shell running the
 *  pgrep: its cmdline holds the literal `[p]...`, which the regex does not. */
function randomTempPathPattern(dir: string, name: string, ext: string): string {
	return scriptPathPattern(dir, name, `${RANDOM_TEMP_SUFFIX_ERE}${ereLiteral(ext)}`)
}

/** ERE for `<dir>/<name>` followed by `tailEre`, first character of `name`
 *  bracketed (see randomTempPathPattern). */
export function scriptPathPattern(dir: string, name: string, tailEre: string): string {
	return `${ereLiteral(`${dir}/`)}[${name[0]}]${ereLiteral(name.slice(1))}${tailEre}`
}

/** Shell: the first line of a detached script. It deletes its own file (bash
 *  keeps the open fd), so the secrets in it never outlive a kill or a crash.
 *  Only a file at the shape `glob` names, so running the script another way
 *  (bash -c, a test copy) never deletes anything else. */
export function selfDeleteLine(glob: string): string {
	return `case "$0" in ${glob}) rm -f -- "$0";; esac`
}

const BACKUP_SCRIPT_DIR = '/tmp'
const backupScriptName = (id: string) => `powder-backup-${id}`
/** Where the backup script of `id` is written on the server: random per call. */
export function backupScriptPath(id: string): string {
	return `${randomTempPath(`${BACKUP_SCRIPT_DIR}/${backupScriptName(id)}`)}.sh`
}
/** pgrep -f pattern for a backup script at backupScriptPath(id). */
export function backupScriptPattern(id: string): string {
	return randomTempPathPattern(BACKUP_SCRIPT_DIR, backupScriptName(id), '.sh')
}
/** Shell glob for every backup script path of `id` (rm on kill). */
function backupScriptGlob(id: string): string {
	return `${shq(`${BACKUP_SCRIPT_DIR}/${backupScriptName(id)}.tmp.`)}*.sh`
}
/** Shell glob (case pattern) matching any backupScriptPath. */
const BACKUP_SCRIPT_ANY = `${BACKUP_SCRIPT_DIR}/powder-backup-*.tmp.*.sh`
/** Shell: remove a backup script file (best effort; the script removes itself first). */
export function backupScriptRemoveCommand(scriptPath: string): string {
	return `rm -f -- ${shq(scriptPath)}`
}

// Presigned URLs go to curl through a 0600 config file (`curl -K`), never argv:
// any local user can read /proc/<pid>/cmdline for the whole transfer. curl's
// config syntax treats `"` and `\` specially inside a quoted value, so refuse
// those (S3 presigned URLs never contain them) rather than escape them.
export function assertCurlConfigSafeUrl(url: string): string {
	if (/["\\\r\n]/.test(url)) throw new Error('presigned URL has characters curl -K cannot carry')
	return url
}

export function buildBackupScript(o: BackupScriptOpts): string {
	for (const u of Buffer.from(o.urlsB64, 'base64').toString('utf8').split('\n')) {
		assertCurlConfigSafeUrl(u)
	}
	const sf = '"$STATUS_FILE"'
	const uid = shq(o.uploadId)
	const now = `"$(date -u +%Y-%m-%dT%H:%M:%SZ)"`
	const partMiB = PART_SIZE_BYTES / (1024 * 1024)
	return [
		selfDeleteLine(BACKUP_SCRIPT_ANY),
		`set -eo pipefail`,
		o.statusFile !== undefined
			? `STATUS_FILE=${shq(o.statusFile)}`
			: `[ -n "\${1:-}" ] && [ -d "$1" ] && [ ! -L "$1" ] || { echo "backup: no state dir given"; exit 1; }; STATUS_FILE="$1/status"`,
		`UPLOAD_ID=${uid}`,
		// Catch-all: any command that trips `set -e` writes a terminal failure
		// instead of leaving status=running for the watchdog to find hours later.
		`trap 'rc=$?; printf "status=failed\\nerror=script_error_line_%s_exit_%s\\nupload_id=%s\\nfinished_at=%s\\n" "$LINENO" "$rc" "$UPLOAD_ID" ${now} > "$STATUS_FILE"; exit $rc' ERR`,
		// Cleanup tmp files on exit. Status file lives until pollPendingBackups reads + deletes it.
		// armed BEFORE the first mktemp/write (names start empty), so a
		// failing mktemp or write never leaves the passphrase file on disk.
		`KEYFILE= DUMPFILE= URLSFILE= PARTSFILE= HEADERS= TAILFILE= CURLCFG=`,
		`trap 'rm -f "$KEYFILE" "$DUMPFILE" "$URLSFILE" "$PARTSFILE" "$HEADERS" "$TAILFILE" "$CURLCFG" "\${CHUNK:-}" "\${PGPASS_FILE:-}"' EXIT`,
		`KEYFILE=$(mktemp)`,
		`DUMPFILE=$(mktemp -p /var/tmp powder-dump-XXXXXX.bin)`,
		`URLSFILE=$(mktemp)`,
		`PARTSFILE=$(mktemp)`,
		`HEADERS=$(mktemp)`,
		`TAILFILE=$(mktemp)`,
		`CURLCFG=$(mktemp)`,
		`chmod 600 "$KEYFILE" "$DUMPFILE" "$URLSFILE" "$PARTSFILE" "$HEADERS" "$TAILFILE" "$CURLCFG"`,
		`printf '%s' '${o.passB64}' | base64 -d > "$KEYFILE"`,
		`printf '%s' '${o.urlsB64}' | base64 -d > "$URLSFILE"`,
		...o.preLines,
		// Initial status: running. Lets poll distinguish "started" vs "never wrote anything".
		`printf 'status=running\\n' > ${sf}`,
		// Dump → gzip → encrypt → disk. Stage to disk so each subsequent
		// multipart UploadPart has a known Content-Length (some stores, Hetzner for one, reject
		// chunked-encoded PUTs). /var/tmp over /tmp because /tmp is often tmpfs.
		`if ! { ${o.dumpCmd} | gzip | openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$KEYFILE" > "$DUMPFILE"; }; then`,
		`  printf 'status=failed\\nerror=dump_or_encrypt_failed\\nupload_id=%s\\nfinished_at=%s\\n' ${uid} ${now} > ${sf}`,
		`  exit 1`,
		`fi`,
		// Verify: decrypt + gunzip end to end (CRC-checked), keep only the tail.
		`if ! { openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$KEYFILE" < "$DUMPFILE" | gunzip | tail -c 4096 > "$TAILFILE"; }; then`,
		`  printf 'status=failed\\nerror=verify_decrypt_or_gunzip_failed\\nupload_id=%s\\nfinished_at=%s\\n' ${uid} ${now} > ${sf}`,
		`  exit 4`,
		`fi`,
		`if ! grep -q 'PostgreSQL database dump complete' "$TAILFILE"; then`,
		`  printf 'status=failed\\nerror=verify_dump_incomplete_no_trailer\\nupload_id=%s\\nfinished_at=%s\\n' ${uid} ${now} > ${sf}`,
		`  exit 4`,
		`fi`,
		`SHA=$(sha256sum "$DUMPFILE" | cut -d' ' -f1)`,
		`SIZE=$(stat -c %s "$DUMPFILE")`,
		`PART_SIZE=${PART_SIZE_BYTES}`,
		`PARTS=$(( (SIZE + PART_SIZE - 1) / PART_SIZE ))`,
		`echo "dump size: $SIZE bytes sha256 $SHA → $PARTS parts of $PART_SIZE"`,
		`if [ "$PARTS" -gt ${o.maxParts} ]; then`,
		`  printf 'status=failed\\nerror=dump_exceeds_max_parts_%s\\nsize=%s\\nupload_id=%s\\nfinished_at=%s\\n' "$PARTS" "$SIZE" ${uid} ${now} > ${sf}`,
		`  exit 3`,
		`fi`,
		// Multipart upload loop. Each part: dd a chunk to disk, curl PUT it,
		// capture ETag, delete chunk, append "<partNum>:<etag>" to PARTSFILE.
		// Retry up to 3 times per part with linear 5s/10s/15s backoff.
		`i=1`,
		`HTTP=000`,
		`while [ "$i" -le "$PARTS" ]; do`,
		`  CHUNK=$(mktemp -p /var/tmp powder-chunk-XXXXXX.bin)`,
		`  chmod 600 "$CHUNK"`,
		// Exactly one PART_SIZE_BYTES chunk per part; the final part is shorter (dd hits EOF).
		`  dd if="$DUMPFILE" of="$CHUNK" bs=1M skip=$(( (i-1) * ${partMiB} )) count=${partMiB} status=none`,
		// The part URL goes into the 0600 curl config (printf is a builtin, so it
		// never shows in a process argv), not on curl's command line.
		`  URL=$(sed -n "\${i}p" "$URLSFILE")`,
		`  printf 'url = "%s"\\n' "$URL" > "$CURLCFG"`,
		`  HTTP=000`,
		`  for attempt in 1 2 3; do`,
		`    HTTP=$(curl -fsS --max-time 1200 -X PUT -T "$CHUNK" -D "$HEADERS" -o /dev/null -w '%{http_code}' -K "$CURLCFG") || HTTP=000`,
		`    [ "$HTTP" = "200" ] && break`,
		`    sleep $((attempt * 5))`,
		`  done`,
		`  rm -f "$CHUNK"`,
		`  if [ "$HTTP" != "200" ]; then`,
		`    printf 'status=failed\\nerror=s3_part_%s_http_%s\\nsize=%s\\nupload_id=%s\\nfinished_at=%s\\n' "$i" "$HTTP" "$SIZE" ${uid} ${now} > ${sf}`,
		`    exit 2`,
		`  fi`,
		// ETag header: `ETag: "abc123..."` — strip CR + quotes + leading colon/space.
		`  ETAG=$(grep -i '^etag:' "$HEADERS" | tail -1 | tr -d '"\\r' | awk -F': ' '{print $2}')`,
		`  if [ -z "$ETAG" ]; then`,
		`    printf 'status=failed\\nerror=s3_part_%s_missing_etag\\nsize=%s\\nupload_id=%s\\nfinished_at=%s\\n' "$i" "$SIZE" ${uid} ${now} > ${sf}`,
		`    exit 2`,
		`  fi`,
		`  printf '%d:%s\\n' "$i" "$ETAG" >> "$PARTSFILE"`,
		`  i=$((i + 1))`,
		`done`,
		// All parts uploaded. Echo the parts CSV back via the status file so
		// pollPendingBackups can call CompleteMultipartUpload.
		`PARTS_CSV=$(paste -sd, "$PARTSFILE")`,
		`printf 'status=uploaded_pending_complete\\nsize=%s\\nsha256=%s\\nupload_id=%s\\nparts=%s\\nfinished_at=%s\\n' "$SIZE" "$SHA" ${uid} "$PARTS_CSV" ${now} > ${sf}`,
	].join('\n')
}

// Detached fire for a script already written to `scriptPath`. setsid + new
// session + redirected stdio = survives the SSH session ending. bash, not sh
// (dash rejects `set -o pipefail`). `umask 077` first: the log and status
// files (pg_dump / psql errors can quote row data) are created 0600, not
// root's default 0644. The script deletes its file as its first line
// (selfDeleteLine); the rm after it is a fallback.
export function buildDetachedFireCommand(
	scriptPath: string,
	logFile: string,
	done: string,
): string {
	return [
		'set -e',
		'umask 077',
		`( setsid bash -c "bash ${shq(scriptPath)}; rm -f ${shq(scriptPath)}" < /dev/null > ${shq(logFile)} 2>&1 & )`,
		`echo ${shq(done)}`,
	].join('\n')
}

/** the backup's detached fire. Makes the backup's state dir with `mktemp -d`
 *  under the root-only BACKUP_STATE_DIR (refusing a symlinked parent), logs into it and
 *  hands it to the script as $1 (the script writes `$1/status`). */
export function buildBackupFireCommand(
	scriptPath: string,
	id: string,
	parent = BACKUP_STATE_DIR,
): string {
	return [
		'set -e',
		'umask 077',
		`BK_P=${shq(parent)}`,
		`if [ -L "$BK_P" ]; then echo "backup: $BK_P is a symlink, refusing"; exit 1; fi`,
		`mkdir -p "$BK_P" && chmod 700 "$BK_P"`,
		`BK_D=$(mktemp -d "$BK_P/"${shq(`${id}.`)}XXXXXX)`,
		`( setsid bash -c 'bash "$1" "$2"; rm -f "$1"' _ ${shq(scriptPath)} "$BK_D" < /dev/null > "$BK_D/log" 2>&1 & )`,
		`echo "fired detached → $BK_D/log"`,
	].join('\n')
}

// Poll command: whether the detached script is still alive, THEN the status
// file (or MISSING). Liveness first: the script writes its terminal status
// before exiting, so "DEAD + status running" can only mean it died without
// finishing — checking in the other order races a script that completes
// between the two reads. The pattern is backupScriptPattern(id): the exact
// shape of backupScriptPath(id), bracketed so pgrep can't match the SSH shell
// running this very command.
export function buildPollCommand(id: string, parent = BACKUP_STATE_DIR): string {
	const varTmp = shq(varTmpStatusFile(id))
	return [
		`if pgrep -f ${shq(backupScriptPattern(id))} >/dev/null; then echo ALIVE; else echo DEAD; fi`,
		`echo '${POLL_MARKER}'`,
		// the backup's mktemp dir; with no such dir, a status file in /var/tmp is
		// read only when root owns it and it is no symlink.
		backupDirShell(id, parent),
		`if [ -n "$BK_D" ] && [ -f "$BK_D/status" ]; then cat "$BK_D/status"; ` +
			`elif [ -z "$BK_D" ] && [ -f ${varTmp} ] && [ ! -L ${varTmp} ] && [ "$(stat -c %u ${varTmp} 2>/dev/null)" = 0 ]; then cat ${varTmp}; ` +
			`else echo MISSING; fi`,
	].join('\n')
}

const POLL_MARKER = '---powder-status---'

// Kill the detached backup (whole process group — setsid made the outer
// `bash -c` the group leader, so this also takes docker/pg_dump/curl children).
// Then removes any script file of the backup still left in /tmp.
export function buildKillCommand(id: string): string {
	return [
		`for P in $(pgrep -f ${shq(backupScriptPattern(id))}); do`,
		`  G=$(ps -o pgid= -p "$P" | tr -d ' ')`,
		`  [ -n "$G" ] && kill -TERM -- "-$G" 2>/dev/null || true`,
		`done`,
		`rm -f -- ${backupScriptGlob(id)} 2>/dev/null`,
		`true`,
	].join('\n')
}

export function splitPollOutput(out: string): { status: string; alive: boolean | null } {
	const idx = out.indexOf(POLL_MARKER)
	if (idx < 0) return { status: out.trim(), alive: null }
	const proc = out.slice(0, idx).trim()
	return {
		status: out.slice(idx + POLL_MARKER.length).trim(),
		alive: proc === 'ALIVE' ? true : proc === 'DEAD' ? false : null,
	}
}
