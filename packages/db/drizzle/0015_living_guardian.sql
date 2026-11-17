CREATE TABLE "app_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"app_repo_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_error" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_domains_unique" ON "app_domains" USING btree ("app_repo_id","hostname");