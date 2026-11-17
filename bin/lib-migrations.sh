#!/bin/bash
# Schema step for bin/self-deploy.sh, sourced so it can be tested with a stub.
# Caller defines `psql_run [psql args...]` (reads SQL on stdin) and sets
# MIG_DIR. Every deploy script that sources it (bin/self-deploy.sh) sets it to the
# extracted `git archive HEAD` tree (committed SQL only), never the working tree.
#
# A migration file is applied only if it has the exact line `-- idempotent`.
# Other files are never run here. On a schema applied by hand the non-idempotent
# ones cannot be verified (there is no drizzle migrations table). There is NO implicit baseline: an empty ledger records nothing.
# `apply_migrations pre --baseline` records the pinned list below (the
# non-idempotent files, computed from git; every later file carries the marker)
# as applied, and nothing else. Run it once on a schema applied by hand.
#
# Phases: `apply_migrations pre` (before the build/recreate) skips files that
# carry the exact line `-- post-deploy`; `apply_migrations post` (after the
# recreate) applies ONLY those. Pure destructive migrations (table drops) are
# post-deploy: the old code keeps running for minutes during the build and
# must still see its tables.
#
# NOTICE lines ("already exists, skipping") are silenced with client_min_messages=warning
# so the `baselined`/`applied` summary is readable. Each file runs in ONE
# transaction (psql -1) with ON_ERROR_STOP, so a failure leaves nothing half-applied.
#
# Callers: bin/self-deploy.sh (over ssh), and the
# powder image's entrypoint docker/powder-entrypoint.sh (on every boot, local
# psql against DATABASE_URL). This file is the one authority for the rules.
#
# Tracking: public.powder_deploy_migrations(file text primary key, applied_at timestamptz).
# The schema is public: the ledger and the probe name it, and a session whose
# current_schema() is not public is refused (the files create unqualified names,
# which would land in whatever schema the search_path picks).
# Any unrecorded non-idempotent file aborts the deploy: make it idempotent, or
# apply it by hand and insert its name into the table.
#
# Fresh database: when the ledger is empty AND none of the tables the migration
# files create exist, the database is new. Then EVERY file runs in filename
# order (pre and post-deploy, marked or not: nothing older is running against
# an empty schema), each recorded in the same transaction that applies it, and
# --baseline is ignored. A marker row (POWDER_FRESH_MARKER) is written first and
# deleted once the last file is recorded, so a run that fails half way resumes
# on the next run instead of being read as a hand-built schema. The probe must
# answer exactly; any other answer (or a failed query) aborts.
# A non-empty schema with an empty ledger is NOT fresh: that is an install whose
# schema was applied by hand, and it still needs --baseline as before.
#
# The fresh path needs an explicit opt-in: POWDER_ALLOW_FRESH_SCHEMA=1 (bin/install.sh
# writes it into a new env file and removes it once the schema exists; bin/db-init.sh
# sets it). Without it an empty ledger with none of the tables is refused: a wrong
# DATABASE_URL or POWDER_DB_NAME, or a moved data dir, looks exactly like a new
# database, and must not turn into an empty, running powder. Resuming an unfinished
# fresh install (the marker row) needs no opt-in.
#
# Transactions: a file runs in one transaction (psql -1) unless its SQL, comments
# left out, uses CONCURRENTLY or ADD VALUE (migration_txn_exception): those cannot
# run inside a transaction block. Both paths decide with that one function.

# Pinned: the files without the -- idempotent marker, recorded by --baseline on a schema applied by hand.
POWDER_BASELINE_FILES=(
  0000_elite_mentor.sql
  0001_hesitant_orphan.sql
  0002_tearful_hobgoblin.sql
  0003_outgoing_paper_doll.sql
  0004_bitter_elektra.sql
  0005_fine_ares.sql
  0006_reflective_bloodscream.sql
  0007_complex_mysterio.sql
  0008_lucky_blindfold.sql
  0009_square_the_liberteens.sql
  0010_nasty_eternity.sql
  0011_strong_archangel.sql
  0012_mushy_doctor_doom.sql
  0014_wealthy_the_spike.sql
  0015_living_guardian.sql
  0016_faithful_saracen.sql
  0017_certain_morlocks.sql
  0018_common_zombie.sql
  0019_melodic_human_fly.sql
  0020_friendly_bulldozer.sql
  0021_mono_support.sql
  0022_verify_challenge_columns.sql
  0028_uptime_url_columns.sql
  0031_deploy_queue.sql
  0033_backup_retention.sql
)

