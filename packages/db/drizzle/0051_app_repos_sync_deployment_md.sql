-- idempotent
-- DEPLOYMENT.md sync is opt-in per app. lib/sync-deployment-md.ts commits the
-- file into the app's GitHub repo after a successful deploy only when this is
-- true. Default false, no backfill: turn it on per app from the settings tab or
--   update app_repos set sync_deployment_md = true where container_name = '<app>';
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "sync_deployment_md" boolean NOT NULL DEFAULT false;
