ALTER TABLE "app_domains" ADD COLUMN "verify_challenge" text;--> statement-breakpoint
ALTER TABLE "app_domains" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_domains" ADD COLUMN "applied_error" text;
