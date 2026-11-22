-- idempotent
-- servers.check_missing: the required pieces the last server check found missing
-- (apps/web/src/lib/server-bootstrap-run.ts), as a JSON array of {id, label, detail},
-- so the setup checklist can name what is missing on each server after a restart.
-- '[]' with check_green true. NULL = a result saved before this column existed: a
-- green one stays green (the check only got looser), a red one is shown as not
-- checked yet and re-checked, since it was computed under the older, stricter rule.
-- Nullable with no default: a catalog-only change, and the previous release (which
-- never names the column) keeps working.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "check_missing" jsonb;
