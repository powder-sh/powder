-- Uptime checks for every app, not only the apps on one server.
--
-- Before: lib/uptime.ts checked only the apps of one Traefik server, at a
-- hardcoded default host. Apps on other servers, custom-domain apps
-- included, had no liveness check.
--
-- After: a per-app opt-in flag + an optional explicit URL. If health_url is
-- NULL the checker falls back to the first live app_domains row, then to the
-- app's default host. uptime_enabled gates the whole thing so adding the
-- column doesn't flood existing installs with first-time DOWN notifications.

ALTER TABLE "app_repos"
  ADD COLUMN IF NOT EXISTS "health_url" text,
  ADD COLUMN IF NOT EXISTS "uptime_enabled" boolean NOT NULL DEFAULT false;

-- Every app starts opted out.
