-- idempotent
-- servers.traefik_network: the Docker network the server's Traefik routes over, as
-- powder last resolved it, and servers.traefik_network_source: where that came from
-- (flag | config | attached | default). Only flag and config (the operator's own
-- declaration) move powder's apps off `web` or widen the compose guard; it was resolved from the running traefik container (apps/web/src/lib/traefik-network.ts:
-- its --providers.docker.network flag, else providers.docker.network in its mounted
-- config file, else the network it is attached to). Written by the server check and by
-- the features that attach a container for Traefik to route (new apps, previews, URL
-- snapshots, the rollback bridge); the deploy's compose guard reads both so a declared
-- Traefik network counts as shared on that server. NULL = not resolved yet (or no
-- Traefik server): powder uses `web`, as before.
-- Nullable with no default: a catalog-only change, and the previous release (which
-- never names the column) keeps working.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "traefik_network" text;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "traefik_network_source" text;
