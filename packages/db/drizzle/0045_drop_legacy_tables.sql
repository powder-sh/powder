-- idempotent
-- post-deploy
-- powder is single-tenant: tables no longer used go.
-- 0000 carries tables from an earlier prototype; this migration removes them.
-- Nothing in the code reads or writes them (better-auth runs without the
-- organization plugin). Drops are IF EXISTS; the tables are unused
-- (`organizations`, `users`, `members` may not exist at all).
-- Dependents first so no CASCADE is needed (api_keys -> projects -> organization;
-- member and invitation -> organization).
DROP TABLE IF EXISTS "email_events";
DROP TABLE IF EXISTS "emails";
DROP TABLE IF EXISTS "usage_records";
DROP TABLE IF EXISTS "subscriptions";
DROP TABLE IF EXISTS "webhooks";
DROP TABLE IF EXISTS "domains";
DROP TABLE IF EXISTS "api_keys";
DROP TABLE IF EXISTS "projects";
DROP TABLE IF EXISTS "ip_pools";
DROP TABLE IF EXISTS "invitation";
DROP TABLE IF EXISTS "member";
DROP TABLE IF EXISTS "members";
DROP TABLE IF EXISTS "users";
DROP TABLE IF EXISTS "organization";
DROP TABLE IF EXISTS "organizations";
DROP TYPE IF EXISTS "billing_plan";
DROP TYPE IF EXISTS "plan";
DROP TYPE IF EXISTS "member_role";
DROP TYPE IF EXISTS "domain_status";
DROP TYPE IF EXISTS "email_status";
DROP TYPE IF EXISTS "email_event_type";
DROP TYPE IF EXISTS "ip_pool_status";
DROP TYPE IF EXISTS "webhook_status";
