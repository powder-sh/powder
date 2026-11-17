-- idempotent
-- Backup download / restore / verify / drop-restore-db actions. One row per
-- action: the job state for restores and the audit log shown on /activity.
CREATE TABLE IF NOT EXISTS "app_backup_restores" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"backup_id" text,
	"server_id" text NOT NULL,
	"container_name" text NOT NULL,
	"target_db" text,
	"status" text DEFAULT 'running' NOT NULL,
	"table_count" integer,
	"size_bytes" bigint,
	"output" text,
	"error" text,
	"requested_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"dropped_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "app_backup_restores_by_app_idx" ON "app_backup_restores" ("server_id", "container_name", "started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "app_backup_restores_running_unique" ON "app_backup_restores" ("server_id", "container_name") WHERE "status" = 'running';
