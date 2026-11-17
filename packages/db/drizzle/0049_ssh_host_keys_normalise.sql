-- idempotent
-- pinKey lowercases and trims the host, so rows written earlier under a
-- mixed-case or padded host were orphaned: the next connection pinned a SECOND key for the
-- same server on first use. Normalise the existing rows. On a conflict (a normalised row
-- already exists) the EXISTING normalised row wins and the stray one is dropped. Several
-- stray rows that normalise to the same host: the oldest (first_seen_at) is kept.
UPDATE "ssh_host_keys" t
   SET "host" = lower(btrim(t."host"))
 WHERE t."host" <> lower(btrim(t."host"))
   AND NOT EXISTS (SELECT 1 FROM "ssh_host_keys" x WHERE x."host" = lower(btrim(t."host")))
   AND t."ctid" = (
         SELECT y."ctid" FROM "ssh_host_keys" y
          WHERE lower(btrim(y."host")) = lower(btrim(t."host"))
          ORDER BY y."first_seen_at", y."host" LIMIT 1
       );
DELETE FROM "ssh_host_keys" WHERE "host" <> lower(btrim("host"));
