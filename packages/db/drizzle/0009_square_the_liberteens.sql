CREATE TABLE "ship_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"deploy_id" text,
	"server_id" text NOT NULL,
	"container_name" text NOT NULL,
	"git_sha" text,
	"git_branch" text,
	"commit_messages" text,
	"draft" text NOT NULL,
	"original_draft" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"generation_error" text,
	"sent_to_connection" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
