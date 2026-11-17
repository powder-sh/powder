-- idempotent
-- queued_at: when the deploy row was inserted (never overwritten). started_at is
-- reset to the claim time by claimNextQueuedDeploy, so queue wait was invisible.
-- Backfill with started_at for existing rows (best available approximation).
ALTER TABLE "deploys" ADD COLUMN IF NOT EXISTS "queued_at" timestamptz;
UPDATE "deploys" SET "queued_at" = "started_at" WHERE "queued_at" IS NULL;
ALTER TABLE "deploys" ALTER COLUMN "queued_at" SET DEFAULT now();
ALTER TABLE "deploys" ALTER COLUMN "queued_at" SET NOT NULL;
