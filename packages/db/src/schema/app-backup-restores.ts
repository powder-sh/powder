import { sql } from 'drizzle-orm'
import { bigint, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// Everything an operator does to get a backup back (0054): a presigned
// download, a restore into a NEW database next to the live one, a verify
// (restore into a throwaway database, count tables, drop it), and dropping a
// restore database. One row per action, so the table is also the audit log
// that /activity shows. The live database is never a target: restore and drop
// only accept names matching `<db>_restore_<yyyymmdd_hhmm>` (backup-restore-logic.ts).

export type BackupRestoreKind = 'download' | 'restore' | 'verify' | 'drop'
export type BackupRestoreStatus = 'running' | 'success' | 'failed'

export const appBackupRestores = pgTable(
	'app_backup_restores',
	{
		id: text('id').primaryKey(),
		kind: text('kind').$type<BackupRestoreKind>().notNull(),
		// The app_backups row restored/downloaded. Null for drops.
		backupId: text('backup_id'),
		serverId: text('server_id').notNull(),
		containerName: text('container_name').notNull(),
		// The database created (restore/verify) or dropped. Null for downloads.
		targetDb: text('target_db'),
		status: text('status').$type<BackupRestoreStatus>().notNull().default('running'),
		// Tables in the restored database (non-system schemas), and its size.
		tableCount: integer('table_count'),
		sizeBytes: bigint('size_bytes', { mode: 'number' }),
		// Tail of the script's log, saved when the job finishes.
		output: text('output'),
		error: text('error'),
		requestedBy: text('requested_by'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		// Set on a restore row once its database was dropped.
		droppedAt: timestamp('dropped_at', { withTimezone: true }),
	},
	(t) => ({
		byApp: index('app_backup_restores_by_app_idx').on(t.serverId, t.containerName, t.startedAt),
		// One running restore/verify/drop per app: a second insert fails with 23505.
		runningUnique: uniqueIndex('app_backup_restores_running_unique')
			.on(t.serverId, t.containerName)
			.where(sql`${t.status} = 'running'`),
	}),
)

export type AppBackupRestore = typeof appBackupRestores.$inferSelect
export type NewAppBackupRestore = typeof appBackupRestores.$inferInsert
