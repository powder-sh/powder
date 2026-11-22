#!/bin/bash
# self-deploy: deploy powder itself, from this checkout, to the server it runs on.
#
# Powder's deploys execute in the `worker` container (claim loop), so BOTH
# `powder` and `worker` are rebuilt + recreated together. Rebuilding only
# `powder` would ship new code to the dashboard while every actual deploy keeps
# running OLD code.
#
# Configuration (env, or a .powder-deploy.env file next to this script):
#   POWDER_HOST        required  e.g. root@203.0.113.7
#   POWDER_SRC         default   /opt/apps/powder/src   (where the source lives ON the server; [A-Za-z0-9_./-] only)
#   POWDER_ENV_FILE    default   /opt/apps/powder.env   (the env file ON the server; passed to every compose call)
#   POWDER_COMPOSE_PROJECT optional  compose project name, passed as `-p` to build/up (default: compose's own)
#   POWDER_DB_EXEC     default   "docker exec <db> psql -U <POWDER_DB_USER> -d <POWDER_DB_NAME>"
#   POWDER_DB_PSQL     default   "docker exec -i <db> psql -v ON_ERROR_STOP=1 -U <user> -d <name>"  (reads SQL on stdin)
#                      <db> is powder-postgres, or postgres on a shared-network-layout server (detected)
#                      <user>/<name> are read from POWDER_DB_USER / POWDER_DB_NAME in /opt/apps/powder.env
#                      on the server (admin / powder when unset there).
#   POWDER_HEALTH_URL  default   http://127.0.0.1:<POWDER_PORT or 3050>/api/health  (checked ON the host;
#                      a plain http(s)://host[:port]/path, no query)
#   POWDER_PUBLIC_URL  optional  e.g. https://powder.example.com (final outside-in check)
#
# Post-deploy hook (optional, opt-in by file): when the server has an executable
# /usr/local/bin/powder-post-deploy, a green deploy runs it there as
# `powder-post-deploy <sha>`, e.g. to record the deploy in your monitoring.
# A failing hook is reported but never fails the deploy.
#
# Usage: bin/self-deploy.sh [--force] [--skip-tests] [--allow-dirty] [--skip-migrations] [--baseline] [--db-network-cutover] [--pin-report]
# Run from the repo root after git push.
#   Refuses a dirty tree unless --allow-dirty (only the committed HEAD ships).
#   Runs the unit tests first when apps/web has its dependencies installed;
#   --skip-tests skips them.
#   --force: recreate even while deploys are in flight (they are killed). A DB that
#   does not answer still stops the run unless --skip-migrations is also given (the
#   migrations step needs the DB). --pin-report always needs it: the report reads
#   powder's DB.
#   --pin-report: print the env render target report (apps/web/src/env-pin-report.ts:
#   every app whose env file is outside its own dir, whether powder keeps that target,
#   and the exact SQL to pin the ones it would refuse), then stop: no migrations,
#   nothing recreated. A report that fails (the DB does not answer, the image does
#   not run) fails the run. It still rsyncs the committed tree into $POWDER_SRC on the
#   server (--delete) and holds the server build lock while it builds; the images are
#   tagged powder:pin-report / powder-worker:pin-report (docker-compose.pin-report.yml),
#   never :latest. A normal run prints the same report before the recreate.
#
# Ships `git archive HEAD` only (committed code): untracked files such as apps/web/.env.local, key files or
# notes never reach the server or an image, and migrations are applied from the
# same archive, never from the working tree.
#
# Schema first: before anything is built or recreated, packages/db/drizzle/*.sql
# are applied to powder's database through bin/lib-migrations.sh (files marked
# `-- idempotent` run; any unrecorded unmarked file aborts). There is no implicit
# baseline: --baseline records the pinned list in bin/lib-migrations.sh as
# applied (installs older than the migration ledger, first run only). Files marked `-- post-deploy` run
# after the recreate instead of before. --skip-migrations skips that step, and
# the recreate then passes POWDER_SKIP_BOOT_MIGRATIONS=1 so the new powder
# container does not re-apply (and crash-loop on) the skipped files at boot
# (docker/powder-entrypoint.sh). The next run without the flag clears it.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f bin/.powder-deploy.env ] && . bin/.powder-deploy.env

