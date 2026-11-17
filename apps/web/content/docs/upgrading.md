---
title: Upgrading
order: 1.6
description: Upgrade powder on the server or from a workstation, how the schema is applied, the per-server helpers and how to roll back.
---

Before every upgrade, read the release notes in `CHANGELOG.md` and take a dump of powder's database (some migrations remove tables or delete rows, and a rollback past them needs it):

```bash
docker exec powder-postgres pg_dump -U admin powder | gzip > /root/powder-pre-upgrade-$(date +%F).sql.gz
```

The command uses the defaults: the container `powder-postgres`, user `admin` and database `powder`. Use your `POWDER_DB_USER` / `POWDER_DB_NAME` if set, and the container `postgres` on a server in the shared-network layout.

## On the server

In the checkout on the server (`/opt/apps/powder/src`):

```bash
git fetch --tags && git checkout vX.Y.Z
sudo bin/install.sh
```

`bin/install.sh` keeps the env file as it is, refuses while deploys are in flight, rebuilds `powder` and `worker`, waits for deploys that started during the build, restarts `powder`, waits for `/api/health` and then restarts the worker.

A tag checkout is a detached HEAD, where `git pull` fails with "You are not currently on a branch". Upgrade it with `git fetch --tags` and `git checkout` of the new tag, as above. To follow the `main` branch instead, check it out once (`git checkout main`), then upgrade with `git pull --ff-only` and `sudo bin/install.sh` (the public history is linear, so a pull fast-forwards).

## From a workstation

`bin/self-deploy.sh` upgrades the server over SSH from a checkout of the new tag on your workstation:

```bash
POWDER_HOST=root@<server> bin/self-deploy.sh
```

It ships `git archive HEAD` of a clean tree, rsyncs it over `POWDER_SRC` on the server (default `/opt/apps/powder/src`, `--delete`), refuses while deploys are in flight and runs the unit tests first when `apps/web` has its dependencies installed. The script's header lists its settings.

## The schema

There is no SQL to apply by hand. Two paths bring the schema up to date, with the same rules from one file, `bin/lib-migrations.sh`, and one table, `powder_deploy_migrations`:

- **`bin/self-deploy.sh`** applies pre-deploy files before it copies, builds or recreates anything, and post-deploy files right after the recreate. It then builds `powder` and `worker` and recreates both, because deploys execute in the worker. It refuses to run while deploys are in flight and health-checks before it reports success.
- **The `powder` container** applies them every time it starts, so a rebuild and start in `/opt/apps/powder/src` also upgrades the schema:

  ```bash
  docker compose --env-file /opt/apps/powder.env build && docker compose --env-file /opt/apps/powder.env up -d
  ```

  Pre-deploy files run before the server starts serving. Post-deploy files run in the background once `/api/health` answers 200, or on the next start. The `worker` container does not migrate. Without the script, start `powder` first and wait until its health endpoint answers at all: the server listens only after the pre-deploy files ran, and with `POWDER_DEPLOY_WORKER=true` it answers 503 `degraded` until the worker runs, because the worker owns the scheduler. Then start the worker and wait for `"status":"ok"`. `bin/install.sh` uses the same order.

  ```bash
  docker compose --env-file /opt/apps/powder.env up -d powder
  curl -s http://127.0.0.1:3050/api/health
  docker compose --env-file /opt/apps/powder.env up -d worker
  ```

The rules:

