CREATE TABLE "preview_deploys" (
	"id" text PRIMARY KEY NOT NULL,
	"app_repo_id" text NOT NULL,
	"branch" text NOT NULL,
	"branch_slug" text NOT NULL,
	"container_name" text NOT NULL,
	"working_dir" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_deployed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "preview_deploys_app_branch_unique" ON "preview_deploys" USING btree ("app_repo_id","branch_slug");