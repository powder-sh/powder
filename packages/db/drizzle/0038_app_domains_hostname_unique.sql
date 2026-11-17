-- idempotent
-- A hostname can belong to only one app. Hand-apply (idempotent).
-- Does NOT delete rows. If duplicates exist the index is skipped with a NOTICE;
-- list and resolve them, then re-run:
--   SELECT lower(hostname), count(*), array_agg(app_repo_id) FROM app_domains
--   GROUP BY 1 HAVING count(*) > 1;
-- verify_challenge already exists (0022); rows without one get a token on the
-- next verify attempt.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_domains GROUP BY lower(hostname) HAVING count(*) > 1) THEN
    RAISE NOTICE 'app_domains_hostname_global NOT created: duplicate hostnames exist';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "app_domains_hostname_global" ON "app_domains" (lower("hostname"));
  END IF;
END $$;