HOST=${POWDER_HOST:?set POWDER_HOST (e.g. root@your-server-ip)}
SRC=${POWDER_SRC:-/opt/apps/powder/src}
# SRC, ENVF and PROJ reach remote shell strings unquoted: plain characters only.
case "$SRC" in *[!A-Za-z0-9_./-]*|'') echo "✗ POWDER_SRC must be a plain path" >&2; exit 1;; esac
ENVF=${POWDER_ENV_FILE:-/opt/apps/powder.env}
case "$ENVF" in *[!A-Za-z0-9_./-]*|'') echo "✗ POWDER_ENV_FILE must be a plain path" >&2; exit 1;; esac
# compose reads ${POWDER_ENV_FILE} for the services' env_file; pass it on every call.
# POWDER_COMPOSE_PROJECT (optional) is passed as `-p`; unset keeps compose's default project name.
PROJ=${POWDER_COMPOSE_PROJECT:-}
case "$PROJ" in *[!A-Za-z0-9_-]*) echo "✗ POWDER_COMPOSE_PROJECT must match [A-Za-z0-9_-]+" >&2; exit 1;; esac
DC="POWDER_ENV_FILE=$ENVF docker compose ${PROJ:+-p $PROJ }--env-file $ENVF"
# Prints the server's build cache id, creating it once (same snippet as
# BUILD_CACHE_ID_SH in apps/web/src/lib/deploy/self-deploy.ts).
BUILD_CACHE_ID_SH='f=/opt/apps/.powder-build-cache-id; if [ ! -s "$f" ] && [ -d /opt/apps ]; then (umask 077; od -An -N16 -tx1 /dev/urandom | tr -d " \n" > "$f") 2>/dev/null; fi; cat "$f" 2>/dev/null'
# DB user/name default to POWDER_DB_USER / POWDER_DB_NAME from powder.env on the
# server (the same values docker-compose.yml gives the bundled postgres), falling
# back to admin / powder when the file does not define them.
remote_env() {
  local v
  v=$(ssh "$HOST" "sed -n 's/^$1=//p' $ENVF 2>/dev/null | head -1" 2>/dev/null || true)
  v=${v//\"/}; v=${v//\'/}
  # only a plain identifier ever reaches the docker exec command line
  case "$v" in ''|*[!A-Za-z0-9_]*) v='';; esac
  printf '%s' "$v"
}
if [ -z "${POWDER_DB_EXEC:-}" ] || [ -z "${POWDER_DB_PSQL:-}" ]; then
  DB_USER=$(remote_env POWDER_DB_USER); DB_USER=${DB_USER:-admin}
  DB_NAME=$(remote_env POWDER_DB_NAME); DB_NAME=${DB_NAME:-powder}
fi
# DB network layout. The default compose puts the DB on the private
# powder-db network as `powder-postgres` (only powder + worker reach it). A server
# where it runs as `postgres` on the shared `internal` network (the shared-network layout) is
# detected and kept (docker-compose.shared-db.yml) with a loud warning, never a refusal.
#   POWDER_DB_NETWORK unset   -> detected on the server (below)
#   POWDER_DB_NETWORK=shared  -> shared-network layout on purpose (still warned)
#   POWDER_DB_NETWORK=private -> private layout; a server still on `postgres` needs
#                                --db-network-cutover (docs/SELF-HOSTING.md)
DB_NET=$(remote_env POWDER_DB_NETWORK)
case "$DB_NET" in ''|shared|private) ;;
  *) echo "✗ POWDER_DB_NETWORK in $ENVF must be 'private', 'shared' or unset (got: $DB_NET)" >&2; exit 1 ;; esac
