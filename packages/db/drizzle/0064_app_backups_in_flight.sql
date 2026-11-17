-- idempotent
-- source: 'scheduled' (the hourly backup tick) or 'manual' (POST
-- /api/projects/<id>/backups). A success prunes backups of its own source only, so
-- manual triggers (an API token's) can never push scheduled backups out. Existing
-- rows count as scheduled.
ALTER TABLE "app_backups" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'scheduled' NOT NULL;
-- At most one in-flight backup per app. Before the index: an app with more than one
-- in-flight row keeps one and the others are marked failed (otherwise the index
-- cannot be built). The kept row is an uploaded_pending_complete one when there is
-- one (its dump is done, only the S3 complete call is owed), else the newest. The
-- failed rows keep s3_upload_id: the backup watchdog aborts those multipart
-- uploads and clears it (lib/backups.ts abortDanglingUploads).
UPDATE "app_backups" b
SET "status" = 'failed',
	"finished_at" = now(),
	"error" = 'stopped: another backup of this app was in flight at the same time'
WHERE b."status" IN ('running', 'uploaded_pending_complete')
	AND EXISTS (
		SELECT 1 FROM "app_backups" n
		WHERE n."server_id" = b."server_id"
			AND n."container_name" = b."container_name"
			AND n."status" IN ('running', 'uploaded_pending_complete')
			AND (CASE WHEN n."status" = 'uploaded_pending_complete' THEN 1 ELSE 0 END, n."started_at", n."id")
				> (CASE WHEN b."status" = 'uploaded_pending_complete' THEN 1 ELSE 0 END, b."started_at", b."id")
	);
CREATE UNIQUE INDEX IF NOT EXISTS "app_backups_in_flight_unique" ON "app_backups" ("server_id", "container_name") WHERE "status" IN ('running', 'uploaded_pending_complete');
