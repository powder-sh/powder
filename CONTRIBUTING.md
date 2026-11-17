# Contributing to powder

## How this repository relates to development

This public repository is a release export: each release is copied here from the
maintainers' source tree with a fresh history. Pull requests are welcome and are
reviewed here. An accepted change lands through the maintainers' source tree and
reaches this repository with the next release, with the PR author credited in the
commit.

## Prerequisites

- Node.js 22 (`.nvmrc`)
- pnpm 10.21.0 (`packageManager` in `package.json`; `corepack enable` picks it up)
- Docker, for the development database
- `psql` (the Postgres client), used by `pnpm db:init`

## Dev loop

```sh
pnpm install
docker compose -f docker-compose.dev.yml up -d   # Postgres on 127.0.0.1:5433
cp apps/web/.env.example apps/web/.env.local     # then fill in the values
pnpm db:init                                     # create the schema
pnpm dev                                         # http://localhost:3000
```

In `apps/web/.env.local`, set `BETTER_AUTH_SECRET` and `POWDER_ENCRYPTION_KEY` to
the output of `openssl rand -hex 32` (each its own value). `pnpm build` works
without them (it uses a throwaway secret for the build only); a production
start refuses to run without real ones.

Signing in locally needs a GitHub OAuth app: email signup is disabled, and the first
user comes from a GitHub login with the setup token. Create one at
github.com/settings/developers with homepage `http://localhost:3000` and callback
URL `http://localhost:3000/api/auth/callback/github`, and put its id and secret in
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. `pnpm dev` prints
`[first-run] setup token: <token>` on an empty database: open
`http://localhost:3000/setup`, enter it, then continue with GitHub.

`pnpm db:init` uses the `docker-compose.dev.yml` database by default. For another
Postgres, pass its URL and put the same value in `apps/web/.env.local`:
`DATABASE_URL=postgres://user:pass@localhost:5432/powder_dev pnpm db:init`. A re-run
applies only the pending files.

## Before you open a PR

All four must pass:

```sh
pnpm typecheck
pnpm lint
pnpm --filter @powder/web test
pnpm build
```

Add or update a test for any behaviour you change. Keep a PR to one change.

There is no CI on purpose: nothing runs on GitHub, so run the four checks locally
before you open a PR. `bin/self-deploy.sh` runs the unit tests too and stops before
it changes anything when they fail.

`pnpm lint` runs `biome lint`. There is no format script: much of the tree predates
the formatter settings in `biome.json`, and formatting it all would bury real
changes. Format only the files you touch, for example
`pnpm exec biome format --write <files>`.

## Tests

Unit tests live in `apps/web/src/lib/__tests__/` and run with vitest. Many run the
shell scripts in `bin/` for real, with stub `docker`, `ssh` or `git` commands on
`PATH`. Name a new test after the feature or the rule it covers
(`install-script.test.ts`, `server-delete-route.test.ts`).

The suite must pass on a Mac too (`bin/self-deploy.sh` runs it there), not only on
the Linux gate:

- A script a test runs gets the host's `bash` (3.2 on macOS) and userland (BSD
  `mktemp`, `stat`, `date`, `sed`; no GNU `timeout` or `flock`). Keep scripts free of
  bash-4-only constructs (`bash4-constructs.test.ts` checks `bin/`, `infra/`,
  `docker/`; a Linux-only script is listed there with its reason).
- A test that needs a tool the Mac may lack (initdb, GNU `timeout`, the docker CLI)
  guards on it with `needTool()` from `__tests__/need-tool.ts`, which logs why it
  skips. `.powder/test.sh` sets `POWDER_TEST_REQUIRE_FULL_SUITE=1` on Linux, where
  such a skip fails the run instead.
- The real postgres tests start their cluster through `__tests__/pg-cluster.ts`
  (C locale, `LC_ALL=C`): the hermetic test env has no `LANG`, and macOS postgres
  refuses to start without a locale.

## Words

- **app**: one row in `app_repos`, shown at `/projects/[id]` in the dashboard; its
  container on the server has the app's name.
- **server**: a machine powder reaches over SSH (a row in `servers`). Write
  "server", never "box", in code, messages and docs.
- **deploy**: one row in `deploys`, from queued to ready or failed.

## Repository notes

- The version lives in the root `package.json` (the build reads it from there); the
  private workspace packages carry the same number. The maintainers' release tooling
  bumps all of them, with the install commands in the README and the docs.
- `brand/` holds the logos and screenshots. `brand/scripts/gen-icons.mts` writes the
  logo files and the app icons from `apps/web/src/components/ui/logo-geometry.ts`:
  `node --experimental-strip-types brand/scripts/gen-icons.mts` from the root.
- The repository layout table is in the [README](README.md#repository-layout).

## Database migrations

Schema changes are plain SQL files in `packages/db/drizzle/`, applied by
`bin/lib-migrations.sh` (on every boot of the powder image and on self-deploy). Each
applied file is recorded by name in the `powder_deploy_migrations` table.

- Add a new file with the next number (`NNNN_short_name.sql`) and update the Drizzle
  schema in `packages/db/src/schema/` to match.
- The file must contain the exact line `-- idempotent`, and every statement must be
  safe to run twice (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `DROP ... IF EXISTS`). On an existing database a new file without the marker is not
  run and aborts the deploy. (An empty database gets every file in order.)
- Destructive changes (dropping a table or column the running version still reads)
  also carry `-- post-deploy`: they run only after the new version is up.
- Each file runs in one transaction. `CREATE INDEX CONCURRENTLY` and
  `ALTER TYPE ... ADD VALUE` files run outside a transaction, so keep them to that
  statement.
- Never edit or rename a migration that has shipped: add a new file instead.

## Security issues

Do not open an issue or PR for a vulnerability. See [SECURITY.md](SECURITY.md).

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

Powder is licensed under AGPL-3.0-or-later. By submitting a contribution you agree
that it is licensed under the same licence (inbound = outbound), and that you have
the right to submit it.