# What the server runs now: `private`, `legacy` (the shared-network layout) or `fresh`
# (no DB yet), by the one rule in bin/lib-db-layout.sh (also used by bin/install.sh
# and the dashboard self-deploy). POWDER_DATA_DIR is the parent of powder-pgdata
# (default /opt/apps).
DATA_DIR=$(ssh "$HOST" "sed -n 's/^POWDER_DATA_DIR=//p' $ENVF 2>/dev/null | head -1" 2>/dev/null || true)
DATA_DIR=${DATA_DIR//\"/}; DATA_DIR=${DATA_DIR//\'/}
case "$DATA_DIR" in ''|*[!A-Za-z0-9_./-]*) DATA_DIR=/opt/apps;; esac
# shellcheck source=bin/lib-db-layout.sh
. bin/lib-db-layout.sh
DB_LAYOUT=$(ssh "$HOST" "PDB_DIR=$DATA_DIR; PDB_ENVF=$ENVF; $POWDER_DB_LAYOUT_SH" 2>/dev/null | tr -d '\r' | awk 'NF { l = $0 } END { print l }' || true)
# Fails closed (the last non-empty line, so a login banner before it is fine): an
# unknown layout would pick the wrong compose files and recreate powder onto a network
# where it cannot reach its DB.
case "$DB_LAYOUT" in private|legacy|fresh) ;;
  *) echo "✗ could not detect the DB layout of powder's server (got: ${DB_LAYOUT:-nothing}). Nothing was changed. Check that 'ssh $HOST' works, that docker runs there (docker ps -a --filter name=postgres) and that DATABASE_URL in $ENVF names the DB host." >&2; exit 1 ;; esac
[ -z "$DB_NET" ] && { [ "$DB_LAYOUT" = legacy ] && DB_NET=shared || DB_NET=private; }
if [ "$DB_NET" = shared ]; then
  echo "⚠ WARNING: powder's DB runs in the shared-network layout: container 'postgres' on the shared 'internal' network, where every app on that network can reach it or take its name. Move it to the private powder-db network: docs/SELF-HOSTING.md \"DB network cutover\" (set POWDER_DB_NETWORK=shared in $ENVF to keep it on purpose; this warning stays)." >&2
fi
# The env file holds POWDER_ENCRYPTION_KEY, BETTER_AUTH_SECRET, the DB password and
# more: warn (never refuse, so an existing install keeps deploying) when group or
# other may read it.
ENV_MODE=$(ssh "$HOST" "stat -c %a $ENVF 2>/dev/null" 2>/dev/null || true)
case "$ENV_MODE" in
  [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7])
    if [ "${ENV_MODE: -2}" != 00 ]; then
      echo "⚠ WARNING: $ENVF on the server is mode $ENV_MODE: group/other can read powder's secrets (POWDER_ENCRYPTION_KEY, BETTER_AUTH_SECRET, the DB password). Fix it on the server: chmod 600 $ENVF" >&2
    fi ;;
esac
# The bundled DB container the psql/exec commands use.
PG_CT=powder-postgres
[ "$DB_LAYOUT" = legacy ] && PG_CT=postgres
DB_EXEC=${POWDER_DB_EXEC:-docker exec $PG_CT psql -U $DB_USER -d $DB_NAME}
DB_PSQL=${POWDER_DB_PSQL:-docker exec -i $PG_CT psql -v ON_ERROR_STOP=1 -U $DB_USER -d $DB_NAME}
# Container hardening: docker-compose.yml runs powder and worker with
# cap_drop ALL + no-new-privileges. POWDER_HARDEN=false opts out
# (docker-compose.unharden.yml); unset or true keeps it.
HARDEN=$(remote_env POWDER_HARDEN)
case "$HARDEN" in ''|true|false) ;; *) echo "✗ POWDER_HARDEN in $ENVF must be true or false (got: $HARDEN)" >&2; exit 1 ;; esac
# POWDER_WEB_READONLY=true: read-only web root fs (docker-compose.web-readonly.yml).
WEB_RO=$(remote_env POWDER_WEB_READONLY)
case "$WEB_RO" in ''|true|false) ;; *) echo "✗ POWDER_WEB_READONLY in $ENVF must be true or false (got: $WEB_RO)" >&2; exit 1 ;; esac
if [ "$DB_NET" = shared ] || [ "$HARDEN" = false ] || [ "$WEB_RO" = true ]; then
  DC="$DC -f docker-compose.yml"
  [ "$DB_NET" = shared ] && DC="$DC -f docker-compose.shared-db.yml"
  [ "$HARDEN" = false ] && DC="$DC -f docker-compose.unharden.yml"
  [ "$WEB_RO" = true ] && DC="$DC -f docker-compose.web-readonly.yml"
fi
if [ -z "${POWDER_HEALTH_URL:-}" ]; then
  PORT_NUM=$(remote_env POWDER_PORT); case "$PORT_NUM" in ''|*[!0-9]*) PORT_NUM=3050;; esac
