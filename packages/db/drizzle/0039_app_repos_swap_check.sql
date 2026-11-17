-- idempotent
-- Per-app switch for the pre-swap candidate probe (deploy step "swap-check").
-- true (default) = start the new image as <name>-next and probe it before the
-- live container is recreated; false = skip it for this app. Hand-apply (idempotent):
--   psql ... -f 0039_app_repos_swap_check.sql
-- Trial on one app first: apply this, then
--   UPDATE app_repos SET swap_check = false WHERE container_name <> '<trial-app>';
-- BEFORE deploying powder (see docs/SELF-HOSTING.md). Kill switch for every app: env
-- POWDER_SWAP_CHECK=off.
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "swap_check" boolean NOT NULL DEFAULT true;
