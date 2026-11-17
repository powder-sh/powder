-- idempotent
DO $$ BEGIN
 CREATE TYPE "diagnosis_kind" AS ENUM (
  'deploy_failed',
  'app_down',
  'cron_failed',
  'backup_failed',
  'disk_pressure'
 );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "diagnosis_status" AS ENUM (
  'pending_review',
  'approved',
  'applied',
  'auto_applied',
  'failed_to_apply',
  'dismissed'
 );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "suggested_action_type" AS ENUM (
  'investigate_only',
  'wait',
  'restart_container',
  'retry_deploy',
  'reattach_head',
  'rebuild_deploy',
  'fix_env_var',
  'rotate_deploy_key'
 );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "diagnoses" (
 "id" text PRIMARY KEY NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "kind" "diagnosis_kind" NOT NULL,
 "server_id" text NOT NULL,
 "container_name" text,
 "ref_id" text NOT NULL,
 "signal_summary" text NOT NULL,
 "diagnosis" text,
 "suggested_fix" text,
 "suggested_action_type" "suggested_action_type" DEFAULT 'investigate_only' NOT NULL,
 "suggested_action_params" jsonb,
 "status" "diagnosis_status" DEFAULT 'pending_review' NOT NULL,
 "reviewer_user_id" text,
 "reviewed_at" timestamp with time zone,
 "applied_at" timestamp with time zone,
 "apply_output" text
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "diagnoses_kind_ref_uniq" ON "diagnoses" ("kind", "ref_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagnoses_status_created_idx" ON "diagnoses" ("status", "created_at");