fi
HEALTH_URL=${POWDER_HEALTH_URL:-http://127.0.0.1:$PORT_NUM/api/health}
# Reaches a remote shell string: a plain http(s) URL only (no quotes, spaces, ;, $, ?).
[[ "$HEALTH_URL" =~ ^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._/~-]*)?$ ]] || { echo "✗ POWDER_HEALTH_URL must be a plain http(s) URL (host[:port] and a path of [A-Za-z0-9._/~-])" >&2; exit 1; }

FORCE=0
SKIP_MIGRATIONS=0
SKIP_TESTS=0
ALLOW_DIRTY=0
BASELINE=0
DB_CUTOVER=0
PIN_REPORT=0
for arg in "$@"; do
  [ "$arg" = "--db-network-cutover" ] && DB_CUTOVER=1
  [ "$arg" = "--force" ] && FORCE=1
  [ "$arg" = "--skip-migrations" ] && SKIP_MIGRATIONS=1
  [ "$arg" = "--skip-tests" ] && SKIP_TESTS=1
  [ "$arg" = "--allow-dirty" ] && ALLOW_DIRTY=1
  [ "$arg" = "--baseline" ] && BASELINE=1
  [ "$arg" = "--pin-report" ] && PIN_REPORT=1
done
# --pin-report builds powder:pin-report / powder-worker:pin-report, never :latest.
if [ "$PIN_REPORT" = "1" ]; then
  case "$DC" in *" -f "*) ;; *) DC="$DC -f docker-compose.yml" ;; esac
  DC="$DC -f docker-compose.pin-report.yml"
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  if [ "$ALLOW_DIRTY" != "1" ]; then
    echo "✗ working tree is dirty; commit or stash, or pass --allow-dirty (only the committed HEAD is deployed)" >&2
    exit 1
  fi
  echo "⚠ uncommitted changes are NOT shipped: only the committed HEAD ($(git rev-parse --short HEAD)) is deployed." >&2
fi
if [ -n "$(git log --oneline @{u}.. 2>/dev/null)" ]; then
  echo "⚠ local commits not pushed (git is the source of truth). Push first." >&2
fi

# Test gate: the deploy engine's unit tests run BEFORE anything leaves this
# machine. Skipped when apps/web has no installed dependencies (a deploy-only
# checkout) or with --skip-tests.
if [ "$SKIP_TESTS" != "1" ] && [ -d apps/web/node_modules ]; then
  echo "── unit tests (deploy gate) ──"
  if ! (cd apps/web && pnpm -s test); then
    echo "✗ tests failed - NOT deploying. Fix them (or --skip-tests in a real emergency)." >&2
    exit 1
  fi
fi

# Recreating powder/worker kills any in-flight deploy mid-build and leaves an
# orphaned `running` row. Never recreate while deploys are active: a fast
# refuse here, and a wait-for-quiet re-check immediately before the `up`.
# A push HELD on its settle window is not in flight: it waits in its row and the new
# worker claims it after the recreate. POWDER_HELD_SQL is a copy of heldSql('d') in
# apps/web/src/lib/deploy-settle.ts (deploy-settle-scripts.test.ts keeps them identical).
# On a database without those columns (migration 0063 not applied yet) every queued
# row counts as in flight.
POWDER_HELD_SQL="(d.status = 'queued' AND d.not_before IS NOT NULL AND d.not_before > now() AND coalesce((SELECT s.deploy_settle_seconds FROM app_repos s WHERE s.server_id = d.server_id AND s.container_name = d.container_name AND s.deploy_settle_seconds >= 0 LIMIT 1), (SELECT floor(btrim(m.value)::numeric) FROM powder_meta m WHERE m.key = 'deploy_settle_seconds' AND btrim(m.value) = substring(btrim(m.value) from '^[0-9]+(?:[.][0-9]+)?')), 0) >= 1)"
inflight_count() {
  local cols n q
  # (the SQL has no double quote, backslash, $ or backtick: safe inside the remote "...")
  cols=$(ssh "$HOST" "$DB_EXEC -tA -c \"select count(*) from information_schema.columns where table_schema = current_schema() and ((table_name = 'deploys' and column_name = 'not_before') or (table_name = 'app_repos' and column_name = 'deploy_settle_seconds')) -- powder:inflight-cols\"" 2>/dev/null | tr -d '[:space:]') || cols=""
  if [ "$cols" = 2 ]; then
    q="select count(*) from deploys d where d.status in ('running','queued') and not $POWDER_HELD_SQL"
  else
    q="select count(*) from deploys where status in ('running','queued')"
  fi
  n=$(ssh "$HOST" "$DB_EXEC -tA -c \"$q\"" 2>/dev/null | tr -d '[:space:]') || n=""
  case "$n" in ''|*[!0-9]*) echo "?" ;; *) echo "$n" ;; esac
}
# `?`: the in-flight query got no number, so powder's DB did not answer.
db_down_msg() {
  echo "✗ could not query powder's DB (container $PG_CT not running? check: ssh $HOST docker ps -a --filter name=$PG_CT)" >&2
}
INFLIGHT=$(inflight_count)
if [ "$INFLIGHT" = "?" ]; then
  db_down_msg
  # --force skips only the in-flight check. The migrations step and the pin report
  # read the DB, so a run that applies migrations or prints the report stops here;
  # with --skip-migrations no later step needs it and --force continues.
  if [ "$FORCE" != "1" ]; then
    echo "  Nothing was changed. Start the DB and re-run." >&2
    exit 1
  elif [ "$PIN_REPORT" = "1" ]; then
    echo "  Nothing was changed: --pin-report reads powder's DB. Start the DB and re-run." >&2
    exit 1
  elif [ "$SKIP_MIGRATIONS" != "1" ]; then
    echo "  Nothing was changed: --force skips only the in-flight check, and the migrations step needs the DB. Start the DB and re-run (or add --skip-migrations to recreate powder without it)." >&2
    exit 1
  fi
  echo "⚠ --force: continuing without the in-flight check and without the DB (no later step of this run needs it)." >&2
  INFLIGHT=0
