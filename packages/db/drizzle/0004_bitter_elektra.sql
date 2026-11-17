CREATE TABLE "app_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"container_name" text NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"webhook_token" text NOT NULL,
	"webhook_secret_encrypted" text NOT NULL,
	"deploy_key_pub" text NOT NULL,
	"deploy_key_priv_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_repos_webhook_token_unique" UNIQUE("webhook_token")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_repos_app_unique" ON "app_repos" USING btree ("server_id","container_name");