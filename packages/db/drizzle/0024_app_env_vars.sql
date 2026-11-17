-- idempotent
DO $$ BEGIN
 CREATE TYPE "env_scope" AS ENUM ('production', 'preview', 'development');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_env_vars" (
 "id" text PRIMARY KEY NOT NULL,
 "app_repo_id" text NOT NULL,
 "key" text NOT NULL,
 "scope" "env_scope" DEFAULT 'production' NOT NULL,
 "value_encrypted" text NOT NULL,
 "value_preview" text DEFAULT '' NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "last_rotated_at" timestamp with time zone,
 "created_by_user_id" text
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "app_env_vars_repo_key_scope_uniq" ON "app_env_vars" ("app_repo_id", "key", "scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_env_vars_project_idx" ON "app_env_vars" ("app_repo_id", "scope");
