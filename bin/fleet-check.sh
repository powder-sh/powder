#!/bin/bash
# fleet-check: curl every app's uptime URL and print `app | url | http | ms`.
# URL resolution mirrors apps/web/src/lib/uptime.ts resolveUrl: health_url when
# absolute http(s); a path joined with the first live app_domains hostname, else
# the server default host (<container>.<servers.base_domain>); no health_url:
# the same host + "/".
#
# Usage: bin/fleet-check.sh [--baseline FILE [--record]]
#   --baseline FILE --record   write the apps that answer (<500) now to FILE
#   --baseline FILE            compare: exit 1 if an app listed in FILE now fails
#   (no FILE, or FILE missing: just prints the table, exit 0)
# Runs from the operator's machine like bin/self-deploy.sh (same ssh target + docker exec psql).
#
# Then, unless --record or FLEET_CHECK_CREDS=0: every registered server is checked
# from the powder host (the key powder deploys with) for root's registry login authority
# (apps/web/src/lib/docker-env.ts): no docker-credential-pass / -secretservice / -desktop
# on the server, and /run/powder-docker-nocreds/config.json, when present, is a regular file
# holding exactly {"auths":{},"credHelpers":{}}. Host keys: a separate known_hosts on the
# powder host (accept-new on first sight, pinned after). Read-only. Prints
# `docker creds: N ok, M failing, K unreachable`; a failing server makes the exit status 3
# (1 stays "uptime regression").
set -uo pipefail

HOST=${POWDER_HOST:?set POWDER_HOST (e.g. root@your-server-ip)}
ENVF=${POWDER_ENV_FILE:-/opt/apps/powder.env}
BASE=""; RECORD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --baseline) BASE=${2:-}; shift ;;
    --record) RECORD=1 ;;
  esac
  shift
done

remote_env() {
  local v
  v=$(ssh "$HOST" "sed -n 's/^$1=//p' $ENVF 2>/dev/null | head -1" 2>/dev/null || true)
  v=${v//\"/}; v=${v//\'/}
  case "$v" in ''|*[!A-Za-z0-9_]*) v='';; esac
  printf '%s' "$v"
}
if [ -z "${POWDER_DB_EXEC:-}" ]; then
  DB_USER=$(remote_env POWDER_DB_USER); DB_USER=${DB_USER:-admin}
  DB_NAME=$(remote_env POWDER_DB_NAME); DB_NAME=${DB_NAME:-powder}
fi
# powder-postgres (postgres on servers not cut over yet).
PG_CT=postgres
if [ -z "${POWDER_DB_EXEC:-}" ]; then
  case "$(ssh "$HOST" 'docker container inspect -f ok powder-postgres 2>/dev/null' 2>/dev/null || true)" in ok) PG_CT=powder-postgres;; esac
fi
DB_EXEC=${POWDER_DB_EXEC:-docker exec $PG_CT psql -U $DB_USER -d $DB_NAME}

SQL="select r.container_name, coalesce(r.health_url,''),
 coalesce((select d.hostname from app_domains d where d.app_repo_id=r.id and d.status='live' and d.preview_deploy_id is null order by d.created_at limit 1),''),
 coalesce((select s.base_domain from servers s where s.id=r.server_id),'')
 from app_repos r order by r.container_name"
ROWS=$(ssh "$HOST" "$DB_EXEC -tA -F '|' -c \"$(printf '%s' "$SQL" | tr '\n' ' ')\"" 2>/dev/null) || { echo "fleet check: could not read app_repos over ssh" >&2; exit 2; }

