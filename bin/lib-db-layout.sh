#!/bin/bash
# Which DB layout powder's server runs: the one rule, sourced by bin/install.sh
# (run locally) and bin/self-deploy.sh (sent over ssh). The dashboard self-deploy
# runs the same text (DB_LAYOUT_SH in apps/web/src/lib/deploy/self-deploy.ts, kept
# byte-identical by a test).
#
# Set PDB_DIR (POWDER_DATA_DIR, the parent of powder-pgdata) and PDB_ENVF (powder's
# env file), then eval POWDER_DB_LAYOUT_SH. It prints:
#   `private`  the private layout: DB `powder-postgres` on the powder-db network
#   `legacy`   the shared-network layout: DB `postgres` on the shared `internal` network
#   `fresh`    no DB yet
# A DB or powder container that exists decides:
#   - a `powder-postgres` container            -> `private`
#   - a `postgres` container on powder-pgdata  -> `legacy`
#   - a `powder` container attached to `internal` -> `legacy` (wherever its DB keeps its data)
# With none of them (e.g. after `docker compose down`) the env file decides, by the
# host in DATABASE_URL (scheme, userinfo, port, path, query and fragment removed;
# a `[v6]` host without its brackets):
#   - `postgres`, unless POWDER_DB_NETWORK=private (quotes stripped, as bin/self-deploy.sh
#     reads it) -> `legacy`
#   - anything else (`powder-postgres` is the private layout's host):
#     PDB_DIR/powder-pgdata exists -> `private`, else `fresh`
# `docker container inspect`: a plain `docker inspect` also matches an image,
# volume or network of that name. No single quotes inside (callers quote it).
POWDER_DB_LAYOUT_SH='if docker container inspect -f ok powder-postgres >/dev/null 2>&1; then echo private; elif docker container inspect -f "{{range .Mounts}}{{.Source}} {{end}}" postgres 2>/dev/null | grep -q powder-pgdata; then echo legacy; elif docker container inspect -f "{{json .NetworkSettings.Networks}}" powder 2>/dev/null | grep -q "\"internal\""; then echo legacy; else PDB_HOST=$(sed -n "s/^DATABASE_URL=//p" "$PDB_ENVF" 2>/dev/null | head -1 | tr -d "\"\047\r" | sed -e "s|^[A-Za-z][A-Za-z0-9+.-]*://||" -e "s|[/?#].*||" -e "s|.*@||" -e "s|^\([^:[]*\):.*|\1|" -e "s|^\[\([^]]*\)].*|\1|"); PDB_NET=$(sed -n "s/^POWDER_DB_NETWORK=//p" "$PDB_ENVF" 2>/dev/null | head -1 | tr -d "\"\047\r"); if [ "$PDB_HOST" = postgres ] && [ "$PDB_NET" != private ]; then echo legacy; elif [ -d "$PDB_DIR/powder-pgdata" ]; then echo private; else echo fresh; fi; fi'
