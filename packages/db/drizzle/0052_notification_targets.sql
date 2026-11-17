-- idempotent
-- Notification targets (lib/notifications.ts). One row per webhook or email
-- address. url_encrypted holds the webhook URL encrypted with
-- POWDER_ENCRYPTION_KEY (lib/crypto.ts); email is the plain address. events is
-- the subscribed event list; app_repo_id NULL = every app.
CREATE TABLE IF NOT EXISTS "notification_targets" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "url_encrypted" text,
  "email" text,
  "events" text[] NOT NULL DEFAULT '{}',
  "app_repo_id" text REFERENCES "app_repos"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_targets_kind_check" CHECK ("kind" IN ('webhook', 'email')),
  CONSTRAINT "notification_targets_dest_check" CHECK (
    ("kind" = 'webhook' AND "url_encrypted" IS NOT NULL)
    OR ("kind" = 'email' AND "email" IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS "notification_targets_app_repo_id_idx" ON "notification_targets" ("app_repo_id");
