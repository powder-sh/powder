-- idempotent
-- Per-app notification email override. NULL means "fall back to the owner's
-- user.email" (current behavior). Setting it routes deploy-failed + app-down
-- alerts for THIS app to a different address, so each app can have a different
-- notification address without a second powder user to own it.

ALTER TABLE "app_repos"
  ADD COLUMN IF NOT EXISTS "notify_email" text;
