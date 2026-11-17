ALTER TABLE "deploys" ADD COLUMN "snapshot_container" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "snapshot_url" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "snapshot_expires_at" timestamp with time zone;