fi
if [ "$INFLIGHT" != "0" ] && [ "$FORCE" != "1" ]; then
  echo "✗ $INFLIGHT deploy(s) in flight — restarting powder would orphan them." >&2
  echo "  Wait for them to finish, or re-run with --force." >&2
  exit 1
fi

# Extract the committed tree once; migrations and rsync both read from it, so
# only committed code and SQL ever ships.
ARCHIVE_DIR=$(mktemp -d)
trap 'rm -rf "$ARCHIVE_DIR"' EXIT
git archive HEAD | tar -x -C "$ARCHIVE_DIR"
DEPLOYED_SHA=$(git rev-parse --short=12 HEAD)   # the commit being shipped, for the post-deploy hook

# DB network cutover: a shared-network server with POWDER_DB_NETWORK=private moves its DB to
# powder-postgres on the private powder-db network. Recreating only powder+worker
# would leave them unable to reach the old `postgres` container, so that first run
# needs the explicit flag (steps: docs/SELF-HOSTING.md "DB network cutover"). Shared-network
# servers without POWDER_DB_NETWORK=private keep their layout and are never refused.
NEEDS_DB_CUTOVER=0
if [ "$DB_NET" = private ] && [ "$DB_LAYOUT" = legacy ] && [ -z "${POWDER_DB_EXEC:-}" ]; then
  if [ "$DB_CUTOVER" != "1" ]; then
    echo "✗ POWDER_DB_NETWORK=private moves powder's DB to the private powder-db network (container powder-postgres), and this server still runs it as 'postgres'. Follow docs/SELF-HOSTING.md \"DB network cutover\", then re-run with --db-network-cutover." >&2
    exit 1
  fi
  if ! ssh "$HOST" "grep -q '^DATABASE_URL=.*@powder-postgres:' $ENVF"; then
    echo "✗ --db-network-cutover: DATABASE_URL in $ENVF must use the host powder-postgres first (see docs/SELF-HOSTING.md \"DB network cutover\")." >&2
    exit 1
  fi
  NEEDS_DB_CUTOVER=1
fi