is_idempotent_file() { grep -qx -- '-- idempotent' "$1"; }
is_post_deploy_file() { grep -qx -- '-- post-deploy' "$1"; }

POWDER_FRESH_MARKER=_fresh_install_in_progress
POWDER_LEDGER=public.powder_deploy_migrations

# BEGIN migration-txn: kept byte-identical in bin/lib-migrations.sh and
# infra/powder-migrate (the server copy cannot source the lib); a test compares them.
# The SQL of a file with -- line comments and /* */ block comments removed (string
# literals are not parsed: a "--" inside a quoted string cuts the rest of that line,
# which can only hide a keyword, never invent one).
IFS= read -r -d '' MIGRATION_SQL_CODE_AWK <<'EOSQLCODE' || true
{
  line = $0; out = ""
  while (length(line) > 0) {
    if (inblk) {
      i = index(line, "*/")
      if (i == 0) { line = ""; break }
      line = substr(line, i + 2); inblk = 0; continue
    }
    a = index(line, "--"); b = index(line, "/*")
    if (a == 0 && b == 0) { out = out line; break }
    if (a > 0 && (b == 0 || a < b)) { out = out substr(line, 1, a - 1); break }
    out = out substr(line, 1, b - 1); line = substr(line, b + 2); inblk = 1
  }
  print out
}
EOSQLCODE
migration_sql_code() { awk "$MIGRATION_SQL_CODE_AWK" "$1"; }

# Prints why the file cannot run inside a transaction block ("CONCURRENTLY":
# CREATE INDEX CONCURRENTLY refuses a transaction; "ADD VALUE": an
# ALTER TYPE ... ADD VALUE, PG12+ cannot use a new enum value in the transaction
# that added it), or nothing. Comments do not count. Here-strings, not pipes: under
# pipefail an early-exiting grep -q can SIGPIPE the writer and hide a match.
migration_txn_exception() {
  local code
  code=$(migration_sql_code "$1" | tr '\n' ' ')
  if grep -qiw 'concurrently' <<<"$code"; then echo CONCURRENTLY
  elif grep -qiE '(^|[^[:alnum:]_])alter[[:space:]]+type[[:space:]][^;]*[[:space:]]add[[:space:]]+value([^[:alnum:]_]|$)' <<<"$code"; then echo "ADD VALUE"
  fi
}
# END migration-txn

# True when the operator allowed creating the schema in an empty database.
migration_fresh_allowed() {
  case "${POWDER_ALLOW_FRESH_SCHEMA:-}" in 1|true|yes|on) return 0 ;; esac
  return 1
}

# Names of the tables the migration files create (identifier characters only,
# so the list is safe to put in SQL), one per line.
migration_table_names() {
  grep -hoiE 'create[[:space:]]+table[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?("?public"?\.)?"?[a-z_][a-z0-9_]*' "$1"/*.sql 2>/dev/null \
    | sed -E 's/.*[[:space:].]"?([A-Za-z_][A-Za-z0-9_]*)$/\1/' | tr 'A-Z' 'a-z' | sort -u
}

# Refuses (returns 1) unless the session's current schema is public, where the
# ledger and every table of the migration files live.
migration_schema_check() {
  local out
  out=$(echo "/* powder:schema-check */ select coalesce(current_schema(), '(none)');" | psql_run -tA) \
    || { echo "✗ could not read the current schema" >&2; return 1; }
  out=$(printf '%s' "$out" | tr -d '[:space:]')
  [ "$out" = "public" ] && return 0
  echo "✗ the database session's current schema is '$out', not public: powder's schema lives in public. Fix the search_path (PGOPTIONS, the role's or database's search_path setting, options= in DATABASE_URL) and run again." >&2
  return 1
}

