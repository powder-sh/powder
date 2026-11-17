-- idempotent
-- Single-tenant cleanup: branch previews are opt-in per app.
-- app_repos.previews_enabled defaults to false. The first time this runs it
-- turns the flag on for every app that already has a preview row, so nothing that
-- works today stops.
-- The UPDATE only runs together with the ALTER, so a re-run never re-enables an
-- app someone switched off. Toggle later with plain SQL:
--   update app_repos set previews_enabled = true where container_name = '<app>';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_repos' AND column_name = 'previews_enabled'
  ) THEN
    ALTER TABLE "app_repos" ADD COLUMN "previews_enabled" boolean NOT NULL DEFAULT false;
    UPDATE "app_repos" SET "previews_enabled" = true
      WHERE "id" IN (SELECT DISTINCT "app_repo_id" FROM "preview_deploys");
  END IF;
END $$;