# Preflight: a dashboard host in powder.env must render a Traefik router. An
# empty traefik.enable would unroute the dashboard on the next recreate.
echo "── preflight: traefik labels ──"
# Renders the NEW (committed) compose file, piped on stdin, against the server's
# powder.env, so a bad preflight leaves the server untouched (runs before any
# migration or rsync).
TRAEFIK_CHECK=$(ssh "$HOST" "cd $SRC 2>/dev/null || cd /; if grep -q '^POWDER_DASHBOARD_HOST=.' $ENVF; then POWDER_ENV_FILE=$ENVF docker compose --env-file $ENVF -f - config 2>/dev/null | grep -c 'traefik.enable: \"true\"' || true; else echo skip; fi" < "$ARCHIVE_DIR/docker-compose.yml") || TRAEFIK_CHECK=error
case "$TRAEFIK_CHECK" in
  skip) echo "  POWDER_DASHBOARD_HOST not set: no Traefik labels expected" ;;
  ''|*[!0-9]*|0) echo "✗ POWDER_DASHBOARD_HOST is set but docker compose renders no traefik.enable=true (got: ${TRAEFIK_CHECK:-nothing}) - NOT deploying; the dashboard would drop out of Traefik." >&2; exit 1 ;;
esac


# Schema first: code must never run ahead of the schema (bin/lib-migrations.sh).
# shellcheck source=bin/lib-migrations.sh
. "$ARCHIVE_DIR/bin/lib-migrations.sh"
psql_run() { ssh "$HOST" "$DB_PSQL" "$@"; }
MIG_DIR="$ARCHIVE_DIR/packages/db/drizzle"
if [ "$PIN_REPORT" = "1" ]; then
  echo "── --pin-report: migrations skipped, nothing will be recreated ──"
elif [ "$SKIP_MIGRATIONS" != "1" ]; then
  echo "── migrations ──"
  apply_migrations pre $([ "$BASELINE" = "1" ] && echo --baseline) || { echo "✗ migrations failed - NOT deploying (--skip-migrations in an emergency; it also skips the new container's boot-time migrations for that deploy)." >&2; exit 1; }
else
  echo "⚠ --skip-migrations: schema step skipped, and the recreated powder container skips its boot-time migrations too (POWDER_SKIP_BOOT_MIGRATIONS=1 until the next deploy without the flag)" >&2
fi

echo "── rsync source → $HOST:$SRC ──"
rsync -az --delete \
  --exclude=node_modules --exclude=.next --exclude=.git --exclude=.turbo --exclude=.claude --exclude=.env \
  "$ARCHIVE_DIR/" "$HOST:$SRC/"

echo "── build powder AND worker (under the server build lock) ──"
# pipefail is load-bearing: without it, `build … | tail` reports tail's exit
# (0), so a FAILED build still runs `up` → recreates powder on the OLD image —
# a silent "deploy succeeded, ships old code".
# powder and worker are two targets (runner, runner-worker) of ONE Dockerfile that
# share the `builder` stage (the Next build). Build them one after the other
# under the same lock: the second build reuses the first one's cached builder
# stage, so the server never runs two Next builds at once and compiles only once.
# powder's own BuildKit cache mounts are keyed by a random per-server id
# (docker/web.Dockerfile), so no app build or base-image ONBUILD can name them.
# Created once, read back as hex; any failure builds with an empty id (still
# distinct from every app's cache id, just not secret) instead of failing.
BCID=$(ssh "$HOST" "$BUILD_CACHE_ID_SH" 2>/dev/null || true)
case "$BCID" in *[!0-9a-f]*|'') echo "⚠ no build cache id on the server (/opt/apps/.powder-build-cache-id); building with an empty one" >&2; BCID= ;; esac
# The ISO week the build passes as OS_PATCH_WEEK (docker/web.Dockerfile): the OS
# upgrade layers re-run once a week instead of staying cached forever. Same snippet
# as OS_PATCH_WEEK_SH in apps/web/src/lib/build-cache.ts.
OS_PATCH_WEEK_SH='OS_PATCH_WEEK=$(date -u +%G-W%V 2>/dev/null || true); case "$OS_PATCH_WEEK" in [0-9][0-9][0-9][0-9]-W[0-9][0-9]) ;; *) OS_PATCH_WEEK= ;; esac'
eval "$OS_PATCH_WEEK_SH"
# The server build lock (BUILD_LOCK in apps/web/src/lib/build-lock.ts). The build also
# waits on the lock at the older path (OLDER_BUILD_LOCK below) when it is a regular
# root-owned file (only root can create or remove it in sticky /tmp), so an upgrade
# started while a build holds that lock cannot run two builds at once.
BUILD_LOCK=/run/powder-build.lock
OLDER_BUILD_LOCK=/tmp/powder-build.lock
ssh "$HOST" "cd $SRC && PBL=; if [ -f $OLDER_BUILD_LOCK ] && [ ! -L $OLDER_BUILD_LOCK ] && [ \"\$(stat -c %u $OLDER_BUILD_LOCK 2>/dev/null)\" = 0 ]; then PBL='flock -w 2400 $OLDER_BUILD_LOCK'; fi; flock -w 2400 $BUILD_LOCK \$PBL bash -lc '\
  set -eo pipefail; \
  POWDER_BUILD_CACHE_ID=$BCID OS_PATCH_WEEK=$OS_PATCH_WEEK $DC build powder 2>&1 | tail -8; \
  POWDER_BUILD_CACHE_ID=$BCID OS_PATCH_WEEK=$OS_PATCH_WEEK $DC build worker 2>&1 | tail -8'"