# Prints "empty" (empty ledger, none of the tables), "fresh" (an unfinished fresh
# install: the marker row) or "normal".
# Returns 1 if the database cannot be read or answers anything unexpected.
migration_db_state() {
  local dir="$1" names="" n out
  for n in $(migration_table_names "$dir"); do names="${names}${names:+,}'$n'"; done
  [ -n "$names" ] || { echo normal; return 0; }
  out=$(echo "/* powder:schema-probe */ select (select count(*) from $POWDER_LEDGER where file <> '$POWDER_FRESH_MARKER') || '|' || (select count(*) from unnest(array[$names]::text[]) t(n) where to_regclass('public.' || quote_ident(t.n)) is not null) || '|' || (select count(*) from $POWDER_LEDGER where file = '$POWDER_FRESH_MARKER');" \
    | psql_run -tA) || { echo "✗ could not read the migration ledger" >&2; return 1; }
  out=$(printf '%s' "$out" | tr -d '[:space:]')
  local re='^([0-9]+)[|]([0-9]+)[|]([0-9]+)$' rows tables marker
  [[ "$out" =~ $re ]] || { echo "✗ unexpected answer from the schema probe: '$out'" >&2; return 1; }
  rows=${BASH_REMATCH[1]} tables=${BASH_REMATCH[2]} marker=${BASH_REMATCH[3]}
  if [ "$marker" != "0" ]; then echo fresh; return 0; fi
  if [ "$rows" = "0" ] && [ "$tables" = "0" ]; then echo empty; return 0; fi
  echo normal
}

