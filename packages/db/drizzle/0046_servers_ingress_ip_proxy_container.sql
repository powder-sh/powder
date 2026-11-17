-- idempotent
-- Single-tenant cleanup: two env lists become per-server columns.
--   servers.ingress_ip: public IPv4 a custom domain's A record must point at.
--     Replaces an env list of serverId=ip pairs. NULL = use servers.host when it is an IPv4
--     literal, else resolve the host name (a server whose host is its public IP
--     needs no value).
--   servers.proxy = 'nginx-container': nginx runs in a container. Replaces
--     POWDER_NGINX_CONTAINER_SERVERS: set it per server with
--     update servers set proxy = 'nginx-container' where id = '<server id>';
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "ingress_ip" text;
