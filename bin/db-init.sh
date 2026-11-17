#!/bin/bash
# db-init.sh: create or update powder's schema in a development database.
# Runs the same rules as the production boot step (bin/lib-migrations.sh):
# an empty database gets every file in packages/db/drizzle/, an existing one
# only the pending files. A development database may start empty, so this sets
# POWDER_ALLOW_FRESH_SCHEMA=1 (the production boot refuses an empty database
# without it).
#
#   docker compose -f docker-compose.dev.yml up -d
#   pnpm db:init
#
# DATABASE_URL defaults to the docker-compose.dev.yml database. Needs psql.
set -euo pipefail

cd "$(dirname "$0")/.."
DATABASE_URL=${DATABASE_URL:-postgres://powder:powder@localhost:5433/powder}
command -v psql >/dev/null 2>&1 || { echo "✗ psql not found: install the Postgres client" >&2; exit 1; }

# shellcheck source=bin/lib-migrations.sh
. bin/lib-migrations.sh
psql_run() { PGOPTIONS='-c client_min_messages=warning' psql -X -v ON_ERROR_STOP=1 -d "$DATABASE_URL" "$@"; }
MIG_DIR="$(pwd)/packages/db/drizzle"
export POWDER_ALLOW_FRESH_SCHEMA=1

apply_migrations pre
apply_migrations post