# Config preflight: the NEW worker image checks powder.env with the same
# rules the new containers refuse to start on (apps/web/src/check-config.ts), BEFORE
# anything is recreated: a weak BETTER_AUTH_SECRET / POWDER_ENCRYPTION_KEY aborts here
# with the old containers still serving, instead of a crash loop after the recreate.
# A config finding (__POWDER_CONFIG_BAD__) refuses, and so does a probe that cannot run:
# the weak-secret gate must never be skipped silently. The worker image has no package
# manager: node loads tsx itself (WORKDIR /app/apps/web).
echo "── config preflight (new image, $ENVF) ──"
CFG_OUT=$(ssh "$HOST" "cd $SRC && $DC run --rm --no-deps -T --entrypoint node worker --import tsx src/check-config.ts 2>&1" 2>&1 || true)
if printf '%s' "$CFG_OUT" | grep -q '__POWDER_CONFIG_BAD__'; then
  printf '%s\n' "$CFG_OUT" | grep -v '^$' >&2
  echo "✗ refusing to recreate: fix $ENVF first (the running powder and worker are untouched)." >&2
  exit 1
elif printf '%s' "$CFG_OUT" | grep -q '\[config-check\]'; then
  echo "  ok"
else
  echo "✗ refusing to recreate: could not run the config check in the new image: $(printf '%s' "$CFG_OUT" | tail -2 | tr '\n' ' ')" >&2
  echo "  (the running powder and worker are untouched)" >&2
  exit 1
fi

# Env render targets: which apps render their env outside their own dir and
# whether the new image keeps that target (a pin or recorded evidence). Informational on a
# normal run; --pin-report stops here.
echo "── env render targets (new image) ──"
PIN_RC=0
PIN_OUT=$(ssh "$HOST" "cd $SRC && $DC run --rm --no-deps -T --entrypoint node worker --import tsx src/env-pin-report.ts 2>&1" 2>&1) || PIN_RC=$?
printf '%s\n' "$PIN_OUT" | grep -v '^$' || true
if [ "$PIN_REPORT" = "1" ]; then
  if [ "$PIN_RC" != "0" ]; then
    echo "✗ --pin-report: the report failed (exit $PIN_RC, output above). The running powder and worker are untouched." >&2
    exit 1
  fi
  echo "── --pin-report done: images built, the running powder and worker are untouched ──"
  exit 0
fi
[ "$PIN_RC" = "0" ] || echo "⚠ the env render target report failed (exit $PIN_RC), continuing: it is informational on a normal run." >&2

# Uptime baseline: which apps answer BEFORE the recreate (bin/fleet-check.sh). Best effort.
FLEET_CHECK="$ARCHIVE_DIR/bin/fleet-check.sh"
FLEET_BASE="$ARCHIVE_DIR/fleet-baseline.txt"
if [ -x "$FLEET_CHECK" ]; then
  POWDER_HOST=$HOST POWDER_ENV_FILE=$ENVF POWDER_DB_EXEC="$DB_EXEC" "$FLEET_CHECK" --baseline "$FLEET_BASE" --record >/dev/null 2>&1 || true
fi
# The build took minutes — a webhook deploy may have been claimed meanwhile.
# Re-check and WAIT for quiet (up to 45 min) before the recreate; images are
# already built, so the up is instant once the queue drains. --force skips.
if [ "$FORCE" != "1" ]; then
  for i in $(seq 1 90); do
    INFLIGHT=$(inflight_count)
    [ "$INFLIGHT" = "0" ] && break
    if [ "$INFLIGHT" = "?" ]; then
      db_down_msg
      echo "  Aborting before the recreate (old containers untouched; the new images are built). Start the DB and re-run." >&2
      exit 1
    fi
    if [ "$i" = "90" ]; then
      echo "✗ still $INFLIGHT deploy(s) in flight after 45 min — aborting before recreate (old containers untouched; re-run when quiet)." >&2
      exit 1
    fi
    echo "  $INFLIGHT deploy(s) in flight — waiting before recreate ($i/90, 30s)…"
    sleep 30
  done
