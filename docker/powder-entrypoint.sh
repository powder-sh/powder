#!/bin/bash
# Entrypoint of the `powder` (web) image: apply pending schema migrations, then
# serve. So `docker compose build && docker compose up -d` upgrades the schema
# without bin/self-deploy.sh.
#
# The rules are NOT reimplemented here: this sources the same
# bin/lib-migrations.sh that bin/self-deploy.sh uses (same ledger table
# powder_deploy_migrations, same `-- idempotent` / `-- post-deploy` markers,
# same abort message for an unrecorded non-idempotent file).
#
#   An empty database gets the whole schema on the first boot (every file in
#   order, see bin/lib-migrations.sh "Fresh database") only with
#   POWDER_ALLOW_FRESH_SCHEMA=1 in the env file; without it the boot is refused.
#
#   pre phase   before the server starts. A failure exits non-zero: the
#               container does not serve (restart policy retries, logs say why).
#   post phase  in the background once /api/health answers 200 (up to
#               POWDER_MIGRATE_POST_WAIT seconds, default 600). If the app never
#               gets healthy, the post files run on the next boot instead.
#
# Env (from powder.env):
#   DATABASE_URL                 required, passed to psql
#   POWDER_MIGRATE_ON_BOOT=off   skip both phases (bin/self-deploy.sh still applies them)
#   POWDER_SKIP_BOOT_MIGRATIONS=1  skip both phases for this container; set by
#                                bin/self-deploy.sh --skip-migrations via docker-compose.yml
#   POWDER_MIGRATE_BASELINE=1    pass --baseline to the pre phase (first run of an
#                                install whose schema was applied by hand)
#   POWDER_ALLOW_FRESH_SCHEMA=1  create the schema in an empty database (read by
#                                bin/lib-migrations.sh; set by bin/install.sh on a new server)
#   MIG_DIR / POWDER_MIGRATIONS_LIB  override the paths (tests)
set -uo pipefail

MIG_DIR=${MIG_DIR:-/app/migrations}
LIB=${POWDER_MIGRATIONS_LIB:-/app/bin/lib-migrations.sh}

if [ "${POWDER_SKIP_BOOT_MIGRATIONS:-0}" = "1" ]; then
  echo "[migrate] POWDER_SKIP_BOOT_MIGRATIONS=1 (bin/self-deploy.sh --skip-migrations): schema step skipped for this container"
  exec "$@"
fi

case "${POWDER_MIGRATE_ON_BOOT:-on}" in
  off|false|0|no)
    echo "[migrate] POWDER_MIGRATE_ON_BOOT=${POWDER_MIGRATE_ON_BOOT}: schema step skipped"
    exec "$@"
    ;;
esac

if [ -z "${DATABASE_URL:-}" ]; then
  echo "✗ [migrate] DATABASE_URL is not set; refusing to start" >&2
  exit 1
fi

# shellcheck source=../bin/lib-migrations.sh
. "$LIB"
# ON_ERROR_STOP: psql exits 0 on a failed statement read from stdin without it.
psql_run() { psql -X -v ON_ERROR_STOP=1 -d "$DATABASE_URL" "$@"; }

baseline=""
case "${POWDER_MIGRATE_BASELINE:-}" in 1|true|yes|on) baseline="--baseline" ;; esac

echo "[migrate] pre-deploy phase"
if ! apply_migrations pre $baseline; then
  echo "✗ [migrate] pre-deploy migrations failed - powder is NOT starting. Fix the file above (or set POWDER_MIGRATE_ON_BOOT=off and apply by hand)." >&2
  exit 1
fi

post_after_healthy() {
  local wait=${POWDER_MIGRATE_POST_WAIT:-600} url="http://127.0.0.1:${PORT:-3000}/api/health" i
  for ((i = 0; i < wait; i += 5)); do
    if node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "$url" 2>/dev/null; then
      echo "[migrate] post-deploy phase"
      apply_migrations post || echo "✗ [migrate] post-deploy migrations failed; they retry on the next boot" >&2
      return 0
    fi
    sleep 5
  done
  echo "[migrate] app not healthy after ${wait}s: post-deploy migrations deferred to the next boot" >&2
}

post_after_healthy &
exec "$@"
