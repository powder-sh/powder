-- idempotent
-- post-deploy
-- Single-tenant cleanup: the ship-posts feature, the social-posting integration, the
-- LLM watchdog and the per-user email preferences are gone from the code.
-- The ship_posts rows were draft social posts; nothing reads them.
DROP TABLE IF EXISTS "ship_posts";
DROP TABLE IF EXISTS "diagnoses";
DROP TABLE IF EXISTS "notification_prefs";
DROP TYPE IF EXISTS "diagnosis_kind";
DROP TYPE IF EXISTS "diagnosis_status";
DROP TYPE IF EXISTS "suggested_action_type";
