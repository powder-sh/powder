-- idempotent
-- Per-app opt-out for automatic rollback (apps/web/src/lib/auto-rollback.ts). Default true:
-- the app may be rolled back automatically when the preflight allows it. Set false for an
-- app that must never be rolled back automatically.
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "auto_rollback" boolean NOT NULL DEFAULT true;
