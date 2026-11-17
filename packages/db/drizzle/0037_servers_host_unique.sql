-- idempotent
-- One servers row per host. Hand-apply (idempotent), like 0035/0036.
-- Skips (NOTICE) instead of failing when duplicates already exist; find them:
--   SELECT lower(host), count(*) FROM servers GROUP BY 1 HAVING count(*) > 1;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM servers GROUP BY lower(host) HAVING count(*) > 1) THEN
    RAISE NOTICE 'servers_host_unique NOT created: duplicate hosts exist';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "servers_host_unique" ON "servers" (lower("host"));
  END IF;
END $$;
