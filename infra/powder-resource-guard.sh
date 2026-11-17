#!/bin/bash
# Source of truth for /usr/local/bin/powder-resource-guard on every server (not installed by powder):
#   install -m 755 infra/powder-resource-guard.sh /usr/local/bin/powder-resource-guard
#   printf '%s\n' '*/5 * * * * root /usr/local/bin/powder-resource-guard' '@reboot root sleep 90 && /usr/local/bin/powder-resource-guard' > /etc/cron.d/powder-resource-guard
# Caps each app container's RAM at /opt/apps/.mem-cap (infra images excepted), pins oom_score_adj on postgres/powder-postgres/powder.
# Ends in `exit 0`: the loop's last `[ ] && docker update` returns 1 when the last container
# is already capped, which a cron alert wrapper reports as a failure.
CAP="$(cat /opt/apps/.mem-cap 2>/dev/null || echo 2g)"
for c in postgres powder-postgres powder powder-worker; do
  pid=$(docker inspect -f '{{.State.Pid}}' "$c" 2>/dev/null)
  [ -n "$pid" ] && [ "$pid" != "0" ] && echo -900 > "/proc/$pid/oom_score_adj" 2>/dev/null
done
# a container is left uncapped only when it runs a known infra image: the image
# reference (registry docker.io / index.docker.io and library/ dropped, tag and digest
# dropped) is exactly one of INFRA_REPOS, or it is powder's own database container by
# name. Substrings of the container name or image (an app named `shop-redis-ui`, an
# image `acme/nginx-app`) do not skip the cap. No RepoDigest is required: digest-pinned
# pgvector images often have none locally. An app cannot build or tag one of these
# repo names (compose guard, image ownership rules image_owner / image_name).
INFRA_REPOS=" postgres pgvector/pgvector postgis/postgis timescale/timescaledb timescale/timescaledb-ha mysql mariadb mongo redis valkey/valkey clickhouse/clickhouse-server cockroachdb/cockroach cassandra elasticsearch docker.elastic.co/elasticsearch/elasticsearch rabbitmq memcached nats traefik nginx caddy haproxy louislam/uptime-kuma "
infra_image() {
  local ref repo
  case "$1" in postgres|powder-postgres) return 0 ;; esac
  ref=$(docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null) || return 1
  repo=${ref%%@*}
  case "${repo##*/}" in *:*) repo=${repo%:*} ;; esac
  repo=${repo#docker.io/}; repo=${repo#index.docker.io/}; repo=${repo#library/}
  case "$INFRA_REPOS" in *" $repo "*) return 0 ;; esac
  return 1
}
for c in $(docker ps --format '{{.Names}}'); do
  infra_image "$c" && continue
  lim=$(docker inspect -f '{{.HostConfig.Memory}}' "$c" 2>/dev/null)
  [ "$lim" = "0" ] && docker update --memory="$CAP" --memory-swap="$CAP" "$c" >/dev/null 2>&1
done
exit 0
