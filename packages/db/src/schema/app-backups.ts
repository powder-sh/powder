import { sql } from 'drizzle-orm'
import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// Per-app postgres backups. One row per backup attempt; success rows have
// finishedAt + size + sha256, failed rows have error. Storage is whatever
// S3-compatible service powder is configured for (AWS S3, Hetzner Object Storage
// or another); the s3Key is the full key relative to BACKUP_S3_BUCKET.
//
// The pg_dump runs on the app server itself (via SSH from powder), is
// gzipped + AES-encrypted with POWDER_BACKUP_KEY, then streamed via curl to
// a presigned PUT URL. Powder never touches the dump bytes.

export const backupStatus = pgEnum('backup_status', [
	'running',
	'success',
	'failed',
	// Multipart only: all parts uploaded, powder still needs to call
	// CompleteMultipartUpload. pollPendingBackups transitions this to success.
	'uploaded_pending_complete',
])

export const appBackups = pgTable(
	'app_backups',
	{
		id: text('id').primaryKey(),
		serverId: text('server_id').notNull(),
		containerName: text('container_name').notNull(),
		s3Key: text('s3_key').notNull(),
		// nullable until the backup completes
		sizeBytes: bigint('size_bytes', { mode: 'number' }),
		sha256: text('sha256'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		status: backupStatus('status').notNull().default('running'),
		error: text('error'),
		// S3 multipart upload id. Set on initiate, cleared (via Complete or Abort)
		// when the row reaches a terminal state. Survives powder restarts so the
		// completion call can be retried by pollPendingBackups.
		s3UploadId: text('s3_upload_id'),
		// Set when retention removed this backup's S3 object (keep-N-per-app).
		// The row stays as history; a pruned backup is NOT restorable.
		prunedAt: timestamp('pruned_at', { withTimezone: true }),
		// 0062: 'scheduled' (the hourly backup tick) or 'manual' (POST
		// /api/projects/<id>/backups, session or token). Two retention pools:
		// a success prunes its own source only, and so does the admin prune route.
		source: text('source').notNull().default('scheduled'),
		// 0065: failed aborts of this row's dangling multipart upload (watchdog,
		// lib/backups.ts abortDanglingUploads). At the cap the id is cleared.
		abortAttempts: integer('abort_attempts').notNull().default(0),
	},
	(t) => ({
		// Powers "list backups for this app, newest first" — the dashboard's main read pattern.
		appBackupsByApp: index('app_backups_by_app_idx').on(
			t.serverId,
			t.containerName,
			t.startedAt,
		),
		// 0062: at most one in-flight backup per app.
		inFlightUnique: uniqueIndex('app_backups_in_flight_unique')
			.on(t.serverId, t.containerName)
			.where(sql`${t.status} in ('running', 'uploaded_pending_complete')`),
	}),
)

export type AppBackup = typeof appBackups.$inferSelect
export type NewAppBackup = typeof appBackups.$inferInsert