fi

# Last section of every run: fleet status. Returns 1 only on a regression.
fleet_section() {
  [ -x "$FLEET_CHECK" ] || return 0
  echo "── fleet check ──"
  local rc=0
  POWDER_HOST=$HOST POWDER_ENV_FILE=$ENVF POWDER_DB_EXEC="$DB_EXEC" "$FLEET_CHECK" --baseline "$FLEET_BASE" || rc=$?
  [ "$rc" = 1 ] && return 1
  return 0
}

if [ "$NEEDS_DB_CUTOVER" = "1" ]; then
  echo "── DB network cutover: recreate postgres as powder-postgres on powder-db ──"
  ssh "$HOST" "cd $SRC && bash -o pipefail -c '$DC up -d --force-recreate --no-deps postgres 2>&1 | tail -4'"
  for i in $(seq 1 30); do
    ssh "$HOST" "docker exec powder-postgres pg_isready -U $DB_USER" >/dev/null 2>&1 && break
    [ "$i" = 30 ] && { echo "✗ powder-postgres did not become ready" >&2; exit 1; }
    sleep 2
  done
  PG_CT=powder-postgres
  DB_EXEC="docker exec $PG_CT psql -U $DB_USER -d $DB_NAME"
  DB_PSQL="docker exec -i $PG_CT psql -v ON_ERROR_STOP=1 -U $DB_USER -d $DB_NAME"
fi

echo "── recreate powder AND worker ──"
# --skip-migrations must also skip the container's own boot-time step
# (docker/powder-entrypoint.sh), else the new container re-applies the file that
# failed and crash-loops. docker-compose.yml passes this through to `powder`;
# always set explicitly (0 or 1) so a skip never outlives the run that asked.
BOOT_SKIP=0; [ "$SKIP_MIGRATIONS" = "1" ] && BOOT_SKIP=1
# pipefail on the REMOTE side: a failed `up` must not be hidden by `| tail`.
ssh "$HOST" "cd $SRC && bash -o pipefail -c 'POWDER_SKIP_BOOT_MIGRATIONS=$BOOT_SKIP $DC up -d --force-recreate powder worker 2>&1 | tail -4'"

if [ "$SKIP_MIGRATIONS" != "1" ]; then
  echo "── post-deploy migrations ──"
  apply_migrations post || { echo "✗ post-deploy migrations failed - the new code is live; fix and re-run bin/self-deploy.sh (applied files are recorded)." >&2; exit 1; }
fi

echo "── health check ──"
sleep 10
for i in 1 2 3 4 5 6; do
  H=$(ssh "$HOST" "curl -s --max-time 8 '$HEALTH_URL'" || true)
  if printf '%s' "$H" | grep -q '"status":"ok"'; then
    echo "healthy: $(printf '%s' "$H" | head -c 120)…"
    if [ -n "${POWDER_PUBLIC_URL:-}" ]; then
      CODE=""
      for try in 1 2 3 4 5 6; do
        CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$POWDER_PUBLIC_URL/" || true)
        echo "$POWDER_PUBLIC_URL: HTTP $CODE (try $try/6)"
        case "$CODE" in 2??|3??) break ;; esac
        [ "$try" = 6 ] || sleep 10
      done
      case "$CODE" in 2??|3??) ;; *) echo "✗ public URL check failed after 60s (HTTP ${CODE:-none}) - the dashboard is not reachable through the proxy." >&2; exit 1 ;; esac
    fi
    fleet_section || exit 1
    ssh -o ConnectTimeout=10 "$HOST" "if [ -x /usr/local/bin/powder-post-deploy ]; then /usr/local/bin/powder-post-deploy $DEPLOYED_SHA; fi" \
      || echo "⚠ post-deploy hook failed (the deploy itself is fine)" >&2
    exit 0
  fi
  sleep 10
done
echo "✗ health check did not go green — check: ssh $HOST docker logs powder" >&2
fleet_section || true
exit 1
