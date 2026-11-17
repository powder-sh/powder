-- idempotent
-- container_port: the port an app listens on in its container, stored at create
-- (/new) so previews route to it instead of 3000. NULL on existing apps: their
-- previews read the port from the parent's compose / Traefik label.
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "container_port" integer;
-- abort_attempts: failed aborts of a failed backup's dangling multipart upload
-- (lib/backups.ts abortDanglingUploads). After 5, or on NoSuchBucket /
-- AccessDenied, the watchdog clears s3_upload_id and logs it.
ALTER TABLE "app_backups" ADD COLUMN IF NOT EXISTS "abort_attempts" integer DEFAULT 0 NOT NULL;
