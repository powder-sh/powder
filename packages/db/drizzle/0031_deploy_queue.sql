-- Worker-based deploy queue: 'queued' deploy status, widened in-flight lock,
-- and a DB-backed scheduler heartbeat.
--
-- APPLY WITHOUT --single-transaction (do NOT pass psql -1). Postgres forbids
-- using a freshly-added enum label in the same transaction it was added, and
-- the index below references 'queued'. With psql's default autocommit each
-- statement commits on its own, so the ADD VALUE lands before the index is
-- created. Wrapping the whole file in one transaction would error with
-- "unsafe use of new value of enum type".

-- 1. New status for deploys parked in the worker queue (inserted by a web
--    trigger route, not yet claimed by the deploy worker).
ALTER TYPE "deploy_status" ADD VALUE IF NOT EXISTS 'queued' BEFORE 'running';

-- 2. The in-flight lock must now also reject a second 'queued' row, not just a
--    second 'running' one — otherwise two rapid webhooks for the same app could
--    both enqueue. Recreate the partial unique index over both states.
DROP INDEX IF EXISTS "deploys_in_flight_unique";
CREATE UNIQUE INDEX "deploys_in_flight_unique"
  ON "deploys" ("server_id", "container_name")
  WHERE "status" IN ('queued', 'running');

-- 3. Cross-process scheduler liveness. The deploy worker owns the cron scheduler
--    and upserts id='scheduler' each tick; the web /api/health route reads it.
CREATE TABLE IF NOT EXISTS "scheduler_heartbeat" (
  "id" text PRIMARY KEY,
  "started" boolean NOT NULL DEFAULT false,
  "last_tick_at" timestamptz,
  "owner" text
);
