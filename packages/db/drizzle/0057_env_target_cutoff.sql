-- idempotent
-- env render target containment (apps/web/src/lib/env-target.ts). Records once
-- when this release first ran. A render target outside /opt/apps/<app>.env and
-- /opt/apps/<app>/ is only pinned for an app when powder rendered to that exact path
-- for a successful deploy of the app that started BEFORE this moment (evidence that
-- predates the rule, not a compose the repo just changed). Re-runs keep the first value.
INSERT INTO "powder_meta" ("key", "value") VALUES ('env_target_cutoff', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT ("key") DO NOTHING;
