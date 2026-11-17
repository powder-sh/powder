-- idempotent
-- Explicit deploy-mode contract per app.
-- 'auto' infers the mode from the compose file's build: key.
-- 'build' / 'registry' declare the mode; the deploy preflight fails loudly on a
-- mismatch instead of silently falling back to the other path. Motivation: a
-- compose hand-edit that breaks `docker compose config` makes the HAS_BUILD
-- inference read empty output as "no build key", and every deploy then silently
-- attempts a registry pull that can never succeed.
ALTER TABLE "app_repos" ADD COLUMN IF NOT EXISTS "build_mode" text NOT NULL DEFAULT 'auto';
