-- idempotent
-- Observed cron firings, scraped from each server's journalctl CRON output.
-- Most of powder's tracked crons are run by the host cron daemon (root crontab
-- entries that `docker exec` into the app container) — powder's in-process
-- scheduler doesn't fire them, so cron_jobs.last_run_at stays NULL forever.
-- This table is the missing record of "what actually ran", populated by a
-- 5-minute observer tick that pulls journalctl since the cursor.
--
-- Activity feed UNIONs this in alongside deploys + backups so cron firings
-- finally show up on /activity.

CREATE TABLE IF NOT EXISTS "cron_runs" (
  "id" text PRIMARY KEY,
  "server_id" text NOT NULL,
  "container_name" text NOT NULL,
  "command_snippet" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cron_runs_dedup" UNIQUE ("server_id", "started_at", "command_snippet")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "cron_runs_by_app_idx" ON "cron_runs" ("server_id", "container_name", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cron_runs_by_at_idx" ON "cron_runs" ("started_at" DESC);
