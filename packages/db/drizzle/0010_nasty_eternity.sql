ALTER TABLE "app_repos" ADD COLUMN "mcp_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "app_repos" ADD COLUMN "mcp_manifest_json" text;--> statement-breakpoint
ALTER TABLE "app_repos" ADD COLUMN "mcp_manifest_read_at" timestamp with time zone;