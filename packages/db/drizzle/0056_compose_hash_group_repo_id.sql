-- idempotent
-- deploys.compose_config_hash: written only when a deploy succeeds. sha256 of the
--   app's compose STRUCTURE (structuralComposeHash, apps/web/src/lib/deploy/
--   compose-check.ts): the resolved `docker compose config --format json` of the
--   app's own compose files and project .env WITHOUT powder's override file, plus
--   the env_file/label_file paths, minus every service's `environment` and minus
--   image tags/digests, keys sorted. The next deploy compares the config it probes
--   with it: a different hash runs the high-severity compose rules enforced (also
--   in warn mode), so a compose change cannot slip through in two pushes. NULL
--   (rows from before this migration, a new app): enforce mode checks everything,
--   warn mode only warns and the success stores the baseline. Nullable, no backfill.
ALTER TABLE "deploys" ADD COLUMN IF NOT EXISTS "compose_config_hash" text;
-- repo_deployment_groups.github_repo_id: GitHub's numeric repository.id for a
--   deployment group (one repo, many sub-apps), the same pin app_repos has since
--   0055. A signed group push naming another repository id is refused. NULL =
--   stored from the first verified push.
ALTER TABLE "repo_deployment_groups" ADD COLUMN IF NOT EXISTS "github_repo_id" bigint;
