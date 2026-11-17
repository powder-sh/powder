// Pure decision logic for backups.ts: status-file parsing, retry backoff and
// retention selection. No DB/SSH imports, so it stays unit-testable.

export interface StatusParsed {
	status: 'running' | 'success' | 'failed' | 'uploaded_pending_complete' | null
	error?: string
	size?: number
	sha256?: string
	finishedAt?: Date
	uploadId?: string
	// Parsed from `parts=1:etag1,2:etag2,...`. minio's
	// completeMultipartUpload expects { part: number, etag: string }[].
	parts?: { part: number; etag: string }[]
}

export function parseStatusFile(text: string): StatusParsed {
	const out: StatusParsed = { status: null }
	for (const line of text.split('\n')) {
		const eq = line.indexOf('=')
		if (eq < 0) continue
		const k = line.slice(0, eq).trim()
		const v = line.slice(eq + 1).trim()
		if (
			k === 'status' &&
			(v === 'running' || v === 'success' || v === 'failed' || v === 'uploaded_pending_complete')
		) {
			out.status = v
		} else if (k === 'error') out.error = v
		else if (k === 'size') out.size = Number(v)
		else if (k === 'sha256') {
			if (/^[0-9a-f]{64}$/.test(v)) out.sha256 = v
		} else if (k === 'upload_id') out.uploadId = v
		else if (k === 'parts') {
			out.parts = v
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
				.map((s) => {
					const colon = s.indexOf(':')
					if (colon < 0) return null
					const part = Number(s.slice(0, colon))
					const etag = s.slice(colon + 1)
					if (!Number.isFinite(part) || !etag) return null
					return { part, etag }
				})
				.filter((p): p is { part: number; etag: string } => p !== null)
		} else if (k === 'finished_at') {
			const d = new Date(v)
			if (!Number.isNaN(d.getTime())) out.finishedAt = d
		}
	}
	return out
}

// ── Retry backoff ────────────────────────────────────────────────────────────
// Without backoff a chronically failing app re-runs a full pg_dump EVERY hour,
// and a large DB's dump can take most of that hour. Consecutive failures now back off
// exponentially: 1h, 2h, 4h, 8h, 16h, then capped at 24h. The staleness alarm
// (36h without a success) is independent of this, so backing off never hides
// a dark app.
const HOUR_MS = 60 * 60 * 1000
const SUCCESS_INTERVAL_MS = 23 * HOUR_MS
const MAX_BACKOFF_MS = 24 * HOUR_MS

export function failureBackoffMs(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) return 0
	return Math.min(HOUR_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS)
}

export interface BackupAttempt {
	status: string
	startedAt: Date
	// app_backups.error as stored by runBackupForApp's catch (redacted, sliced).
	error?: string | null
}

