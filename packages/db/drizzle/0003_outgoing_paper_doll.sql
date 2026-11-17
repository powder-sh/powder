ALTER TYPE "public"."deploy_kind" ADD VALUE 'rollback';--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "image_tag" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "rolled_back_from_id" text;