declare -a FAILING=()
OKAPPS=""; NOK=0
printf '%-28s | %-60s | %-4s | %s\n' app url http ms
while IFS='|' read -r app hurl live base; do
  [ -z "$app" ] && continue
  host=$live; [ -z "$host" ] && [ -n "$base" ] && host="$app.$base"
  url=""
  if [[ "$hurl" =~ ^https?://[^/[:space:]] ]]; then url=$hurl
  elif [ -n "$hurl" ] && [ -n "$host" ]; then case "$hurl" in /*) url="https://$host$hurl";; *) url="https://$host/$hurl";; esac
  elif [ -z "$hurl" ] && [ -n "$host" ]; then url="https://$host/"
  fi
  if [ -z "$url" ]; then printf '%-28s | %-60s | %-4s | %s\n' "$app" "(no url)" "-" "-"; FAILING+=("$app"); continue; fi
  out=$(curl -s -o /dev/null --max-time 10 -w '%{http_code} %{time_total}' "$url" 2>/dev/null || true)
  code=${out%% *}; t=${out#* }; [ -z "$code" ] && code=000
  ms=$(awk -v t="${t:-0}" 'BEGIN{printf "%d", t*1000}')
  printf '%-28s | %-60s | %-4s | %s\n' "$app" "$url" "$code" "$ms"
  if [ "$code" != "000" ] && [ "$code" -lt 500 ] 2>/dev/null; then NOK=$((NOK+1)); OKAPPS="$OKAPPS$app"$'\n'
  else FAILING+=("$app"); fi
done <<< "$ROWS"

echo "$NOK ok, ${#FAILING[@]} failing:${FAILING[*]:+ ${FAILING[*]}}"

CREDS_RC=0
if [ "$RECORD" != "1" ] && [ "${FLEET_CHECK_CREDS:-1}" != "0" ]; then
  SRV=$(ssh "$HOST" "$DB_EXEC -tA -F '|' -c \"select id, host, ssh_user, ssh_port from servers order by id\"" 2>/dev/null) || SRV=""
  # Runs on each server (POSIX sh, read-only).
  CREDS_SH='h=""; for b in docker-credential-pass docker-credential-secretservice docker-credential-desktop; do p=$(command -v "$b" 2>/dev/null) && h="$h $p"; done; f=/run/powder-docker-nocreds/config.json; if [ -L "$f" ]; then c=symlink; elif [ ! -e "$f" ]; then c=absent; elif [ ! -f "$f" ]; then c=not-a-file; elif [ "$(cat "$f" 2>/dev/null)" = '"'"'{"auths":{},"credHelpers":{}}'"'"' ]; then c=empty; else c=HAS-LOGINS; fi; echo "CREDS helpers=[${h# }] nocreds=$c"'
  CREDS_OK=0; declare -a CREDS_BAD=() CREDS_GONE=()
  while IFS='|' read -r sid shost suser sport; do
    [ -z "$sid" ] && continue
    case "$shost$suser$sport" in *[!A-Za-z0-9._:@-]*) CREDS_GONE+=("$sid(odd host)"); continue;; esac
    line=$(printf '%s' "$CREDS_SH" | ssh "$HOST" "ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/powder-fleet-check-known_hosts -p ${sport:-22} ${suser:-root}@$shost sh -s" 2>/dev/null | grep '^CREDS ' | tail -1)
    if [ -z "$line" ]; then CREDS_GONE+=("$sid"); continue; fi
    case "$line" in
      "CREDS helpers=[] nocreds=empty"|"CREDS helpers=[] nocreds=absent") CREDS_OK=$((CREDS_OK+1)) ;;
      *) CREDS_BAD+=("$sid"); echo "docker creds: $sid ${line#CREDS }" ;;
    esac
  done <<< "$SRV"
  echo "docker creds: $CREDS_OK ok, ${#CREDS_BAD[@]} failing, ${#CREDS_GONE[@]} unreachable${CREDS_BAD[*]:+ (failing: ${CREDS_BAD[*]})}${CREDS_GONE[*]:+ (unreachable: ${CREDS_GONE[*]})}"
  [ "${#CREDS_BAD[@]}" -gt 0 ] && CREDS_RC=3
fi

if [ -n "$BASE" ]; then
  if [ "$RECORD" = "1" ]; then
    printf '%s' "$OKAPPS" > "$BASE" && echo "baseline recorded: $BASE"
  elif [ -f "$BASE" ]; then
    REG=()
    for a in "${FAILING[@]:-}"; do [ -n "$a" ] && grep -qxF "$a" "$BASE" && REG+=("$a"); done
    if [ "${#REG[@]}" -gt 0 ]; then echo "✗ regression: reachable before the deploy, failing now: ${REG[*]}" >&2; exit 1; fi
  else
    echo "(no baseline at $BASE: table only)"
  fi
fi
exit $CREDS_RC
