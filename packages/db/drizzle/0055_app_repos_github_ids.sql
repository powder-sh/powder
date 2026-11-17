-- idempotent
-- GitHub object ids powder creates or connects to. All
-- nullable, no backfill: rows connected before this stay NULL.
--   github_deploy_key_id / github_hook_id: the deploy key and push webhook powder
--     installed at connect (/new, repo import). Disconnect DELETEs both on GitHub
--     (best effort) when they are set.
--   github_repo_id: GitHub's numeric repository.id. A push whose signed payload
--     names another repository id is refused (repo renamed/transferred and the
--     name reused). NULL = stored from the first verified push.
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "github_deploy_key_id" bigint;
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "github_hook_id" bigint;
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "github_repo_id" bigint;
