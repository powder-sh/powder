-- idempotent
-- Settle window for push deploys (apps/web/src/lib/deploy-settle.ts).
--   deploys.not_before: a queued webhook push is not claimed before this time, so further
--     pushes of the app fold into it and ship as one deploy. NULL = claim at once (every
--     row before this migration, and every row while the window is off).
--   app_repos.deploy_settle_seconds: per-app window. NULL = the global value
--     (powder_meta key deploy_settle_seconds, absent = 0 = off), 0 = off for this app.
-- Both nullable with no default: a catalog-only change, no table rewrite (the boot step
-- runs it with lock_timeout 5s, so it never queues long behind another transaction).
ALTER TABLE "deploys" ADD COLUMN IF NOT EXISTS "not_before" timestamp with time zone;
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "deploy_settle_seconds" integer;
