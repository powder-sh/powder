CREATE TABLE "domain_redirects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"container_name" text NOT NULL,
	"hostname" text NOT NULL,
	"www_mode" text DEFAULT 'none' NOT NULL,
	"custom_redirects_json" text DEFAULT '[]' NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "domain_redirects_unique" ON "domain_redirects" USING btree ("server_id","container_name","hostname");