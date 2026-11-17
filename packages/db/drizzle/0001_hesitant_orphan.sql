ALTER TYPE "public"."deploy_kind" ADD VALUE 'git_deploy';--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "git_sha" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "git_branch" text;