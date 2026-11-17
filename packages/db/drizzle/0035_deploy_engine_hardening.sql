-- idempotent
-- Deploy-engine hardening.
--
-- Apply by hand BEFORE deploying the code that uses it (powder migrations after
-- 0022 are applied with psql, not drizzle-kit):
--   docker exec -i postgres psql -U admin -d powder < 0035_deploy_engine_hardening.sql
-- Every statement is idempotent and safe under the OLD code (new columns are
-- never selected by it; the two new indexes are strictly looser than the old
-- one, which is dropped last).

-- 1. The commit a deploy should build. Set from the push payload (`after`) by
--    the webhook; NULL = build the configured branch's HEAD (manual redeploys,
--    catch-ups). The builder phase and the target sync both check out exactly
--    this sha, so the image, git_sha and powder-migrate all agree.
ALTER TABLE "deploys" ADD COLUMN IF NOT EXISTS "requested_sha" text;

-- 2. Executor liveness. The process running a deploy stamps this every 30s;
--    the watchdog reaps a 'running' row whose executor stopped stamping
--    (process died / restarted) instead of guessing from elapsed time, which
--    false-reaped long-but-alive deploys (lock wait + 30m build + test gate).
ALTER TABLE "deploys" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamptz;

-- 3. Durable catch-up. One 'running' AND one 'queued' row may now coexist per
--    app, so a push that lands mid-deploy is stored as a queued row (survives
--    powder restarts) instead of an in-memory retry timer that gave up after
--    15 min. Create the looser indexes first, then drop the old combined one.
CREATE UNIQUE INDEX IF NOT EXISTS "deploys_running_unique"
  ON "deploys" ("server_id", "container_name")
  WHERE "status" = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS "deploys_queued_unique"
  ON "deploys" ("server_id", "container_name")
  WHERE "status" = 'queued';
DROP INDEX IF EXISTS "deploys_in_flight_unique";

-- 4. Pinned SSH host keys (trust on first use). powder connects to every server
--    as root with the master key; without host-key checking anyone who can
--    intercept the route receives env files and deploy keys. First connection
--    records the key; any later mismatch is refused. A legitimately rebuilt
--    server: DELETE FROM ssh_host_keys WHERE host = '<ip>';
CREATE TABLE IF NOT EXISTS "ssh_host_keys" (
  "host" text PRIMARY KEY,
  "key_type" text NOT NULL,
  "sha256" text NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now()
);
