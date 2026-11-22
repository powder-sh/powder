#!/bin/bash
# install.sh: install or re-run powder on THIS server, from a checkout on it.
# Run as root in the checkout (e.g. /opt/apps/powder/src):
#
#   sudo bin/install.sh                       # asks for what it needs
#   sudo bin/install.sh --host deploy.example.com \
#     --github-client-id <id> --github-client-secret-file <file>
#   sudo bin/install.sh --dry-run             # print the plan, change nothing
#   sudo bin/install.sh --set-admin <user id> # persist the first admin, recreate powder + worker
#
# Options:
#   --host <host>                     public hostname of the dashboard
#   --github-client-id <id>           GitHub OAuth app client id
#   --github-client-secret-file <f>   file holding the client secret (delete it afterwards);
#                                     the secret itself is refused on the command line
#   --yes, -y                         install Docker without asking when it is missing
#                                     (Docker's apt repository, key fingerprint checked;
#                                     Debian and Ubuntu). Without a terminal a server without
#                                     Docker needs it, and every value must come from a flag
#                                     or the env
#   --docker-script                   install Docker with Docker's convenience script
#                                     (get.docker.com, sha256 printed; POWDER_GET_DOCKER_SHA256
#                                     pins it) instead of the apt repository. Only this flag
#                                     runs the script; --yes alone never does
#   --no-proxy                        no Traefik and no POWDER_DASHBOARD_HOST; the bootstrap
#                                     then runs only when Docker is missing (nginx mode).
#                                     Stored as POWDER_PROXY=none in the env file, so later
#                                     runs keep it without the flag
#   --proxy                           Traefik for this run even when the env file says
#                                     POWDER_PROXY=none (a notice says so; the file keeps it)
#   --force                           recreate powder and worker even while deploys are in
#                                     flight (they are killed and their rows stay running)
#   --dry-run                         print the plan, change nothing
#   --fresh-database                  an existing env file but no database: create an empty
#                                     one and let powder create the schema in it (writes
#                                     POWDER_ALLOW_FRESH_SCHEMA=1). Without it that case is
#                                     refused (see Schema below)
#   --set-admin <id>                  add the id to POWDER_ADMIN_USER_IDS, recreate powder
#                                     and worker, nothing else
#
# Values come from the flag, else the env (POWDER_DASHBOARD_HOST, GITHUB_CLIENT_ID,
# GITHUB_CLIENT_SECRET), else the env file, else a prompt (secrets are not echoed).
# Other env: POWDER_ENV_FILE (default /opt/apps/powder.env; another path is written
# into the file as POWDER_ENV_FILE, and a path an app could own, /opt/apps/<name>.env
# or /opt/apps/<name>/..., is refused), SSH_KEY_PATH (default
# /root/.ssh/id_ed25519), POWDER_DATA_DIR (parent of powder-pgdata, default /opt/apps;
# written to a new env file; with an env file present, another value than the stored
# one is refused), POWDER_BUILD_CACHE_ID_FILE (default /opt/apps/.powder-build-cache-id).
# docker compose reads its values from the env file only: a variable docker-compose.yml
# reads that is also set in the shell is dropped for compose, with a notice.
#
# Steps: check docker (missing: install it with bin/server-bootstrap.sh after a yes
# at the prompt, or with --yes), docker compose >= 2.24, openssl, git, curl,
# ssh-keygen and awk; create the SSH key; create the env file from
# docker/powder.env.example (mode 0600, new secrets and DB password); create the
# docker network web; unless --no-proxy, run bin/server-bootstrap.sh --apply --proxy
# traefik --yes, which adds only what is missing on this server: the networks web and
# internal, /opt/apps, the Traefik dynamic dir, powder-migrate, powder-image-prune and
# its hourly cron, /etc/logrotate.d/powder-traefik, and Traefik when nothing holds
# 80/443 (an outdated helper is only reported); warn when memory plus swap is under 2 GB (powder's own image is built
# here) and when the dashboard host does not resolve to this server (Let's Encrypt
# cannot issue its certificate then); build and start powder and postgres (the
# powder container creates the schema on an empty database), then the worker once
# powder serves (schema applied, database reachable), then wait for /api/health to
# report ok; print the setup token and the next steps.
#
# Re-running is safe: an existing env file is never replaced and a value that is
# already set is never changed (only empty keys are filled; POWDER_DASHBOARD_HOST
# only from --host / the env, never inferred). Re-running on a newer checkout
# rebuilds and restarts powder: that is the on-server upgrade. It refuses while
# deploys are in flight, and waits (up to 45 minutes) for ones that start during
# the build, as bin/self-deploy.sh does; --force skips that. bin/self-deploy.sh
# upgrades from a workstation instead. Docs: /docs/self-hosting#install-script-options
#
# Schema: on a server with no database yet a newly created env file gets
# POWDER_ALLOW_FRESH_SCHEMA=1, so the powder container may create the schema in the
# empty database; the line is removed once powder serves (the schema exists then).
# Without it, an empty database is refused (bin/lib-migrations.sh). An env file that
# already exists with no database next to it is refused (the data dir was moved or
# POWDER_DATA_DIR or the database settings changed) unless it still carries the line
# from an unfinished earlier run, or --fresh-database is passed.
# The env file must be a regular file, not a symlink. Temp files next to it are
# removed on exit and on interruption.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

DRY=0
PROXY_FLAG=
FORCE=0
FRESH_DB=0
YES=0
DOCKER_SCRIPT=0
SET_ADMIN=
HOST_ARG=
GH_ID_ARG=
GH_SECRET_FILE=
die() { echo "✗ $*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; }
# A flag that takes a value: the value must be there and not be another flag.
need_val() { [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#-}" = "$2" ] || die "$1 needs a value (see --help)"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-proxy) PROXY_FLAG=none ;;
    --proxy) PROXY_FLAG=traefik ;;
    --force) FORCE=1 ;;
    --fresh-database) FRESH_DB=1 ;;
    --yes|-y) YES=1 ;;
    --docker-script) DOCKER_SCRIPT=1 ;;
    --host) need_val "$@"; HOST_ARG=$2; shift ;;
    --host=*) HOST_ARG=${1#--host=} ;;
    --github-client-id) need_val "$@"; GH_ID_ARG=$2; shift ;;
    --github-client-id=*) GH_ID_ARG=${1#--github-client-id=} ;;
    --github-client-secret-file) need_val "$@"; GH_SECRET_FILE=$2; shift ;;
    --github-client-secret-file=*) GH_SECRET_FILE=${1#--github-client-secret-file=} ;;
    --github-client-secret|--github-client-secret=*) die "pass the secret with --github-client-secret-file <file> or GITHUB_CLIENT_SECRET, not on the command line" ;;
    --set-admin) need_val "$@"; SET_ADMIN=$2; shift ;;
    --set-admin=*) SET_ADMIN=${1#--set-admin=} ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# ── validation (every value is checked before it reaches a file or a command) ──
valid_host() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] && [ ${#1} -le 253 ]; }
valid_gh_id() { [[ "$1" =~ ^[A-Za-z0-9._-]{8,64}$ ]]; }
valid_gh_secret() { [[ "$1" =~ ^[A-Za-z0-9_-]{20,128}$ ]]; }
# better-auth ids are 32 letters and digits; _ and - are accepted inside an id, never
# first, so a flag (--dry-run) can never be taken for one.
valid_user_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]]; }
valid_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$1" != *..* ]]; }