1. Files in `packages/db/drizzle/` run in filename order with `psql -v ON_ERROR_STOP=1`. Applied files are recorded.
2. Only files with the exact line `-- idempotent` are run. Every file carries it except a pinned list of the oldest ones in `bin/lib-migrations.sh`.
3. Files that also carry the exact line `-- post-deploy` (the table-dropping migrations) run only after the new code is up, so the old code still sees its tables while the new image builds.
4. An unrecorded file without the marker stops everything: the script aborts the deploy, and the container exits before serving with the same message (`docker logs powder` names the file). Make it idempotent and add the marker, or apply it by hand and insert its file name into `powder_deploy_migrations`.
5. An empty database (an empty ledger and none of powder's tables) gets every file, in filename order, each recorded in the transaction that applies it, only when `POWDER_ALLOW_FRESH_SCHEMA=1` is set (in the env file for the `powder` container, in the shell for `bin/self-deploy.sh`). `bin/install.sh` sets it on a new server and removes it once the schema exists. Without it an empty database is refused, because a wrong `DATABASE_URL` or `POWDER_DB_NAME`, or a moved data dir, looks exactly like a new one: check those first. A first start that fails half way resumes on the next start, without the setting. A database with powder's tables but an empty ledger was built by hand: see [A schema applied by hand](self-hosting.md#a-schema-applied-by-hand).
6. Each file runs in one transaction, except files whose SQL (comments do not count) uses `CONCURRENTLY` or `ALTER TYPE ... ADD VALUE`.
7. The session's current schema must be `public`: powder's tables and the ledger live there, and the files create unqualified names. A session whose `search_path` puts another schema first (for example a schema named like the database user, which the default `"$user", public` picks) is refused before anything runs. Fix it once with `ALTER ROLE <user> SET search_path = public;` or `ALTER DATABASE <name> SET search_path = public;`, or add `?options=-csearch_path%3Dpublic` to `DATABASE_URL`.

For emergencies only: `bin/self-deploy.sh --skip-migrations` skips the schema step, both its own and the boot-time step of the `powder` container it recreates (it passes `POWDER_SKIP_BOOT_MIGRATIONS=1` through `docker-compose.yml`), so a failing file cannot crash-loop the new container. The next run without the flag turns the boot-time step back on. Without the script, `POWDER_MIGRATE_ON_BOOT=off` in the env file skips the boot-time step.

## Per-server helpers

An upgrade does not touch the helpers already installed on your app servers (`powder-migrate`, `powder-image-prune` and its hourly cron file). After it, run "check server" on every app server: it reports a helper as outdated when the installed copy differs from the new release, and "fix missing pieces" replaces one only when you tick it. On the server itself the same is `bin/server-bootstrap.sh --apply --replace-helpers`. `powder-resource-guard` is optional and never checked for updates: reinstall it by hand with `install -m 755 infra/powder-resource-guard.sh /usr/local/bin/powder-resource-guard` (see [Per-server helpers](self-hosting.md#per-server-helpers)).

## Refusals no mode or exemption covers

These checks refuse in every guard mode: `POWDER_COMPOSE_GUARD=warn` does not turn them into warnings and `POWDER_COMPOSE_GUARD_EXEMPT` does not list them. An app that hits one stops deploying (the old container keeps serving) until its compose, repo or image changes. A release can add checks to this list; its notes in `CHANGELOG.md` name them. What to change:

| Refused | Change |
|---|---|
| compose `include` or `extends`, the words `include` / `extends` anywhere in a compose file, a multi-line YAML node (block scalar, a quoted string or flow collection over several lines), anchors, aliases, merge keys, tags | inline the included services, write every value on one line |
| a compose `name:` other than the app name | drop `name:` or set it to the app name |
| an `env_file` / `label_file` path that is relative, built from a variable, holds characters outside `[A-Za-z0-9._/-]`, goes through a symlink, or lies inside a writable bind | write the absolute path literally; mount the folder `:ro` or move the env file out of it |
| a bind source, build context, Dockerfile, secret / config file or volume device that goes through a symlink, or a mount inside another writable bind | point at the real folder |
| a Dockerfile outside its build context or not a regular file; a `# syntax=` other than `docker/dockerfile`, a JSON Dockerfile, a `BUILDKIT_SYNTAX` build arg | keep the Dockerfile inside the context, use the stock frontend |
| an image label `traefik.*`, a label with a line break, or a `com.docker.compose.*` label other than `project`, `service`, `version` | remove those `LABEL` lines from the Dockerfile |
| a checkout whose `.git` is a symlink or a gitfile, a repo cloned from a `file://` or `git://` URL | a plain clone over https or ssh |
| other Dockerfile refusals ("More refusals of the same pass" and "Base images with `ONBUILD` triggers" in [SECURITY-COMPOSE.md](https://github.com/powder-sh/powder/blob/main/docs/SECURITY-COMPOSE.md)): an `ADD` source that is a URL, a git remote or built from a variable, `ADD --checksum` / `--keep-git-dir`; `RUN --network=` other than `default` / `none`, `RUN --security=`, `RUN --device=`; a `FROM` flag other than `--platform=$BUILDPLATFORM` / `$TARGETPLATFORM`, a `FROM` image ref that does not resolve, a base image with `ONBUILD` triggers or without a registry digest; heredoc forms other than `<<NAME`, `<<-NAME`, `<<"NAME"`, `<<'NAME'`; a Unicode space outside quotes; a `COPY --from=` stage index past the last stage | for `ADD https://...`: download it in a `RUN` step with `curl` and check its checksum, or `COPY` a vendored file from the repo; for the rest, write the line as the deploy log's refusal says, or pick a base image without triggers from a registry |
| powder's compose override that cannot be merged with the app's compose | fix the part of the compose the deploy log names (ports, labels, cap_drop) |
| a hostname containing `include` or `extends` | use another hostname |

Repo-local git config is also rewritten on the server: keys that can run programs (hooks, fsmonitor, filter and diff drivers, URL-scoped credential helpers, `include`) are removed before every git call, with a `[git-harden]` line in the deploy log. A plain clone has none of them. Two high-severity findings are refused only on a compose change in warn mode: a writable bind of `./src` or `./.git` (bind a subfolder, or mount it `:ro`), and a built image or `build.tags` that is exactly another app's name on the server, used by another app's containers, or tagged `:deploy-*`.

## Rolling back

Going back to an earlier tag does not undo migrations. When a release's notes say a migration removes tables or deletes rows, an older build may still query them, so going back below that release needs the database dump taken before the upgrade.

## Knowing when a release is out

The running version is shown at the bottom of the sidebar and as `version` in `/api/health`. Once a day the server asks the public GitHub releases API for the latest release (one request with a User-Agent of `powder/<version>`, nothing else is sent). When a newer version exists, the dashboard shows a quiet "powder vX.Y.Z is available" notice linking to the release and to this page. This daily check is the one outbound call powder makes by default; set `POWDER_UPDATE_CHECK=off` in the env file to turn it off. Release notes are in `CHANGELOG.md`.
