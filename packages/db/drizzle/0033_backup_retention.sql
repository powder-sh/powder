-- Backup retention: pruned_at marks rows whose S3 object was deleted by the
-- keep-N-per-app retention sweep. The row stays as history; the backup is no
-- longer restorable. (Without it, S3 objects have no lifecycle and pile up.)
ALTER TABLE "app_backups" ADD COLUMN "pruned_at" timestamp with time zone;
