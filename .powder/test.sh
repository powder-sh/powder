#!/bin/sh
# Test gate for powder's own repository: the web app's unit tests, the same suite
# bin/self-deploy.sh runs before it deploys powder. Run it from a pre-push hook, or let
# a powder test gate run it, so a commit that would make the next self-deploy refuse
# is caught before it reaches the server.
# Works in a clean committed tree (git archive, no node_modules): installs its own deps.
set -e
corepack enable
pnpm install --frozen-lockfile
cd apps/web
# powder's test gate copies the tree without docker-compose.yml and .env* (see
# "test gate" in the Deploys docs), but these tests read those committed files. Skip
# them only when the files are missing; a full checkout and bin/self-deploy.sh still
# run them. A new test that reads an excluded file fails here with ENOENT on that
# path: add it to this list, or guard the read with it.skipIf(!existsSync(...))
# (src/lib/__tests__/gate-excluded-reads-guard.test.ts checks both).
skip=""
if [ ! -f ../../docker-compose.yml ] || [ ! -f .env.example ] || [ ! -f ../../docker/powder.env.example ]; then
  for t in db-image-pin env-docs-coverage production-startup-guard install-script web-network-docs \
    mount-escape-nobuild-memcap networks compose-db-vars body-caps self-deploy-script; do
    skip="$skip --exclude src/lib/__tests__/$t.test.ts"
  done
  echo "[test.sh] docker-compose.yml/.env.example not in this copy: skipping the tests that read them"
fi
# On Linux every tool the suite needs is installed (postgres, GNU timeout, the docker
# CLI): a test that would skip itself for a missing tool fails instead
# (src/lib/__tests__/need-tool.ts). A Mac may lack them and skips with a reason.
if [ "$(uname -s)" = Linux ]; then
  POWDER_TEST_REQUIRE_FULL_SUITE=1
  export POWDER_TEST_REQUIRE_FULL_SUITE
fi
# shellcheck disable=SC2086
pnpm -s test $skip
echo "[test.sh] gate passed"
