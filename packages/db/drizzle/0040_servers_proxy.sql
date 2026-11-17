-- idempotent
-- Per-server routing mode, replacing the hardcoded TRAEFIK_SERVERS list.
--   proxy:    'nginx' (default; host or containerised nginx + host port) | 'traefik'
--   tls_mode: 'acme' (default; Traefik HTTP-01 via certresolver le) |
--             'origin-cert' (Cloudflare origin cert on the Traefik default store,
--             no certresolver label). Only read when proxy = 'traefik'.
-- Hand-apply (idempotent), BEFORE deploying the powder build that reads them:
--   psql ... -f 0040_servers_proxy.sql
-- Change a server later with plain SQL, e.g.
--   UPDATE servers SET proxy = 'traefik', tls_mode = 'origin-cert' WHERE id = '<server id>';
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "proxy" text NOT NULL DEFAULT 'nginx';
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "tls_mode" text NOT NULL DEFAULT 'acme';
-- A server that was in the old hardcoded TRAEFIK_SERVERS list (matched on servers.id,
-- not servers.name) needs proxy = 'traefik' set with the UPDATE above. The one
-- install that had such a list applied it when this file first ran.
