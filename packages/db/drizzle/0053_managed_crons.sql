-- idempotent
-- Managed crons: powder runs, logs and alerts on per-app jobs (lib/cron-scheduler.ts).
-- Additive only: new defaulted/nullable columns on cron_jobs plus cron_job_runs
-- (per-run history of powder-managed jobs; cron_runs stays the HOST cron observer).
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'UTC';
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "http_method" text NOT NULL DEFAULT 'POST';
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "bearer_env_var" text;
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "exec_argv" jsonb;
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "timeout_seconds" integer NOT NULL DEFAULT 30;
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "running_since" timestamptz;
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "imported_from" text;

CREATE TABLE IF NOT EXISTS "cron_job_runs" (
  "id" text PRIMARY KEY,
  "cron_job_id" text NOT NULL,
  "trigger" text NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "duration_ms" integer,
  "http_status" integer,
  "exit_code" integer,
  "output" text,
  "error" text
);
CREATE INDEX IF NOT EXISTS "cron_job_runs_job_idx" ON "cron_job_runs" ("cron_job_id", "started_at" DESC);
