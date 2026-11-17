-- idempotent
-- Multipart S3 upload support for app_backups.
--
-- Why: some S3-compatible stores (Hetzner Object Storage, for one) reject a
-- single PUT > 5 GiB with HTTP 400, so a large encrypted dump would fail on every run.
-- New path: powder issues InitiateMultipartUpload, presigns N UploadPart URLs,
-- script PUTs each chunk, status file echoes back parts list + uploadId,
-- powder calls CompleteMultipartUpload (or AbortMultipartUpload on failure).
--
-- 'uploaded_pending_complete' is the intermediate status: parts are in S3,
-- powder still needs to finalize. pollPendingBackups handles the transition.

ALTER TYPE "backup_status" ADD VALUE IF NOT EXISTS 'uploaded_pending_complete';
--> statement-breakpoint

ALTER TABLE "app_backups" ADD COLUMN IF NOT EXISTS "s3_upload_id" text;
