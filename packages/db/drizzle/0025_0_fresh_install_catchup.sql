-- idempotent
-- Fresh-install catch-up. Older installs got these objects from `drizzle-kit push`,
-- so no earlier migration file creates them. On a new database they must exist
-- before 0026 (which alters the enum and app_backups), hence the name: it sorts
-- after 0024 and before 0025_env_audit_versions and 0026 in every locale
-- (a digit sorts before a letter). pruned_at is left out on purpose: 0033 adds it.
-- Everything is IF NOT EXISTS, so it is a no-op
-- on a database that already has them.

DO $$ BEGIN
  CREATE TYPE "backup_status" AS ENUM ('running', 'success', 'failed', 'uploaded_pending_complete');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_backups" (
  "id" text PRIMARY KEY NOT NULL,
  "server_id" text NOT NULL,
  "container_name" text NOT NULL,
  "s3_key" text NOT NULL,
  "size_bytes" bigint,
  "sha256" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" "backup_status" DEFAULT 'running' NOT NULL,
  "error" text,
  "s3_upload_id" text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "app_backups_by_app_idx" ON "app_backups" USING btree ("server_id", "container_name", "started_at");
--> statement-breakpoint

ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "backup_db_container" text;
--> statement-breakpoint
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "backup_db_host" text;
--> statement-breakpoint
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "backup_db_name" text;
--> statement-breakpoint
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "backup_db_user" text;
--> statement-breakpoint
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "backup_db_password_encrypted" text;
--> statement-breakpoint

ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "backup_s3_endpoint" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "backup_s3_region" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "backup_s3_bucket" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "backup_s3_access_key_id_encrypted" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "backup_s3_secret_access_key_encrypted" text;
--> statement-breakpoint

ALTER TABLE "deploys" ADD COLUMN IF NOT EXISTS "github_deployment_id" text;
