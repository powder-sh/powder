-- idempotent
-- Structured failure fields for deploys. The full deploy log still lives in
-- `error`/`output`; these three let the dashboard show *why* a deploy failed
-- at a glance instead of forcing a read through the whole blob. Populated on
-- the failed path only (NULL on success / running).
--   failed_step   — the `── <phase> ──` banner the remote script was in when
--                   it died (from the __POWDER_FAIL__ trap marker)
--   exit_code     — that phase's shell exit code
--   error_summary - one-line human cause (e.g. "container name in use: api-worker")

ALTER TABLE "deploys"
  ADD COLUMN IF NOT EXISTS "failed_step" text;

ALTER TABLE "deploys"
  ADD COLUMN IF NOT EXISTS "exit_code" integer;

ALTER TABLE "deploys"
  ADD COLUMN IF NOT EXISTS "error_summary" text;