// The ONE authority for "this failed attempt never reached the server". When the
// SSH connection was never established, no script was uploaded and no pg_dump
// ran, so the attempt cost the server nothing and must not grow the backoff
// (a server unreachable for a long time would otherwise escalate its apps to a
// long backoff, so they stay without a backup long after the server comes back).
// Matched on the message runBackupForApp stores in app_backups.error:
//   - ssh2 readyTimeout: "Timed out while waiting for handshake"
//   - Node net connect errors: "connect ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT <ip>:<port>"
//     (the "connect " prefix pins ETIMEDOUT to the TCP connect, not a read)
//   - DNS: "getaddrinfo ENOTFOUND|EAI_AGAIN <host>"
// Every pattern is anchored with ^: only the bare error counts. A prefixed one
// such as "complete_failed: connect ETIMEDOUT ..." (pollPendingBackups, S3
// complete after the dump already ran) is NOT this class.
// The bare net/DNS forms also match a failure of initiateMultipart, which runs
// in powder before the SSH step (S3 unreachable from powder). That is harmless:
// nothing ran on the server either, so not growing the backoff is still right.
// Deliberately NOT this class:
//   - auth failure ("All configured authentication methods failed") and host-key
//     refusal: the server answered and refused us. That is a config problem that
//     needs a human, not a transient outage, so it keeps the normal backoff
//     (which also throttles the hourly backup_failed notification).
//   - "SSH timeout to" / "SFTP timeout to" (our overall timers) and ECONNRESET:
//     these can fire after the session was up, i.e. with the script already on
//     the server or fired, so we cannot claim nothing ran.
const CONNECT_FAILURE_PATTERNS = [
	/^Timed out while waiting for handshake/i,
	/^connect (ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/,
	/^getaddrinfo (ENOTFOUND|EAI_AGAIN)\b/,
]

export function isConnectFailure(attempt: { status: string; error?: string | null }): boolean {
	const error = attempt.error
	if (attempt.status !== 'failed' || !error) return false
	return CONNECT_FAILURE_PATTERNS.some((re) => re.test(error))
}

// history = newest first. Returns whether a new backup should fire now.
// Connect failures (isConnectFailure) are skipped when counting the failure
// streak, so they neither grow the backoff nor reset it: the next attempt is
// due at the later of (newest connect failure + 1h, the hourly retry floor)
// and (newest real failure + its backoff).
export function isBackupDue(history: BackupAttempt[], now: number): boolean {
	const last = history[0]
	if (!last) return true
	// In flight — the script is dumping/uploading or powder owes the S3 complete.
	if (last.status === 'running' || last.status === 'uploaded_pending_complete') return false
	if (last.status === 'success') return last.startedAt.getTime() <= now - SUCCESS_INTERVAL_MS
	let failures = 0
	let lastReal: BackupAttempt | undefined
	for (const h of history) {
		if (h.status !== 'failed') break
		if (isConnectFailure(h)) continue
		lastReal ??= h
		failures++
	}
	if (isConnectFailure(last) && last.startedAt.getTime() > now - HOUR_MS) return false
	if (!lastReal) return true
	return lastReal.startedAt.getTime() <= now - failureBackoffMs(failures)
}

// ── Retention ────────────────────────────────────────────────────────────────
// Plain keep-newest-N could delete every REAL backup: a misconfiguration that
// dumps an empty/wrong DB still produces "successful" tiny backups, and after
// N days of those the last good dumps are gone. So retention also counts
// "sizeable" backups — at least SIZEABLE_RATIO × the LARGEST unpruned success —
// and never prunes while fewer than `keep` sizeable ones would remain. Max, not
// median: once bad dumps outnumber good ones a median drifts to the bad size
// and the guard would release exactly the backups it exists to protect. 50% is
// loose enough that normal growth and gzip jitter never trip it, and tight
// enough that an empty or wrong-DB dump (orders of magnitude smaller) always
// does. Cost of a legitimate >50% shrink: up to `keep` old dumps are held until
// an admin prunes with force (the shrink alert says so). Rows with unknown size
// count as sizeable (we can't judge them).
const SIZEABLE_RATIO = 0.5

export interface RetentionRow {
	id: string
	sizeBytes: number | null
}

function median(nums: number[]): number | null {
	if (nums.length === 0) return null
	const s = [...nums].sort((a, b) => a - b)
	const mid = Math.floor(s.length / 2)
	const hi = s[mid] ?? 0
	return s.length % 2 ? hi : ((s[mid - 1] ?? 0) + hi) / 2
}

export interface RetentionPlan<T> {
	keep: T[]
	prune: T[]
	// Rows kept beyond the plain keep-N floor because the newer ones are too small.
	held: number
}

// rows = successful, unpruned, newest first.
export function planRetention<T extends RetentionRow>(rows: T[], keep: number): RetentionPlan<T> {
	// a keep that is not a finite number (NaN from a bad request) keeps everything.
	const floor = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : Math.max(1, rows.length)
	const sizes = rows.map((r) => r.sizeBytes).filter((s): s is number => s != null && s > 0)
	const ref = sizes.length ? Math.max(...sizes) : null
	const isSizeable = (r: T) =>
		ref == null || r.sizeBytes == null || r.sizeBytes >= SIZEABLE_RATIO * ref
	const kept: T[] = []
	const prune: T[] = []
	let sizeable = 0
	const totalSizeable = rows.filter(isSizeable).length
	const sizeableTarget = Math.min(floor, totalSizeable)
	for (const r of rows) {
		// Past the floor, only sizeable rows are worth holding on to.
		if (kept.length < floor || (sizeable < sizeableTarget && isSizeable(r))) {
			kept.push(r)
			if (isSizeable(r)) sizeable++
		} else {
			prune.push(r)
		}
	}
	return { keep: kept, prune, held: Math.max(0, kept.length - floor) }
}

// True when the newest backup is suspiciously small next to its predecessors:
// under SIZEABLE_RATIO × the median of the previous `window` successes. Needs
// 3+ predecessors with known sizes so a young app's natural growth can't trip it.
export function newestLooksShrunk(rows: RetentionRow[], window = 7): boolean {
	const [newest, ...prev] = rows
	if (!newest || newest.sizeBytes == null) return false
	const sizes = prev
		.slice(0, window)
		.map((r) => r.sizeBytes)
		.filter((s): s is number => s != null && s > 0)
	if (sizes.length < 3) return false
	const med = median(sizes) ?? 0
	return newest.sizeBytes < SIZEABLE_RATIO * med
}

// ── Object keys ──────────────────────────────────────────────────────────────
// The key carries serverId (container names are only unique per server, the
// bucket can be shared by every server) and the backup row id (the timestamp has
// 1 s resolution, so two backups of same-named apps could otherwise land on
// one object). Old rows keep their old `<container>/<ts>.sql.gz.enc` key: the
// key is stored per row and read back from there, never recomputed.
export function backupObjectKey(o: {
	serverId: string
	containerName: string
	backupId: string
	at: Date
}): string {
	const ts = `${o.at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z`
	return `${o.serverId}/${o.containerName}/${ts}-${o.backupId}.sql.gz.enc`
}

// "Complete errored but the object exists": only proof of success when the
// object is the one this backup uploaded, i.e. its size matches the size the
// script reported. Unknown size on either side is not proof.
export function landedObjectMatches(
	stat: { size?: number | null } | null,
	expectedSize: number | null | undefined,
): boolean {
	if (!stat || stat.size == null || expectedSize == null) return false
	if (!Number.isFinite(expectedSize) || expectedSize <= 0) return false
	return stat.size === expectedSize
}

// Prune deletes an object only when no row outside the prune set still points
// at it. Old-format keys could be shared by two apps (same container name on
// two servers, same second), and deleting one app's row must not delete the
// other app's backup. `otherRefs` = s3 keys referenced by unpruned rows that
// are not this row.
export function canDeleteObject(key: string, otherRefs: ReadonlySet<string>): boolean {
	return !otherRefs.has(key)
}
