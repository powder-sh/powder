-- idempotent
-- Deploy kinds for the dashboard's app stop and delete (apps/web/src/lib/app-lifecycle.ts):
-- each is recorded as a deploys row, so it holds the per-app in-flight lock and shows in
-- the activity feed. ADD VALUE runs outside a transaction (bin/lib-migrations.sh).
ALTER TYPE "public"."deploy_kind" ADD VALUE IF NOT EXISTS 'stop';
ALTER TYPE "public"."deploy_kind" ADD VALUE IF NOT EXISTS 'delete';