DEFAULT_ENVF=/opt/apps/powder.env
ENVF=${POWDER_ENV_FILE:-$DEFAULT_ENVF}
valid_path "$ENVF" || die "POWDER_ENV_FILE must be a plain absolute path (got: $ENVF)"
# The rename below would replace a symlink with a regular file (and leave the
# target stale), so a linked env file is refused rather than written through.
[ -L "$ENVF" ] && die "$ENVF is a symlink: point POWDER_ENV_FILE at the real file (a regular file owned by root, mode 0600), then re-run"
# An app owns /opt/apps/<app>.env and /opt/apps/<app>/ on its server, and powder
# renders that app's env file there. Only powder's own names are safe for its env
# file: the default /opt/apps/powder.env, or a file under /opt/apps/powder/.
# Prints the app name that would own the path, or returns 1 when none could
# (container names, and so app names, start with a letter or digit).
envf_app_collision() {
  local p rest name
  p=$(printf '%s' "$1" | sed -E 's#/+#/#g; s#/(\./)+#/#g; s#/\.$##')
  case "$p" in /opt/apps/*) ;; *) return 1 ;; esac
  rest=${p#/opt/apps/}
  case "$rest" in
    powder.env|powder/*) return 1 ;;
    */*) name=${rest%%/*} ;;
    *.env) name=${rest%.env} ;;
    *) return 1 ;;
  esac
  [[ "$name" =~ ^[A-Za-z0-9] ]] || return 1
  printf '%s' "$name"
}
if COLLIDE=$(envf_app_collision "$ENVF"); then
  die "POWDER_ENV_FILE=$ENVF is a path an app named '$COLLIDE' would own (powder renders /opt/apps/<app>.env and files under /opt/apps/<app>/), so that app's deploy could overwrite powder's secrets. Keep it at $DEFAULT_ENVF, under /opt/apps/powder/, or outside /opt/apps"
fi
EXAMPLE="$ROOT/docker/powder.env.example"
[ -f "$ROOT/docker-compose.yml" ] && [ -f "$EXAMPLE" ] || die "run this from a powder checkout (docker-compose.yml and docker/powder.env.example not found in $ROOT)"

# Temp files that hold secrets (the env file being written): removed on every exit,
# including Ctrl-C and a kill.
TMPS=()
cleanup_tmps() { [ ${#TMPS[@]} -eq 0 ] || rm -f "${TMPS[@]}"; }
trap cleanup_tmps EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Sets TMPF to a new 0600 temp file next to the env file (same filesystem, so the
# mv over the env file is atomic).
new_tmp() {
  TMPF=$(mktemp "$(dirname "$ENVF")/.powder.env.XXXXXX")
  TMPS+=("$TMPF")
  chmod 600 "$TMPF"
}

say() { echo "── $* ──"; }
run() { # print, then run unless --dry-run
  if [ "$DRY" = 1 ]; then printf 'would run:'; printf ' %q' "$@"; echo; else "$@"; fi
}

# Reads KEY from the env file: first match, quotes stripped.
env_get() {
  local v
  [ -f "$ENVF" ] || return 0
  v=$(sed -n "s/^$1=//p" "$ENVF" | head -1)
  v=${v//\"/}; v=${v//\'/}
  printf '%s' "$v"
}

# Removes every KEY= line from the env file (atomic, as env_fill).
env_drop() {
  local key=$1
  [ -f "$ENVF" ] && grep -q "^$key=" "$ENVF" || return 0
  if [ "$DRY" = 1 ]; then echo "would remove $key from $ENVF"; return 0; fi
  new_tmp
  KEY="$key" awk 'index($0, ENVIRON["KEY"] "=") != 1 { print }' "$ENVF" > "$TMPF"
  mv "$TMPF" "$ENVF"
}

# Sets KEY to the value in the env var named by $2 (so a secret never sits in
# argv), only if KEY is missing or empty. Never changes a set value, never adds
# a second KEY line. Atomic: temp file in the same dir, mode 0600, then mv.
env_fill() {
  local key=$1 var=$2 cur tmp
  cur=$(env_get "$key")
  if [ -n "$cur" ]; then return 0; fi
  if [ "$DRY" = 1 ]; then echo "would set $key in $ENVF"; return 0; fi
  new_tmp; tmp=$TMPF
  KEY="$key" awk -v var="$var" '
    BEGIN { val = ENVIRON[var]; done = 0 }
    !done && index($0, ENVIRON["KEY"] "=") == 1 { print ENVIRON["KEY"] "=" val; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["KEY"] "=" val }
  ' "$ENVF" > "$tmp"
  mv "$tmp" "$ENVF"
}

# Compose invocation, same file rules as bin/self-deploy.sh (DB layout,
# POWDER_HARDEN, POWDER_WEB_READONLY). Sets DC (array) and DB_LAYOUT.
compose_setup() {
  local db_net harden web_ro
  db_net=$(env_get POWDER_DB_NETWORK); harden=$(env_get POWDER_HARDEN); web_ro=$(env_get POWDER_WEB_READONLY)
  case "$db_net" in ''|shared|private) ;; *) die "POWDER_DB_NETWORK in $ENVF must be 'private', 'shared' or unset" ;; esac
  case "$harden" in ''|true|false) ;; *) die "POWDER_HARDEN in $ENVF must be true or false" ;; esac
  case "$web_ro" in ''|true|false) ;; *) die "POWDER_WEB_READONLY in $ENVF must be true or false" ;; esac
  DATA_DIR=$(env_get POWDER_DATA_DIR); DATA_DIR=${DATA_DIR:-${POWDER_DATA_DIR:-/opt/apps}}
  valid_path "$DATA_DIR" || die "POWDER_DATA_DIR must be a plain absolute path"
  # The env file is what self-deploy and later runs read: a different value here
  # would mount another (empty) data dir.
  if [ -f "$ENVF" ] && [ -n "${POWDER_DATA_DIR:-}" ]; then
    local stored
    stored=$(env_get POWDER_DATA_DIR)
    [ "$POWDER_DATA_DIR" = "${stored:-/opt/apps}" ] || die "POWDER_DATA_DIR=$POWDER_DATA_DIR differs from $ENVF (${stored:-unset, so /opt/apps}): set it in $ENVF if the data moved, or unset it here"
  fi
  # `private`, `legacy` (the shared-network layout) or `fresh`: the one rule in
  # bin/lib-db-layout.sh, shared with bin/self-deploy.sh.
  # shellcheck source=bin/lib-db-layout.sh
  . bin/lib-db-layout.sh
  DB_LAYOUT=$(PDB_DIR=$DATA_DIR; PDB_ENVF=$ENVF; eval "$POWDER_DB_LAYOUT_SH")
  case "$DB_LAYOUT" in private|legacy|fresh) ;;
    *) die "could not detect the DB layout of powder (got: ${DB_LAYOUT:-nothing}). Nothing was changed. Check that docker runs (docker ps -a --filter name=postgres) and that DATABASE_URL in $ENVF names the DB host." ;; esac
  [ -z "$db_net" ] && { [ "$DB_LAYOUT" = legacy ] && db_net=shared || db_net=private; }
  local files=(docker-compose.yml) f v
  if [ "$db_net" = shared ] || [ "$harden" = false ] || [ "$web_ro" = true ]; then
    [ "$db_net" = shared ] && files+=(docker-compose.shared-db.yml)
    [ "$harden" = false ] && files+=(docker-compose.unharden.yml)
    [ "$web_ro" = true ] && files+=(docker-compose.web-readonly.yml)
  fi
  # compose lets the shell environment win over --env-file, so a value left in
  # the shell (sudo SSH_KEY_PATH=... bin/install.sh) would mount another key than
  # the env file names. Every variable the compose files read is dropped from
  # compose's environment, except POWDER_ENV_FILE (set below),
  # POWDER_BUILD_CACHE_ID and OS_PATCH_WEEK (both exported by this script).
  COMPOSE_VARS=()
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    for v in $(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$f" | cut -c3- | sort -u); do
      case "$v" in POWDER_ENV_FILE|POWDER_BUILD_CACHE_ID|OS_PATCH_WEEK) continue ;; esac
      case " ${COMPOSE_VARS[*]-} " in *" $v "*) continue ;; esac
      COMPOSE_VARS+=("$v")
    done
  done
  DC=(env)
  for v in ${COMPOSE_VARS[@]+"${COMPOSE_VARS[@]}"}; do DC+=(-u "$v"); done
  DC+=("POWDER_ENV_FILE=$ENVF" docker compose --env-file "$ENVF")
  if [ ${#files[@]} -gt 1 ]; then
    for f in "${files[@]}"; do DC+=(-f "$f"); done
  fi
  return 0
}

# Notice for every compose variable set in the shell to another value than the
# env file holds: compose ignores it now (compose_setup). Names only: some are secrets.
compose_env_notice() {
  local v sv
  [ -f "$ENVF" ] || return 0
  for v in ${COMPOSE_VARS[@]+"${COMPOSE_VARS[@]}"}; do
    sv=${!v-}
    [ -n "$sv" ] || continue
    [ "$sv" = "$(env_get "$v")" ] && continue
    echo "note: $v is set in the shell to another value than in $ENVF; docker compose uses the env file (edit it there to change it)" >&2
  done
}

need_root() {
  [ "$(id -u)" = 0 ] && return 0
  [ "$DRY" = 1 ] && { echo "note: not root; the real run needs sudo"; return 0; }
  die "run as root: sudo bin/install.sh $*"
}

# The env file names its own path when it is not the default (the app containers
# read it from there to keep app env files off it). A stored path that differs
# from the one in use would protect the wrong file.
STORED_ENVF=$(env_get POWDER_ENV_FILE)
if [ -n "$STORED_ENVF" ] && [ "$STORED_ENVF" != "$ENVF" ]; then
  die "$ENVF says POWDER_ENV_FILE=$STORED_ENVF: set that line to $ENVF (the path of the file itself), then re-run"
fi

# Proxy choice: --no-proxy is stored as POWDER_PROXY=none, so a later run without
# the flag does not start Traefik (which publishes 80/443 past ufw) on a server that
# fronts powder another way. A flag on the command line wins for that run.
PROXY_STORED=$(env_get POWDER_PROXY)
case "$PROXY_STORED" in ''|none|traefik) ;; *) die "POWDER_PROXY in $ENVF must be 'none', 'traefik' or unset (got: $PROXY_STORED)" ;; esac
if [ -n "$PROXY_FLAG" ]; then
  PROXY_MODE=$PROXY_FLAG
  if [ "$PROXY_FLAG" = traefik ] && [ "$PROXY_STORED" = none ]; then
    echo "note: $ENVF has POWDER_PROXY=none; --proxy sets up Traefik for this run only (remove that line to make it stick)" >&2
  elif [ "$PROXY_FLAG" = none ] && [ "$PROXY_STORED" = traefik ]; then
    echo "note: $ENVF has POWDER_PROXY=traefik; --no-proxy skips Traefik for this run only (set POWDER_PROXY=none there to make it stick)" >&2
  fi
else
  PROXY_MODE=${PROXY_STORED:-traefik}
  [ "$PROXY_STORED" = none ] && echo "note: POWDER_PROXY=none in $ENVF: no Traefik (as --no-proxy); pass --proxy to set it up"
fi
PROXY=1; [ "$PROXY_MODE" = none ] && PROXY=0

# Deploys in flight. Recreating powder and the worker kills a running deploy
# mid-build and leaves its row `running` (same rule as bin/self-deploy.sh). The
# count comes from powder's own database container; no container, no deploys.
PG_USER=$(env_get POWDER_DB_USER); PG_USER=${PG_USER:-admin}
PG_DB=$(env_get POWDER_DB_NAME); PG_DB=${PG_DB:-powder}
# POWDER_HELD_SQL: a copy of heldSql('d') in apps/web/src/lib/deploy-settle.ts
# (deploy-settle-scripts.test.ts keeps them identical).
POWDER_HELD_SQL="(d.status = 'queued' AND d.not_before IS NOT NULL AND d.not_before > now() AND coalesce((SELECT s.deploy_settle_seconds FROM app_repos s WHERE s.server_id = d.server_id AND s.container_name = d.container_name AND s.deploy_settle_seconds >= 0 LIMIT 1), (SELECT floor(btrim(m.value)::numeric) FROM powder_meta m WHERE m.key = 'deploy_settle_seconds' AND btrim(m.value) = substring(btrim(m.value) from '^[0-9]+(?:[.][0-9]+)?')), 0) >= 1)"
inflight_count() {
  local t n
  [[ "$PG_USER" =~ ^[A-Za-z0-9_.-]+$ ]] && [[ "$PG_DB" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "?"; return; }
  if ! t=$(docker exec powder-postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "select to_regclass('public.deploys') is not null" 2>/dev/null); then
    [ "$(docker container inspect -f '{{.State.Running}}' powder-postgres 2>/dev/null || true)" = true ] && echo "?" || echo 0
    return
  fi
  t=$(printf '%s' "$t" | tr -d '[:space:]')
  [ "$t" = f ] && { echo 0; return; }
  [ "$t" = t ] || { echo "?"; return; }
  # a push HELD on its settle window is not in flight (same rule as bin/self-deploy.sh);
  # on a database without the settle columns (migration 0063 not applied yet) every
  # queued row counts.
  local q="select count(*) from deploys where status in ('running','queued')" c
  c=$(docker exec powder-postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "select count(*) from information_schema.columns where table_schema = current_schema() and ((table_name = 'deploys' and column_name = 'not_before') or (table_name = 'app_repos' and column_name = 'deploy_settle_seconds'))" 2>/dev/null) || c=""
  [ "$(printf '%s' "$c" | tr -d '[:space:]')" = 2 ] && q="select count(*) from deploys d where d.status in ('running','queued') and not $POWDER_HELD_SQL"
  n=$(docker exec powder-postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "$q" 2>/dev/null) || { echo "?"; return; }
  n=$(printf '%s' "$n" | tr -d '[:space:]')
  [[ "$n" =~ ^[0-9]+$ ]] && echo "$n" || echo "?"
}
inflight_what() { [ "$1" = "?" ] && echo "the number of deploys in flight could not be read from powder-postgres" || echo "$1 deploy(s) in flight"; }
# Fast refusal before anything is built or changed.
inflight_refuse() {
  [ "$FORCE" = 1 ] || [ "$DRY" = 1 ] || [ "$DB_LAYOUT" = fresh ] && return 0
  local n
  n=$(inflight_count)
  [ "$n" = 0 ] && return 0
  die "$(inflight_what "$n"): recreating powder and the worker now would kill them and leave their rows running. Wait until they finish, or re-run with --force"
}
# Right before a recreate: deploys that started during the build drain first
# (up to 45 minutes, 30s apart); the old containers keep running meanwhile.
inflight_wait() {
  [ "$FORCE" = 1 ] || [ "$DRY" = 1 ] || [ "$DB_LAYOUT" = fresh ] && return 0
  local i n
  for i in $(seq 1 90); do
    n=$(inflight_count)
    [ "$n" = 0 ] && return 0
    [ "$i" = 90 ] && die "still $(inflight_what "$n") after 45 minutes: stopped before the recreate (the old containers keep running). Re-run when no deploy runs, or with --force"
    echo "  $(inflight_what "$n"): waiting before the recreate ($i/90, 30s)"
    sleep 30
  done
}

# ── --set-admin: persist the first admin id, recreate powder + worker ─────────
if [ -n "$SET_ADMIN" ]; then
  valid_user_id "$SET_ADMIN" || die "--set-admin: a user id is letters, digits, _ and - only, starting with a letter or digit (got: $SET_ADMIN)"
  need_root --set-admin "$SET_ADMIN"
  [ -f "$ENVF" ] || die "$ENVF not found: install powder first"
  compose_setup
  compose_env_notice
  inflight_refuse
  cur=$(env_get POWDER_ADMIN_USER_IDS)
  case ",$cur," in
    *",$SET_ADMIN,"*) echo "POWDER_ADMIN_USER_IDS already contains $SET_ADMIN" ;;
    *)
      new=${cur:+$cur,}$SET_ADMIN
      [[ "$new" =~ ^[A-Za-z0-9_,-]+$ ]] || die "POWDER_ADMIN_USER_IDS in $ENVF has an unexpected value; fix it by hand"
      if [ "$DRY" = 1 ]; then echo "would set POWDER_ADMIN_USER_IDS=$new in $ENVF"
      else
        new_tmp; tmp=$TMPF
        NEWV="$new" awk '
          BEGIN { done = 0 }
          index($0, "POWDER_ADMIN_USER_IDS=") == 1 { if (!done) print "POWDER_ADMIN_USER_IDS=" ENVIRON["NEWV"]; done = 1; next }
          { print }
          END { if (!done) print "POWDER_ADMIN_USER_IDS=" ENVIRON["NEWV"] }
        ' "$ENVF" > "$tmp"
        mv "$tmp" "$ENVF"
        echo "POWDER_ADMIN_USER_IDS=$new written to $ENVF"
      fi
      ;;
  esac
  say "recreate powder and worker (they re-read $ENVF)"
  run "${DC[@]}" up -d --force-recreate powder worker
  exit 0
fi

# ── install ─────────────────────────────────────────────────────────────────
need_root

say "prerequisites"
MISSING=0
miss() { echo "  missing: $*" >&2; MISSING=1; }
# Docker missing: bin/server-bootstrap.sh installs it (Docker 29.x from Docker's apt
# repository, the key's fingerprint checked; with --docker-script the get.docker.com
# script instead, its sha256 printed; POWDER_GET_DOCKER_SHA256 pins it).
# With --no-proxy it runs in nginx mode, which never starts Traefik.
BOOT_PROXY=traefik; [ "$PROXY" = 1 ] || BOOT_PROXY=nginx
BOOT_CMD=(bash "$ROOT/bin/server-bootstrap.sh" --apply --proxy "$BOOT_PROXY")
BOOT_ARGS="--apply --proxy $BOOT_PROXY"; BOOT_FROM="Docker 29.x from Docker's apt repository"
if [ "$DOCKER_SCRIPT" = 1 ]; then
  BOOT_CMD+=(--docker-script); BOOT_ARGS="$BOOT_ARGS --docker-script"; BOOT_FROM="Docker 29.4 from the get.docker.com script"
fi
BOOT_CMD+=(--yes)
if ! command -v docker >/dev/null 2>&1; then
  if [ "$DRY" = 1 ]; then
    echo "  docker is not installed: would ask, then run bin/server-bootstrap.sh $BOOT_ARGS --yes ($BOOT_FROM)"
  else
    go=$YES
    if [ "$go" != 1 ] && [ -t 0 ]; then
      read -r -p "Docker is not installed. Install it now with bin/server-bootstrap.sh ($BOOT_FROM)? [y/N] " a
      case "$a" in y|Y|yes) go=1 ;; esac
    fi
    if [ "$go" = 1 ]; then
      say "install docker (bin/server-bootstrap.sh $BOOT_ARGS: $BOOT_FROM)"
      "${BOOT_CMD[@]}" || true
      hash -r
    fi
  fi
  command -v docker >/dev/null 2>&1 || [ "$DRY" = 1 ] || miss "docker. Install it, then re-run:
      sudo bin/server-bootstrap.sh $BOOT_ARGS   ($BOOT_FROM)
      sudo bin/install.sh $( [ "$PROXY" = 1 ] || printf -- '--no-proxy ')...   (or re-run this with --yes to do both)"
fi
if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 || miss "a reachable docker daemon (docker info failed: is the service running?)"
  CV=$(docker compose version --short 2>/dev/null || true); CV=${CV#v}
  if [[ "$CV" =~ ^([0-9]+)\.([0-9]+) ]]; then
    if [ "${BASH_REMATCH[1]}" -lt 2 ] || { [ "${BASH_REMATCH[1]}" = 2 ] && [ "${BASH_REMATCH[2]}" -lt 24 ]; }; then
      miss "docker compose 2.24 or newer (found $CV)"
    else echo "  docker compose $CV"; fi
  else miss "the docker compose plugin (docker compose version failed)"; fi
fi
for c in openssl git curl ssh-keygen awk; do command -v "$c" >/dev/null 2>&1 || miss "$c"; done
# Memory: powder's own image (a Next.js build) is built on this server, so a small
# server needs swap. Warn, never block. The threshold sits a little under 2 GB
# because the kernel keeps part of the memory, so MemTotal reads a little low.
MEMINFO=${POWDER_MEMINFO_FILE:-/proc/meminfo}
if [ -r "$MEMINFO" ]; then
  MEM_KB=$(awk '/^MemTotal:/ { print $2; exit }' "$MEMINFO"); SWAP_KB=$(awk '/^SwapTotal:/ { print $2; exit }' "$MEMINFO")
  case "$MEM_KB" in ''|*[!0-9]*) MEM_KB= ;; esac
  case "$SWAP_KB" in ''|*[!0-9]*) SWAP_KB=0 ;; esac
  if [ -n "$MEM_KB" ] && [ $((MEM_KB + SWAP_KB)) -lt 1800000 ]; then
    cat >&2 <<EOF
⚠ memory: this server has $((MEM_KB / 1024)) MB of memory and $((SWAP_KB / 1024)) MB of swap. powder's image is
  built here (a Next.js build) and can run out of memory with less than 2 GB. Add swap first:
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  continuing.
EOF
  else
    [ -n "$MEM_KB" ] && echo "  memory $((MEM_KB / 1024)) MB, swap $((SWAP_KB / 1024)) MB"
  fi
fi
if [ "$MISSING" = 1 ]; then
  [ "$DRY" = 1 ] && echo "note: the real run stops here until the missing pieces are installed" || die "install the missing pieces above, then re-run"
fi

compose_setup
[ "$DB_LAYOUT" = legacy ] && die "this server runs powder's DB in the shared-network layout (container 'postgres' on the shared 'internal' network); upgrade it with bin/self-deploy.sh, not this script"
if [ "$DB_LAYOUT" != fresh ] && [ ! -f "$ENVF" ]; then
  die "powder's database already exists ($DATA_DIR/powder-pgdata or the powder-postgres container) but $ENVF does not: restore your env file (its DB password matches that data), then re-run"
fi
# An env file but no database: an earlier install's data is somewhere else, so a
# new empty database would hide it. Only a new env file, an unfinished earlier run
# (the opt-in is still in the file) or --fresh-database go on.
if [ "$DB_LAYOUT" = fresh ] && [ -f "$ENVF" ] && [ "$FRESH_DB" = 0 ] && [ "$(env_get POWDER_ALLOW_FRESH_SCHEMA)" != 1 ]; then
  die "$ENVF exists but powder's database does not (no $DATA_DIR/powder-pgdata, no powder-postgres container). Likely the data dir was moved or deleted, or POWDER_DATA_DIR or the database settings in $ENVF changed: put the data back or fix the setting, then re-run. To start over with an empty database on purpose, re-run with --fresh-database"
fi
inflight_refuse

# Dashboard host and GitHub OAuth app. An env file that already has a value wins.
# BETTER_AUTH_URL from the file is split into scheme, host and optional port
# (http://p.example.com:8443 is a valid value there); its host is checked as a
# host name, an IPv4 address or localhost. A host given by the operator is checked
# strictly (a DNS name with a dot).
CUR_URL=$(env_get BETTER_AUTH_URL)
URL_SCHEME=https URL_HOST= URL_PORT=
if [ -n "$CUR_URL" ]; then
  URL_RE='^([A-Za-z]+)://([A-Za-z0-9.-]+)(:([0-9]{1,5}))?(/.*)?$'
  [[ "$CUR_URL" =~ $URL_RE ]] || die "BETTER_AUTH_URL in $ENVF is not an http(s) URL with a host name: '$CUR_URL' (e.g. https://deploy.example.com)"
  URL_SCHEME=$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-Z' 'a-z')
  URL_HOST=$(printf '%s' "${BASH_REMATCH[2]}" | tr 'A-Z' 'a-z')
  URL_PORT=${BASH_REMATCH[4]}
  case "$URL_SCHEME" in http|https) ;; *) die "BETTER_AUTH_URL in $ENVF must start with https:// or http:// (got: '$CUR_URL')" ;; esac
  valid_host "$URL_HOST" || [ "$URL_HOST" = localhost ] || [[ "$URL_HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] \
    || die "BETTER_AUTH_URL in $ENVF has no valid host: '$URL_HOST' (from '$CUR_URL')"
fi
HOST=${HOST_ARG:-${POWDER_DASHBOARD_HOST:-}}
# Given by the operator (flag, env, prompt), not read back from the env file.
HOST_GIVEN=0; [ -n "$HOST" ] && HOST_GIVEN=1
# From BETTER_AUTH_URL: then the URL (scheme, port) is the dashboard's origin.
HOST_FROM_URL=0
if [ -z "$HOST" ]; then
  HOST=$(env_get POWDER_DASHBOARD_HOST)
  [ -z "$HOST" ] && [ -n "$URL_HOST" ] && { HOST=$URL_HOST; HOST_FROM_URL=1; }
fi
ask() { # var prompt silent
  local v=""
  if [ "$DRY" = 1 ]; then echo "would ask: $2"; return 0; fi
  [ -t 0 ] || die "$2 is required: pass it as a flag or env var (see --help)"
  if [ "$3" = 1 ]; then read -r -s -p "$2: " v; echo; else read -r -p "$2: " v; fi
  printf -v "$1" '%s' "$v"
}
[ -n "$HOST" ] || { ask HOST "Dashboard hostname (e.g. deploy.example.com, DNS must point at this server)" 0; HOST_GIVEN=1; }
HOST=$(printf '%s' "$HOST" | tr 'A-Z' 'a-z')
if [ "$HOST_FROM_URL" = 0 ] && { [ -n "$HOST" ] || [ "$DRY" = 0 ]; }; then
  valid_host "$HOST" || die "not a hostname: '$HOST' (letters, digits, dots and dashes, e.g. deploy.example.com)"
fi
SHOWN_HOST=${HOST:-<host>}
ORIGIN="https://$SHOWN_HOST"
[ "$HOST_FROM_URL" = 1 ] && ORIGIN="$URL_SCHEME://$HOST${URL_PORT:+:$URL_PORT}"
CALLBACK="$ORIGIN/api/auth/callback/github"

GH_ID=${GH_ID_ARG:-${GITHUB_CLIENT_ID:-}}
[ -n "$GH_ID" ] || GH_ID=$(env_get GITHUB_CLIENT_ID)
GH_SECRET=${GITHUB_CLIENT_SECRET:-}
if [ -n "$GH_SECRET_FILE" ]; then
  [ -f "$GH_SECRET_FILE" ] || die "--github-client-secret-file: $GH_SECRET_FILE not found"
  GH_SECRET=$(tr -d '[:space:]' < "$GH_SECRET_FILE")
fi
[ -n "$GH_SECRET" ] || GH_SECRET=$(env_get GITHUB_CLIENT_SECRET)
if [ -z "$GH_ID" ] || [ -z "$GH_SECRET" ]; then
  echo "GitHub OAuth app: create one at https://github.com/settings/developers -> New OAuth App"
  echo "  Homepage URL:               $ORIGIN"
  echo "  Authorization callback URL: $CALLBACK"
fi
[ -n "$GH_ID" ] || ask GH_ID "GitHub OAuth client id" 0
[ -n "$GH_SECRET" ] || ask GH_SECRET "GitHub OAuth client secret (not shown)" 1
if [ -n "$GH_ID" ] || [ "$DRY" = 0 ]; then valid_gh_id "$GH_ID" || die "the GitHub client id looks wrong (letters, digits, . _ - only, 8 to 64 characters)"; fi
if [ -n "$GH_SECRET" ] || [ "$DRY" = 0 ]; then valid_gh_secret "$GH_SECRET" || die "the GitHub client secret looks wrong (letters, digits, _ - only, 20 to 128 characters)"; fi
export GH_ID GH_SECRET

# SSH key powder uses to reach your servers.
KEY=$(env_get SSH_KEY_PATH); KEY=${KEY:-${SSH_KEY_PATH:-/root/.ssh/id_ed25519}}
valid_path "$KEY" || die "SSH_KEY_PATH must be a plain absolute path (got: $KEY)"
say "ssh key $KEY"
if [ -f "$KEY" ]; then
  echo "  exists"
  [ -f "$KEY.pub" ] || { if [ "$DRY" = 1 ]; then echo "would write $KEY.pub from the private key"; else ssh-keygen -y -f "$KEY" > "$KEY.pub"; fi; }
else
  # chmod 700 only a dir this run creates, or an .ssh dir: a custom key path in
  # a shared dir (e.g. /opt/apps) must not lock that dir.
  KEYDIR=$(dirname "$KEY")
  if [ ! -d "$KEYDIR" ]; then
    run mkdir -p "$KEYDIR"
    run chmod 700 "$KEYDIR"
  elif [ "$(basename "$KEYDIR")" = .ssh ]; then
    run chmod 700 "$KEYDIR"
  fi
  run ssh-keygen -q -t ed25519 -N '' -C powder -f "$KEY"
fi

# Env file: created once from the example, never replaced.
say "env file $ENVF"
CREATED=0
if [ -f "$ENVF" ]; then
  echo "  exists: only empty keys are filled"
  grep -v '^#' "$ENVF" | grep -q 'CHANGE_ME' && echo "⚠ $ENVF still contains CHANGE_ME: replace it by hand (powder refuses to start with it)" >&2
else
  if [ "$DRY" = 1 ]; then
    echo "would create $ENVF (mode 0600) from docker/powder.env.example with a new DB password"
  else
    mkdir -p "$(dirname "$ENVF")"
    DBPW=$(openssl rand -hex 24)
    [[ "$DBPW" =~ ^[0-9a-f]{48}$ ]] || die "openssl rand failed"
    new_tmp; tmp=$TMPF
    # The two CHANGE_ME placeholders of the example, and the key path chosen above.
    # ...and POWDER_DATA_DIR (compose_setup validated it), so self-deploy and later
    # runs mount the same data dir without the env var.
    DBPW="$DBPW" KEYPATH="$KEY" DATADIR="$DATA_DIR" awk '
      index($0, "POWDER_DB_PASSWORD=CHANGE_ME") == 1 { print "POWDER_DB_PASSWORD=" ENVIRON["DBPW"]; next }
      index($0, "DATABASE_URL=") == 1 && index($0, ":CHANGE_ME@") { sub(/:CHANGE_ME@/, ":" ENVIRON["DBPW"] "@"); print; next }
      index($0, "SSH_KEY_PATH=") == 1 { print "SSH_KEY_PATH=" ENVIRON["KEYPATH"]; next }
      index($0, "POWDER_DATA_DIR=") == 1 || index($0, "# POWDER_DATA_DIR=") == 1 { if (!dd) print "POWDER_DATA_DIR=" ENVIRON["DATADIR"]; dd = 1; next }
      { print }
      END { if (!dd) print "POWDER_DATA_DIR=" ENVIRON["DATADIR"] }
    ' "$EXAMPLE" > "$tmp"
    grep -v '^#' "$tmp" | grep -q 'CHANGE_ME' && { rm -f "$tmp"; die "docker/powder.env.example has a CHANGE_ME this script does not know"; }
    mv "$tmp" "$ENVF"
    CREATED=1
    unset DBPW
    echo "  created (mode 0600)"
  fi
fi
if [ "$DRY" = 0 ] || [ -f "$ENVF" ]; then
  [ -n "$(env_get BETTER_AUTH_SECRET)" ] || { S1=$(openssl rand -hex 32); export S1; }
  [ -n "$(env_get POWDER_ENCRYPTION_KEY)" ] || { S2=$(openssl rand -hex 32); export S2; }
  AUTH_URL="https://$HOST"; DASH_HOST="$HOST"; KEYPATH="$KEY"; export AUTH_URL DASH_HOST KEYPATH
  env_fill BETTER_AUTH_SECRET S1
  env_fill POWDER_ENCRYPTION_KEY S2
  env_fill BETTER_AUTH_URL AUTH_URL
  env_fill GITHUB_CLIENT_ID GH_ID
  env_fill GITHUB_CLIENT_SECRET GH_SECRET
  env_fill SSH_KEY_PATH KEYPATH
  # Never inferred on an existing file: an install that left it unset on purpose
  # (its own proxy) would get Traefik labels on the next re-run.
  if [ "$PROXY" = 1 ] && { [ "$CREATED" = 1 ] || [ "$HOST_GIVEN" = 1 ]; }; then env_fill POWDER_DASHBOARD_HOST DASH_HOST; fi
  # Remembered for later runs (see PROXY_STORED above).
  PROXY_NONE=none; export PROXY_NONE
  [ "$PROXY_FLAG" = none ] && env_fill POWDER_PROXY PROXY_NONE
  # A path other than the default: the containers read it from here (the env file
  # is their env_file), so powder never renders an app's env file over this one.
  ENVF_SELF=$ENVF; export ENVF_SELF
  [ "$ENVF" = "$DEFAULT_ENVF" ] || env_fill POWDER_ENV_FILE ENVF_SELF
  # No database on this server yet: the powder container may create the schema in
  # the empty database. Removed again once powder serves (below).
  FRESH_ONE=1; export FRESH_ONE
  # Only a new env file, or --fresh-database: an existing one with no database is
  # refused above.
  [ "$DB_LAYOUT" = fresh ] && { [ "$CREATED" = 1 ] || [ "$FRESH_DB" = 1 ]; } && env_fill POWDER_ALLOW_FRESH_SCHEMA FRESH_ONE
  unset S1 S2
else
  echo "would set BETTER_AUTH_SECRET, POWDER_ENCRYPTION_KEY (openssl rand -hex 32), BETTER_AUTH_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SSH_KEY_PATH$([ "$PROXY" = 1 ] && echo ', POWDER_DASHBOARD_HOST')$([ "$PROXY_FLAG" = none ] && echo ', POWDER_PROXY=none')$([ "$ENVF" = "$DEFAULT_ENVF" ] || echo ', POWDER_ENV_FILE')$([ "$DB_LAYOUT" = fresh ] && echo ', POWDER_ALLOW_FRESH_SCHEMA=1 (until the schema exists)')"
fi
unset GH_SECRET
[ "$DRY" = 1 ] || { chmod 600 "$ENVF"; [ "$(env_get BETTER_AUTH_URL)" = "$ORIGIN" ] || echo "note: BETTER_AUTH_URL in $ENVF is $(env_get BETTER_AUTH_URL), kept as is"; }
compose_env_notice

say "docker network web"
if docker network inspect web >/dev/null 2>&1; then echo "  exists"; else run docker network create web; fi

if [ "$PROXY" = 1 ]; then
  say "reverse proxy (Traefik, bin/server-bootstrap.sh)"
  if [ "$DRY" = 1 ]; then
    echo "would run: bin/server-bootstrap.sh --apply --proxy traefik --yes (adds only what is missing; never touches an existing proxy)"
  else
    bash "$ROOT/bin/server-bootstrap.sh" --apply --proxy traefik --yes || true
  fi
fi

# DNS: Traefik asks Let's Encrypt for the dashboard's certificate (HTTP-01) as soon
# as powder's router appears, which needs the host to resolve to this server. Warn,
# never block.
DNS_WARN=0
host_addrs() { # the addresses $1 resolves to, one per line; exit 3 without a lookup tool
  if command -v getent >/dev/null 2>&1; then { getent ahosts "$1" 2>/dev/null || true; } | awk '{ print $1 }'
  elif command -v host >/dev/null 2>&1; then { host "$1" 2>/dev/null || true; } | awk '/has (IPv6 )?address/ { print $NF }'
  elif command -v dig >/dev/null 2>&1; then dig +short A "$1" 2>/dev/null || true; dig +short AAAA "$1" 2>/dev/null || true
  else return 3; fi
}
own_addrs() { # this server's addresses, loopback left out
  local a
  a=$(ip -o addr show 2>/dev/null | awk '{ print $4 }' | cut -d/ -f1)
  [ -n "$a" ] || a=$(hostname -I 2>/dev/null | tr ' ' '\n')
  printf '%s\n' "$a" | grep -E '^[0-9A-Fa-f:.]+$' | grep -Ev '^(127\.|::1$)' || true
}
if [ "$PROXY" = 1 ] && [ -n "$HOST" ]; then
  say "DNS for $HOST"
  if [ "$DRY" = 1 ]; then echo "would check that $HOST resolves to an address of this server (getent ahosts, else host or dig)"
  else
    RES=$(host_addrs "$HOST") && RC=0 || RC=$?
    RES=$(printf '%s\n' "$RES" | grep -E '^[0-9A-Fa-f:.]+$' | sort -u || true)
    OWN=$(own_addrs | sort -u)
    MATCH=
    [ -n "$RES" ] && [ -n "$OWN" ] && MATCH=$(printf '%s\n' "$RES" | grep -Fx -f <(printf '%s\n' "$OWN") | head -1 || true)
    if [ "$RC" = 3 ]; then echo "  cannot check (no getent, host or dig): make sure $HOST points at this server"
    elif [ -n "$MATCH" ]; then echo "  $HOST resolves to this server ($MATCH)"
    elif [ -n "$RES" ] && [ -z "$OWN" ]; then echo "  $HOST resolves to $(echo $RES); could not list this server's addresses to compare"
    else
      DNS_WARN=1
      if [ -z "$RES" ]; then WHAT="does not resolve"; else WHAT="resolves to $(echo $RES), not to this server ($(echo $OWN))"; fi
      cat >&2 <<EOF
⚠ DNS: $HOST $WHAT.
  Let's Encrypt cannot issue the dashboard's certificate until it does. Traefik asks for it
  when powder starts and does not retry at once, so browsers get Traefik's default
  certificate until then.
  Fix: point an A (or AAAA) record for $HOST at this server, then, once it resolves:
    docker restart traefik
  (Behind NAT, such as a cloud floating IP, this server may not see its public address:
  check the record by hand.) continuing.
EOF
    fi
  fi
fi

say "build powder and worker"
# Same file and format as bin/self-deploy.sh (secret part of the BuildKit cache ids).
BCID_FILE=${POWDER_BUILD_CACHE_ID_FILE:-/opt/apps/.powder-build-cache-id}
valid_path "$BCID_FILE" || die "POWDER_BUILD_CACHE_ID_FILE must be a plain absolute path"
BCID=
if [ "$DRY" = 1 ]; then echo "would read or create $BCID_FILE"
else
  if [ ! -s "$BCID_FILE" ] && [ -d "$(dirname "$BCID_FILE")" ]; then (umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$BCID_FILE") 2>/dev/null || true; fi
  BCID=$(cat "$BCID_FILE" 2>/dev/null || true)
  case "$BCID" in *[!0-9a-f]*) BCID= ;; esac
fi
export POWDER_BUILD_CACHE_ID="$BCID"
# The ISO week docker/web.Dockerfile keys its OS upgrade layers on (one refresh a
# week). Same snippet as OS_PATCH_WEEK_SH in apps/web/src/lib/build-cache.ts.
OS_PATCH_WEEK_SH='OS_PATCH_WEEK=$(date -u +%G-W%V 2>/dev/null || true); case "$OS_PATCH_WEEK" in [0-9][0-9][0-9][0-9]-W[0-9][0-9]) ;; *) OS_PATCH_WEEK= ;; esac'
eval "$OS_PATCH_WEEK_SH"
export OS_PATCH_WEEK
# The server build lock (BUILD_LOCK in apps/web/src/lib/build-lock.ts). The script also
# waits on the lock at the older path (OLDER_BUILD_LOCK below) when it is a regular
# root-owned file (only root can create or remove it in sticky /tmp), so an upgrade
# started while a build holds that lock cannot run two builds at once.
BUILD_LOCK=/run/powder-build.lock
OLDER_BUILD_LOCK=/tmp/powder-build.lock
LOCK=()
if command -v flock >/dev/null 2>&1; then
  LOCK=(flock -w 2400 "$BUILD_LOCK")
  if [ -f "$OLDER_BUILD_LOCK" ] && [ ! -L "$OLDER_BUILD_LOCK" ] && [ "$(stat -c %u "$OLDER_BUILD_LOCK" 2>/dev/null)" = 0 ]; then
    LOCK+=(flock -w 2400 "$OLDER_BUILD_LOCK")
  fi
fi
run ${LOCK[@]+"${LOCK[@]}"} "${DC[@]}" build powder
run ${LOCK[@]+"${LOCK[@]}"} "${DC[@]}" build worker

say "config check (new image)"
if [ "$DRY" = 1 ]; then echo "would run: src/check-config.ts in the worker image"
else
  CFG_OUT=$("${DC[@]}" run --rm --no-deps -T --entrypoint node worker --import tsx src/check-config.ts 2>&1 || true)
  if printf '%s' "$CFG_OUT" | grep -q '__POWDER_CONFIG_BAD__'; then
    printf '%s\n' "$CFG_OUT" | grep -v '^$' >&2
    die "fix $ENVF, then re-run"
  elif printf '%s' "$CFG_OUT" | grep -q '\[config-check\]'; then echo "  ok"
  else printf '%s\n' "$CFG_OUT" | tail -5 >&2; die "could not run the config check in the new worker image (output above)"; fi
fi

# Start order. powder first: its entrypoint applies the schema before the server
# listens; the worker does not migrate, so it must not start against a missing schema.
# The worker cannot wait for "status":"ok" either: with POWDER_DEPLOY_WORKER=true
# the worker owns the scheduler and claim loop, so /api/health stays 503 until it
# runs. So: (1) wait until powder serves and its health detail reports db:true (read
# inside the container, where the detail is visible; a server that answers has
# finished the schema step), (2) start the worker, (3) wait for "status":"ok".
say "start postgres and powder"
inflight_wait
run "${DC[@]}" up -d postgres powder

PORT_NUM=$(env_get POWDER_PORT); case "$PORT_NUM" in ''|*[!0-9]*) PORT_NUM=3050 ;; esac
HEALTH="http://127.0.0.1:$PORT_NUM/api/health"
# shellcheck disable=SC2016
PROBE='fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/api/health").then(r=>r.text()).then(t=>process.stdout.write(t),()=>process.exit(1))'
# $1 = tries (5s apart); $2 = check command. Returns 0 on success.
poll() {
  local n=$1 i; shift
  for i in $(seq 1 "$n"); do
    "$@" && return 0
    [ $((i % 6)) = 0 ] && echo "  still waiting ($((i * 5))s)"
    sleep 5
  done
  return 1
}
schema_ready() { docker exec powder node -e "$PROBE" 2>/dev/null | grep -q '"db":true'; }
health_ok() { curl -fsS --max-time 5 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"'; }

say "wait for powder to serve (schema applied, database reachable)"
if [ "$DRY" = 1 ]; then echo "would poll /api/health inside the powder container for db:true, up to 5 minutes"
elif poll 60 schema_ready; then echo "  ready"
else
  docker logs --tail 40 powder >&2 || true
  die "stage 1/2: powder did not serve within 5 minutes (schema step or database). The log is above; full log: docker logs powder"
fi
# The schema exists now: drop the opt-in, so a later start against an empty
# database (a wrong DATABASE_URL, a moved data dir) is refused instead of
# creating a new, empty powder. The running container keeps it until its next
# recreate, which is harmless once the ledger has rows.
if [ "$DRY" = 0 ] && [ -n "$(env_get POWDER_ALLOW_FRESH_SCHEMA)" ]; then
  env_drop POWDER_ALLOW_FRESH_SCHEMA
  echo "  POWDER_ALLOW_FRESH_SCHEMA removed from $ENVF (the schema exists)"
fi

say "start worker"
inflight_wait
run "${DC[@]}" up -d worker

say "wait for $HEALTH to report ok"
if [ "$DRY" = 1 ]; then echo "would poll $HEALTH for \"status\":\"ok\", up to 5 minutes"
elif poll 60 health_ok; then echo "  healthy"
else
  docker logs --tail 40 powder-worker >&2 || true
  die "stage 2/2: powder serves but $HEALTH did not report ok within 5 minutes (scheduler or claim loop heartbeat missing). The worker log is above; see docker logs powder-worker and docker logs powder"
fi

TOKEN=
[ "$DRY" = 1 ] || TOKEN=$(docker logs powder 2>&1 | grep -o '\[first-run\] setup token: [A-Za-z0-9_-]*' | tail -1 || true)
TOKEN=${TOKEN##*setup token: }
DONE_LINE="powder is running."
[ "$DRY" = 1 ] && DONE_LINE="dry run: nothing was changed. After the real run:"
DNS_LINE="DNS first: an A/AAAA record for $SHOWN_HOST must point at this server, with ports 80
and 443 open, before Let's Encrypt can issue its certificate. Traefik asked for it when
powder started; if DNS was not ready then, run docker restart traefik once it resolves."
[ "$DNS_WARN" = 1 ] && DNS_LINE="$DNS_LINE
The DNS check above says it does not point here yet."
[ "$PROXY" = 1 ] || DNS_LINE="DNS first: $SHOWN_HOST must point at your own proxy."
cat <<EOF

$DONE_LINE
$DNS_LINE
Next:
  1. GitHub OAuth app (github.com/settings/developers): callback URL
     $CALLBACK
  2. Setup token: ${TOKEN:-docker logs powder 2>&1 | grep 'setup token'}
     Open $ORIGIN/setup, enter it, continue with GitHub. That login is the admin.
  3. Persist the admin: the log prints "[first-run] ... POWDER_ADMIN_USER_IDS=<id>"; run
     sudo bin/install.sh --set-admin <id>
EOF
if [ "$PROXY" = 0 ]; then
  echo "  No proxy was set up (--no-proxy or POWDER_PROXY=none): serve $ORIGIN from your own proxy to 127.0.0.1:$PORT_NUM and set X-Real-IP from the client address."
elif [ "$DRY" = 0 ] && ! docker inspect --type container -f '{{.State.Running}}' traefik 2>/dev/null | grep -q true; then
  echo "  Traefik is not running (see the server-bootstrap output above). Front $ORIGIN yourself to 127.0.0.1:$PORT_NUM, or fix what it reported and run: sudo bin/server-bootstrap.sh --apply --proxy traefik"
fi
