-- idempotent
-- Last server check result (apps/web/src/lib/server-bootstrap-run.ts), so the setup
-- checklist survives a powder restart instead of showing every server as unchecked.
-- check_proxy = servers.proxy at check time; a result for another proxy is stale.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "check_green" boolean;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "check_proxy" text;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "checked_at" timestamp with time zone;
