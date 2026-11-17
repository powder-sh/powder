-- idempotent
DO $$ BEGIN
 CREATE TYPE "env_audit_action" AS ENUM ('create', 'update', 'delete', 'rollback');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "env_audit_actor_kind" AS ENUM ('human_session', 'api_token', 'system');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_env_var_audit" (
 "id" text PRIMARY KEY NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "app_repo_id" text NOT NULL,
 "actor_user_id" text,
 "actor_kind" "env_audit_actor_kind" DEFAULT 'human_session' NOT NULL,
 "actor_ip" text,
 "actor_user_agent" text,
 "action" "env_audit_action" NOT NULL,
 "key" text NOT NULL,
 "scope" "env_scope" NOT NULL,
 "old_value_preview" text,
 "new_value_preview" text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "app_env_var_audit_project_idx" ON "app_env_var_audit" ("app_repo_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_env_var_audit_actor_idx" ON "app_env_var_audit" ("actor_user_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_env_var_versions" (
 "id" text PRIMARY KEY NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "app_repo_id" text NOT NULL,
 "key" text NOT NULL,
 "scope" "env_scope" NOT NULL,
 "value_encrypted" text NOT NULL,
 "value_preview" text DEFAULT '' NOT NULL,
 "set_by_user_id" text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "app_env_var_versions_key_idx" ON "app_env_var_versions" ("app_repo_id", "key", "scope", "created_at");
