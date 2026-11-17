CREATE TABLE "app_uptime_checks" (
	"app_repo_id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status_code" integer,
	"is_up" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_down_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email_on_deploy_fail" boolean DEFAULT true NOT NULL,
	"email_on_app_down" boolean DEFAULT true NOT NULL,
	"down_cooldown_minutes" integer DEFAULT 15 NOT NULL,
	"ai_ship_posts_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
