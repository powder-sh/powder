CREATE TABLE "repo_deployment_groups" (
  "id" text PRIMARY KEY NOT NULL,
  "repo_url" text NOT NULL,
  "branch" text NOT NULL,
  "webhook_token" text NOT NULL,
  "webhook_secret_encrypted" text NOT NULL,
  "deploy_key_pub" text NOT NULL,
  "deploy_key_priv_encrypted" text NOT NULL,
  "owner_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "repo_deployment_groups_webhook_token_unique" ON "repo_deployment_groups" ("webhook_token");
CREATE UNIQUE INDEX "repo_deployment_groups_repo_branch_unique" ON "repo_deployment_groups" ("repo_url", "branch");

ALTER TABLE "app_repos"
  ADD COLUMN "deployment_group_id" text REFERENCES "repo_deployment_groups"("id"),
  ADD COLUMN "dockerfile_path" text NOT NULL DEFAULT './Dockerfile',
  ADD COLUMN "paths_filter" text[],
  ADD COLUMN "pre_deploy_command" text;

CREATE INDEX "app_repos_deployment_group_idx"
  ON "app_repos" ("deployment_group_id") WHERE "deployment_group_id" IS NOT NULL;