# Fresh install: apply every unrecorded file in filename order, recording each
# in the same psql input that applies it. The ledger check runs inside that input,
# after the advisory lock: a second applier on the same empty database waits for
# the lock, then finds the file recorded and skips it (powder:already-recorded).
apply_fresh_install() {
  local dir="$1" f name n=0 skipped=0 err txn check
  echo "  fresh database: creating the schema from every migration file"
  echo "insert into $POWDER_LEDGER(file) values ('$POWDER_FRESH_MARKER') on conflict do nothing;" \
    | psql_run -q >/dev/null || return 1
  for f in "$dir"/*.sql; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    check="DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM $POWDER_LEDGER WHERE file = '$name') THEN RAISE EXCEPTION 'powder:already-recorded'; END IF; END \$\$;"
    # Same exceptions as the normal path: these cannot run inside a transaction block.
    txn=(-1)
    [ -n "$(migration_txn_exception "$f")" ] && txn=()
    err=$({ echo "SELECT pg_advisory_lock(7710420);"; echo "$check"; echo "SET lock_timeout='5s';"; echo "SET client_min_messages=warning;"; cat "$f"; echo ";"; echo "insert into $POWDER_LEDGER(file) values ('$name');"; } \
      | psql_run -q ${txn[@]+"${txn[@]}"} -v ON_ERROR_STOP=1 2>&1 >/dev/null) || {
      if printf '%s' "$err" | grep -q 'powder:already-recorded'; then skipped=$((skipped + 1)); continue; fi
      [ -n "$err" ] && printf '%s\n' "$err" >&2
      if [ ${#txn[@]} -eq 0 ]; then
        echo "✗ migration $name failed (fresh install; it ran outside a transaction, so check what it left before retrying)" >&2
      else
        echo "✗ migration $name failed (fresh install; nothing of it was kept, the next run resumes here)" >&2
      fi
      return 1
    }
    [ -n "$err" ] && printf '%s\n' "$err" >&2
    n=$((n + 1))
  done
  echo "delete from $POWDER_LEDGER where file = '$POWDER_FRESH_MARKER';" | psql_run -q >/dev/null || return 1
  echo "  applied: $n files (fresh install)$([ "$skipped" -gt 0 ] && echo ", $skipped already recorded")"
}

apply_migrations() {
  local phase=pre baseline=0 a
  for a in "$@"; do
    case "$a" in
      pre|post) phase="$a" ;;
      --baseline) baseline=1 ;;
      *) echo "apply_migrations: unknown argument '$a'" >&2; return 1 ;;
    esac
  done
  local dir="${MIG_DIR:?}" f name recorded
  migration_schema_check || return 1
  # Under the appliers' advisory lock: two concurrent CREATE TABLE IF NOT EXISTS
  # can both pass the existence check and one fails on pg_type.
  # client_min_messages=warning: no "already exists, skipping" NOTICE on every run.
  { echo "SELECT pg_advisory_lock(7710420);"; echo "SET client_min_messages=warning;"; echo "create table if not exists $POWDER_LEDGER (file text primary key, applied_at timestamptz not null default now());"; } \
    | psql_run -q >/dev/null || return 1
  local state
  state=$(migration_db_state "$dir") || return 1
  if [ "$state" = "empty" ]; then
    if ! migration_fresh_allowed; then
      echo "✗ the database has none of powder's tables and an empty migration ledger. Check DATABASE_URL first (host, database name, POWDER_DB_NAME) and that powder's data dir is the one you expect: a wrong database looks exactly like this. Only for a new install, set POWDER_ALLOW_FRESH_SCHEMA=1 to create the schema: in the env file for the powder container (bin/install.sh does this on a new server), in the shell for bin/self-deploy.sh." >&2
      return 1
    fi
    state=fresh
  fi
  if [ "$state" = "fresh" ]; then
    [ "$baseline" = "1" ] && echo "  --baseline ignored: the database has no powder schema yet"
    apply_fresh_install "$dir"
    return
  fi
  local applied=() baselined=()
  if [ "$baseline" = "1" ] && [ "$phase" = "pre" ]; then
    local values=""
    for name in "${POWDER_BASELINE_FILES[@]}"; do
      [ -f "$dir/$name" ] || continue
      baselined+=("$name")
      values="${values}${values:+,}('$name')"
    done
    if [ -n "$values" ]; then
      echo "insert into $POWDER_LEDGER(file) values $values on conflict do nothing;" \
        | psql_run -q >/dev/null || return 1
    fi
  fi
  for f in "$dir"/*.sql; do
    name=$(basename "$f")
    if is_post_deploy_file "$f"; then
      [ "$phase" = "post" ] || continue
    else
      [ "$phase" = "pre" ] || continue
    fi
    recorded=$(echo "select 1 from $POWDER_LEDGER where file='$name';" | psql_run -tA) || return 1
    [ "$recorded" = "1" ] && continue
    if is_idempotent_file "$f"; then
      # One transaction per file, except the files migration_txn_exception names.
      local txn=(-1) label="$name" why
      why=$(migration_txn_exception "$f")
      if [ -n "$why" ]; then txn=(); label="$name (non-transactional: $why)"; fi
      # The advisory lock (session-level, taken before lock_timeout applies)
      # serialises appliers: the powder container applies on boot too
      # (docker/powder-entrypoint.sh), so self-deploy and a booting container can
      # overlap. A file applied twice is harmless: only idempotent files get here.
      { echo "SELECT pg_advisory_lock(7710420);"; echo "SET lock_timeout='5s';"; echo "SET client_min_messages=warning;"; cat "$f"; } | psql_run -q ${txn[@]+"${txn[@]}"} -v ON_ERROR_STOP=1 >/dev/null \
        || { echo "✗ migration $name failed" >&2; return 1; }
      applied+=("$label")
    else
      echo "✗ $name is not idempotent and not recorded: add a '-- idempotent' line only if the SQL truly is, or confirm it was applied by hand and record it (apply_migrations pre --baseline records only the pinned list in bin/lib-migrations.sh; otherwise insert its name into public.powder_deploy_migrations)." >&2
      return 1
    fi
    echo "insert into $POWDER_LEDGER(file) values ('$name') on conflict do nothing;" | psql_run -q >/dev/null || return 1
  done
  if [ ${#baselined[@]} -gt 0 ]; then printf '  baselined: %s\n' "${baselined[@]}"; fi
  if [ ${#applied[@]} -eq 0 ]; then echo "  no new migrations ($phase-deploy)"; else printf '  applied: %s\n' "${applied[@]}"; fi
}
