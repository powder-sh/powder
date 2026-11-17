-- idempotent
-- Replay guard: the commit a preview last deployed, so a replayed signed push of the same
-- sha does not redeploy it. Nullable, no backfill (an unknown sha never blocks a push).
ALTER TABLE "preview_deploys" ADD COLUMN IF NOT EXISTS "last_sha" text;
