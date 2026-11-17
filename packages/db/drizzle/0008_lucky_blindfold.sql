CREATE TABLE "cron_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"container_name" text NOT NULL,
	"schedule" text NOT NULL,
	"kind" text DEFAULT 'http' NOT NULL,
	"url_path" text,
	"exec_command" text,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"last_run_error" text,
	"last_run_http_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_repos" ADD COLUMN "cron_token_encrypted" text;