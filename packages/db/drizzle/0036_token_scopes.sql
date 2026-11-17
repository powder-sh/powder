-- idempotent
-- Scoped + expiring API tokens.
-- scopes NULL = full access (every existing token keeps working); a
-- non-null list restricts the token to those "METHOD /path/pattern" routes.
-- Must be applied BEFORE the code that selects these columns deploys —
-- powder's self-deploy doesn't run migrations (hand-apply, idempotent).
ALTER TABLE "user_api_tokens" ADD COLUMN IF NOT EXISTS "scopes" text[];
ALTER TABLE "user_api_tokens" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
