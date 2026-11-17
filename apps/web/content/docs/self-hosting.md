---
title: Self-hosting
order: 1
description: Install powder on one Linux server with bin/install.sh, the env file reference, the first admin, servers and the per-server helpers.
---

Powder is single-tenant: one install per person or team, for their own servers. There is no signup. **On an empty install, the first GitHub login that carries the one-time setup token becomes the admin.**

Powder is one Next.js app (`powder`, the dashboard and API), a worker container (`worker`, which executes deploys) and a Postgres database. It reaches your servers over SSH with a key you control. The short version of this page is the [Quickstart](quickstart.md).

## Requirements

- Docker with the Compose plugin, `docker compose` 2.24 or newer (the opt-out override files `docker-compose.unharden.yml` and `docker-compose.shared-db.yml` use `!reset` / `!override`). On a server without Docker, `bin/install.sh` offers to install it.
- A Linux server for powder itself, with root and 2 GB of memory or more. App builds run on your app servers, but `bin/install.sh` (and every upgrade) builds powder's own image, a Next.js build, on this server. It warns when memory plus swap is under 2 GB; on a smaller server add swap first:

  ```bash
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```

  `bin/install.sh` also needs `git`, `openssl`, `curl`, `ssh-keygen` and `awk`.
- A public HTTPS hostname for the dashboard, with DNS pointing at the server and ports 80 and 443 open: GitHub OAuth returns to it and push webhooks are delivered to it.
- A GitHub OAuth app, used for dashboard login and the first-run admin.
- Root SSH on every server powder manages (deploys run Docker; the server check fixes nothing for another user), with powder's public key in `authorized_keys`, and port 22 open to it from the powder server. Servers that serve apps need ports 80 and 443 open too.
- Postgres 15 or newer. The reference compose file bundles `pgvector/pgvector:pg16`, digest-pinned, and creates the database for you.

## Install on one server

All steps run on the server that will run powder, as root.

1. Point the dashboard hostname at the server (an A or AAAA record) and create a GitHub OAuth app at github.com/settings/developers: homepage `https://<host>`, authorization callback URL `https://<host>/api/auth/callback/github`.
2. Clone a release tag of the repository to `/opt/apps/powder/src` and `cd` there. The tag below is the release these docs belong to; the releases page lists newer ones.

   ```bash
   git clone --branch v0.10.0 https://github.com/powder-sh/powder /opt/apps/powder/src
   cd /opt/apps/powder/src
   ```

3. Run the installer, or run it without flags and answer the prompts (the client secret prompt does not echo; with `--github-client-secret-file`, delete the file afterwards; `--dry-run` prints the plan and changes nothing):

   ```bash
   bin/install.sh --host <host> --github-client-id <id> --github-client-secret-file <file>
   ```

   It checks the prerequisites, creates the SSH key `/root/.ssh/id_ed25519` (`SSH_KEY_PATH` overrides; `docker-compose.yml` mounts it and `<path>.pub` into both containers), creates `/opt/apps/powder.env` (mode 0600) with a new `BETTER_AUTH_SECRET`, `POWDER_ENCRYPTION_KEY` and database password, and creates the `web` network.
4. Unless you pass `--no-proxy` (remembered as `POWDER_PROXY=none` in the env file), it runs `sudo bin/server-bootstrap.sh --apply --proxy traefik --yes` on this server. That adds only what is missing: the `web` and `internal` networks, `/opt/apps`, the Traefik dynamic dir, the helpers `powder-migrate` and `powder-image-prune` with the prune's hourly cron ([Per-server helpers](#per-server-helpers)), Traefik log rotation (`/etc/logrotate.d/powder-traefik`), and Traefik with the `le` ACME resolver the dashboard's labels use, only when the server has no proxy and nothing on ports 80 and 443 (it never touches an existing one, and never replaces an outdated helper). `bin/install.sh` then sets `POWDER_DASHBOARD_HOST`. With your own proxy, forward `https://<host>` to `127.0.0.1:3050` and set `X-Real-IP` (see [Login protection](#login-protection)).
5. It builds and starts powder and its database. On the first start the `powder` container creates the whole schema in the empty database (see [Upgrading](upgrading.md#the-schema)): on a server with no database yet the script writes `POWDER_ALLOW_FRESH_SCHEMA=1` into the env file for that, and removes it once powder serves; the worker starts once the schema is ready, and the install waits for `/api/health` to report ok. The database runs as `powder-postgres` on its own private network (`powder-db`), reachable only by powder and the worker.
6. It prints the one-time setup token from the powder log (the line `[first-run] setup token: <token>`). Open `/setup` on the dashboard host, the one in `BETTER_AUTH_URL`, and enter it. Then click "continue with github" in the same browser: that first login becomes the admin. Persist it with `sudo bin/install.sh --set-admin <id>` (see [First login](#first-login)).

Re-running `bin/install.sh` is safe: it never replaces the env file or a value that is set, and only fills empty keys. It is also the on-server upgrade path ([Upgrading](upgrading.md)): it refuses to start while deploys are in flight, and before it recreates powder and the worker it waits up to 45 minutes for deploys that started meanwhile (`--force` skips both). docker compose takes its values from the env file only: a variable `docker-compose.yml` reads (such as `SSH_KEY_PATH`) that is also set in the shell is ignored, with a notice. The env file must be a regular file, not a symlink. `bin/self-deploy.sh` upgrades the server from a workstation instead.

### Install script options

`sudo bin/install.sh --help` prints the same list.

- `--host <host>`, `--github-client-id <id>`, `--github-client-secret-file <file>`: the dashboard host and the GitHub OAuth app. Each falls back to the environment (`POWDER_DASHBOARD_HOST`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), then to the value already in the env file, then to a prompt. The secret is refused on the command line: use the file (delete it afterwards) or `GITHUB_CLIENT_SECRET`.
- `--yes`, `-y`: install Docker without asking when it is missing (Docker 29.x from Docker's apt repository, its key's fingerprint checked; Debian and Ubuntu). A run without a terminal needs it on a server without Docker, and every value above from a flag or the environment.
- `--docker-script`: install Docker with Docker's get.docker.com convenience script instead (its sha256 printed; `POWDER_GET_DOCKER_SHA256` pins it). Only this flag runs the script; `--yes` alone never does.
- `--no-proxy`: no Traefik and no `POWDER_DASHBOARD_HOST`. The bootstrap step then runs only when Docker is missing, in nginx mode, which never starts Traefik. Front `https://<host>` yourself. The choice is stored as `POWDER_PROXY=none` in the env file, so a later run without the flag keeps it.
- `--proxy`: set up Traefik for this run even when the env file has `POWDER_PROXY=none` (a notice says so; the file keeps the line).
- `--force`: recreate powder and the worker even while deploys are in flight. Those deploys are killed and their rows stay `running`.
- `--dry-run`: print the plan, change nothing.
- `--fresh-database`: the env file exists but powder's database does not (no `powder-pgdata` in the data dir, no `powder-postgres` container). Without the flag the script refuses that case: usually the data dir was moved or deleted, or `POWDER_DATA_DIR` or the database settings in the env file changed, and a new empty database would hide the old data. Put the data back or fix the setting first; pass the flag only to start over with an empty database on purpose. It writes `POWDER_ALLOW_FRESH_SCHEMA=1` for that run. A new env file, or one that still carries that line from an unfinished earlier run, needs no flag.
- `--set-admin <id>`: add the id to `POWDER_ADMIN_USER_IDS` and recreate powder and worker; nothing else runs.
- Environment: `POWDER_ENV_FILE` (default `/opt/apps/powder.env`; another path is written into the file as `POWDER_ENV_FILE`, and a path an app could own, `/opt/apps/<name>.env` or a file under `/opt/apps/<name>/`, is refused), `SSH_KEY_PATH` (default `/root/.ssh/id_ed25519`), `POWDER_DATA_DIR` (default `/opt/apps`; written to a new env file) and `POWDER_BUILD_CACHE_ID_FILE` (default `/opt/apps/.powder-build-cache-id`). When the env file exists and `POWDER_DATA_DIR` is set to a value other than the one stored there (`/opt/apps` when unset), the script refuses: another value would mount another, empty data dir.

## The env file

All config lives in one file, `/opt/apps/powder.env`. `bin/install.sh` creates it from `docker/powder.env.example` and fills the required keys. By hand, copy it and fill it in:

```bash
cp docker/powder.env.example /opt/apps/powder.env && chmod 600 /opt/apps/powder.env
```

 The services read it through `env_file:`, and the deploy scripts also pass `--env-file /opt/apps/powder.env` to every `docker compose` call, so compose-time values such as `POWDER_DB_*` come from the same file. Do not keep config in a `.env` inside the source directory.

In production (`NODE_ENV=production`) powder refuses to start when `BETTER_AUTH_SECRET` is missing, a placeholder (anything containing `change-me`), shorter than 32 characters or low-entropy, when `POWDER_ENCRYPTION_KEY` is missing, not 64 hex characters or low-entropy (`0000...`, `abab...`), or when `POWDER_DB_PASSWORD` or `DATABASE_URL` still contains `CHANGE_ME`. The container exits with the reason in its log. `bin/install.sh` and `bin/self-deploy.sh` run the same check in the new image before they start or recreate anything, so a bad value stops there.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Powder's own Postgres. Must use the same user and database as `POWDER_DB_USER` and `POWDER_DB_NAME` below. |
| `POWDER_DB_USER`, `POWDER_DB_PASSWORD`, `POWDER_DB_NAME` | yes | Credentials for the bundled Postgres service, read by `docker-compose.yml` when it creates the database. The user and database must match `DATABASE_URL` and the `POWDER_DB_PSQL` setting of `bin/self-deploy.sh`. |
| `POWDER_ENCRYPTION_KEY` | yes | 64-character hex key, used for AES-256-GCM on deploy keys, webhook secrets, env vars and GitHub personal access tokens. Generate with `openssl rand -hex 32`. Losing it makes every encrypted row unreadable. |
| `BETTER_AUTH_SECRET` | yes | Session signing and encryption of users' GitHub OAuth tokens (with the database it decrypts them; on a leak also revoke the OAuth grant). Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_URL` | yes | Public origin of the dashboard (e.g. `https://deploy.example.com`). Webhook URLs, alert and deploy-log links and the MCP origin are built from it, so powder refuses to start without a valid http(s) value. `bin/install.sh` writes it. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth login. |
| `POWDER_ADMIN_USER_IDS` | after first login | Comma-separated user ids with admin rights. Leave it empty on a fresh install; `sudo bin/install.sh --set-admin <id>` adds an id. Once any id is set, no new user can be created through login. |
| `POWDER_DEPLOY_SETTLE_SECONDS` | no | Install-wide settle window for push deploys, in seconds (at most 1800; `0` = off), for every app without its own value. Applied when powder starts: change it in the env file, then recreate the containers (`docker compose --env-file /opt/apps/powder.env up -d`). Unset keeps the current default (off unless set). See [Bundling quick pushes](deploys.md#bundling-quick-pushes). |
| `POWDER_DEPLOY_WORKER` | no | `true`, `1`, `yes` or `on` run deploys in the worker (recommended). Unset runs them inside the web process. |
| `POWDER_ENV_VARS_DB_MODE` | no | `true` renders app env vars from powder's database to the server at deploy time. |
| `POWDER_SWAP_CHECK` | no | `off` disables the pre-swap candidate check for every app. Unset means on. |
| `POWDER_SWAP_CHECK_AUTH` | no | `off` turns off the better-auth sign-in probe of the swap-check for every app (per app: `POWDER_AUTH_CHECK` in the app's env, see [Deploys](deploys.md#better-auth-sign-in-probe)). Unset means on. |
| `POWDER_AUTO_ROLLBACK_NEVER` | no | Comma-separated container names the [rollback preflight](deploys.md#rollback-preflight-for-monitors) never allows to roll back automatically, on top of powder's own (case-insensitive). Per app: the automatic rollback toggle on its Settings tab. Unset: only powder itself. |
| `POWDER_TESTGATE_MEM` | no | Memory cap for the test gate container, e.g. `2g`. Unset: uncapped. |
| `POWDER_TRUSTED_IP_HEADER` | no | Which request header carries the real client IP for the login rate limiter and the webhook and MCP limiters. `x-real-ip` (default): set by powder's Traefik from the TCP peer; behind nginx or Caddy set it there (see [Login protection](#login-protection)). `cf-connecting-ip`: behind Cloudflare (Cloudflare's header, then `x-real-ip`, then the right-most `x-forwarded-for` hop), only when the origin accepts traffic from Cloudflare alone (firewall the server to Cloudflare's ranges in the `DOCKER-USER` iptables chain or a cloud firewall: ufw does not filter ports Docker publishes); otherwise anyone can send their own `cf-connecting-ip` and get a fresh rate-limit bucket per request. `x-forwarded-for`: the right-most hop the nearest proxy added. |
| `SSH_KEY_PATH` | no | Path of the private key. `docker-compose.yml` mounts it, and `<path>.pub`, at the same path in both containers. Defaults to `/root/.ssh/id_ed25519`. |
| `POWDER_PORT` | no | Host port the dashboard listens on, bound to `127.0.0.1`. Defaults to 3050. `bin/self-deploy.sh` health-checks this port. |
| `POWDER_DATA_DIR` | no | Parent directory of the Postgres data (`<dir>/powder-pgdata`). Defaults to `/opt/apps`. |
| `POWDER_ENV_FILE` | no | Path of this env file. Defaults to `/opt/apps/powder.env`. `docker-compose.yml`, `bin/install.sh` and `bin/self-deploy.sh` read it from the shell environment; if the file lives elsewhere, set it in the file too (`bin/install.sh` does), so powder never renders an app's env file over it. Keep it out of `/opt/apps/<name>.env` and `/opt/apps/<name>/`, which an app named `<name>` owns. |
| `POWDER_DASHBOARD_HOST`, `POWDER_DASHBOARD_HOST_ALIAS`, `POWDER_DASHBOARD_HOST_ALIAS2` | no | Public hostname of the dashboard, plus up to two more hosts on the same router. When set, `docker-compose.yml` gives the `powder` container a Traefik router (websecure, `le` cert resolver). Unset: no Traefik labels, front powder some other way. |
| `POWDER_SITE_HOST` | no | Comma-separated public-site hosts. When set, those hosts serve only the site, docs, webhooks, `/api/health` and `/ingest`; the dashboard lives at `BETTER_AUTH_URL`. See "Public site on its own host". Unset: one host serves everything. |
| `POWDER_SSH_HOSTKEY_MODE` | no | `off` turns SSH host-key pinning off entirely (not recommended; logged at startup). |
| `POWDER_PG_TOOL_IMAGE` | no | Postgres client image used for backups (`pg_dump`) and the database size probe, which receive DB passwords. Defaults to a digest-pinned `postgres:17-alpine@sha256:...`. Override with another pinned reference (`name:tag@sha256:<64 hex>`); an invalid value is ignored. |
| `POWDER_BUILD_SLOTS` | no | Concurrent builds on a dedicated builder host. Defaults to 2. |
| `POWDER_BUILDER_CACHE_CAP_GB` | no | Cap in GB on the build cache of a dedicated builder host; powder prunes cache there by age after every build until it is under the cap. Defaults to 30. |
| `POWDER_COMPOSE_GUARD` | no | `warn` makes the compose guard log its findings instead of refusing them, for a rollout where some apps may not pass yet; the checks in [Refusals no mode or exemption covers](upgrading.md#refusals-no-mode-or-exemption-covers) still refuse. Unset (the default) enforces. |
| `POWDER_COMPOSE_GUARD_EXEMPT` | no | JSON map of apps to the compose guard codes they are exempt from, e.g. `{"db-server/billing-api":["network_mode"]}`. |
| `POWDER_SHARED_NETWORKS` | no | Comma-separated extra Docker networks apps may join besides `web`, `internal` and `infra`. |
| `POWDER_BUILD_PULL` | no | `0` builds without `--pull`. Default on. |
| `POWDER_HARDEN` | no | `false` removes `cap_drop: ALL` and `no-new-privileges` from `powder` and `worker` (only while a server is not verified yet). |
| `POWDER_WEB_READONLY` | no | `true` gives `powder` a read-only root filesystem. |
| `POWDER_DB_NETWORK` | no | `shared` keeps powder's DB on the shared `internal` network on purpose (supported, with a warning), `private` asks for the private `powder-db` network. Unset: detected by the deploy script. |
| `POWDER_SMTP_URL`, `POWDER_MAIL_FROM` | no | SMTP server and From header for email notification targets, e.g. `smtp://user:pass@host:587` (STARTTLS when offered) or `smtps://user:pass@host:465`, and `Powder <alerts@example.com>`. URL-encode special characters in the password. Email needs both. |
| `POWDER_SELF_SERVICE`, `POWDER_SELF_SERVER_ID`, `POWDER_SELF_CONTAINER` | no | Set when powder deploys itself through powder: the compose service name of powder, the server id it runs on (required with `POWDER_SELF_SERVICE`, else the self-deploy is refused) and its container name (default `powder`). Only that container, on that server, in its own compose project (and, with `POWDER_SELF_SRC` or `POWDER_SRC` set, under that source dir's parent) self-deploys: the recreate is detached so it survives the SSH session ending. Any other container named by the service takes the normal guarded deploy. |
| `POWDER_SELF_SRC`, `POWDER_SELF_WORKER_SERVICE` | no | For that self-deploy: powder's source dir on its server (falls back to `POWDER_SRC`) and the compose service of the deploy worker rebuilt and recreated with it (default `worker`). |
| `POWDER_RESERVED_APP_NAMES` | no | Comma-separated extra app names that `/new` and the adopt flows refuse, for your own services that keep `/opt/apps/<name>` or `/opt/apps/<name>.env` on a server. Entries are trimmed and lowercased and must match `^[a-z][a-z0-9-]{1,30}$`; at most 64 are read. |
| `POWDER_TOKEN_ENV_ALLOW` | no | Regex (whole key, case-sensitive) of extra app env keys an API token may write or delete, e.g. `FEATURE_[A-Z_]+`. Empty (default): a token may only write credential-shaped keys (ending in `_SECRET`, `_TOKEN`, `_API_KEY` or `_KEY`, or with a `_SECRET_` / `_TOKEN_` segment; never `NEXT_PUBLIC_*` or `*_PUBLIC_KEY`). The loader and destination rules apply to an allowed key too. Admin browser sessions may write any key. |
| `POWDER_TOKEN_BACKUP_PRUNE` | no | `1` lets an API token delete backups (prune with `dryRun:false`), e.g. for an ops hub that prunes on a schedule. Unset: only an admin browser session may. |
| `POWDER_COMPOSE_STATE_DIR` | no | Directory on the managed servers for powder's generated `docker-compose.powder.yml` per app. Defaults to `/var/lib/powder/compose`; leave it unset. |
| `POWDER_NOTIFY_WEBHOOK_URL` | no | Always-on webhook for `deploy_failed`, `app_down`, `app_up` and `cron_failed`. Powder POSTs JSON `{event, app, server, message, url, at}`; Discord and Slack incoming webhooks work. More webhooks and email targets are added at `/settings/notifications`. |
| `POWDER_MIGRATE_ON_BOOT` | no | `off` stops the `powder` container from applying pending migrations when it starts. Unset means on. |
| `POWDER_MIGRATE_POST_WAIT` | no | Seconds the post-deploy migrations of a start wait for `/api/health` before they are left for the next start. Defaults to 600. |
| `POWDER_WORKER_MIGRATION_WAIT` | no | Seconds the worker waits at start for the `powder` container to apply the pre-deploy migrations of its image before it starts anyway, with a warning naming the missing files. Defaults to 600. |
| `POWDER_ALLOW_FRESH_SCHEMA` | no | `1` lets the `powder` container create the whole schema in an empty database (empty ledger, none of powder's tables). Without it such a database is refused: check `DATABASE_URL` and `POWDER_DB_NAME` first, a wrong database looks the same. `bin/install.sh` sets it when it creates the env file on a server with no database (or with `--fresh-database`) and removes it once the schema exists; existing installs never need it. |
| `POWDER_PROXY` | no | `none`: `bin/install.sh` sets up no Traefik and no `POWDER_DASHBOARD_HOST` (written by `--no-proxy`; `--proxy` overrides it for one run). Unset: Traefik. |
| `POWDER_MIGRATE_BASELINE` | no | `1` runs the start-up migration step with `--baseline`. Only for the first start of an install whose schema was created by hand (see [A schema applied by hand](#a-schema-applied-by-hand)); remove it afterwards. Ignored on an empty database. |
| `ANTHROPIC_API_KEY`, `POWDER_LLM_DAILY_MAX` | no | Enables "diagnose with AI" on a failed CI run. At most `POWDER_LLM_DAILY_MAX` model calls per UTC day (default 50, 0 = off). |
| `POWDER_UPDATE_CHECK` | no | `off` disables the daily GitHub release check. |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_POSTHOG_UI_HOST` | no | PostHog analytics, read when the image is built. Off unless both `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` (e.g. `https://eu.i.posthog.com`) are set. `NEXT_PUBLIC_POSTHOG_UI_HOST` (default `https://eu.posthog.com`) is the PostHog app the toolbar links to. |
| `POWDER_TRAEFIK_DYNAMIC_DIR` | no | Traefik file-provider directory on the managed servers (default `/opt/infra/traefik/dynamic`). Custom-domain DNS verification uses `servers.ingress_ip`, else the server's host. |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `POWDER_BACKUP_KEY` | no | S3-compatible backup target and the passphrase that encrypts dumps. Generate the passphrase with `openssl rand -hex 32`; powder logs a warning at boot when it is shorter than 32 characters or low-entropy. See [Backups](backups.md). |
| `BACKUP_KEEP_PER_APP` | no | Retention floor per app for scheduled backups. Defaults to 7. |
| `BACKUP_KEEP_MANUAL_PER_APP` | no | Retention floor per app for manual backups, a separate pool. Defaults to 3. |

`docker/powder.env.example` lists every one of these with generation commands. The `POWDER_HQ_*` keys are only for ops endpoint reporting to an endpoint of your own, see "Ops endpoint reporting" in the appendix below. A test keeps this table, the example file and the code in step: every variable powder reads must be listed in one of them.

### Settings of the scripts

These are read from the shell environment of the script, not from the env file.

| Variable | Script | Purpose |
|---|---|---|
| `POWDER_HOST` | `bin/self-deploy.sh`, `bin/fleet-check.sh` | SSH target of powder's server, e.g. `root@203.0.113.7`. Required. |
| `POWDER_SRC` | `bin/self-deploy.sh` | Source dir on the server. Defaults to `/opt/apps/powder/src`. Letters, digits and `_ . / -` only, else the script refuses. |
| `POWDER_ENV_FILE` | `bin/install.sh`, `bin/self-deploy.sh`, `docker-compose.yml` | The env file on the server. Defaults to `/opt/apps/powder.env`. |
| `POWDER_COMPOSE_PROJECT` | `bin/self-deploy.sh` | Compose project name, passed as `-p`. Unset: compose's default. |
| `POWDER_DB_EXEC`, `POWDER_DB_PSQL` | `bin/self-deploy.sh` | How the script runs `psql` on the server. Default: `docker exec` into `powder-postgres` (or `postgres` on the shared-network layout) with `POWDER_DB_USER` / `POWDER_DB_NAME` from the env file. |
| `POWDER_HEALTH_URL` | `bin/self-deploy.sh` | Health URL checked on the server. Defaults to `http://127.0.0.1:<POWDER_PORT>/api/health`. Must be a plain `http(s)://host[:port]/path` (path of letters, digits and `. _ / ~ -`; no query), else the script refuses. |
| `POWDER_PUBLIC_URL` | `bin/self-deploy.sh` | Optional public URL for a last outside-in check. |
| `POWDER_DASHBOARD_HOST`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SSH_KEY_PATH`, `POWDER_DATA_DIR`, `POWDER_BUILD_CACHE_ID_FILE` | `bin/install.sh` | See [Install script options](#install-script-options). |
| `POWDER_GET_DOCKER_SHA256` | `bin/server-bootstrap.sh` | With `--docker-script`: when set, the Docker step refuses a `get.docker.com` script with another sha256. |
| `POWDER_TRAEFIK_DYNAMIC_DIR` | `bin/server-bootstrap.sh` | Same as in the env file. |

## Public site on its own host (optional)

By default one host serves everything: landing page, docs, login, dashboard and APIs. To put the public site on one host and the dashboard on another, set `POWDER_SITE_HOST` and point `BETTER_AUTH_URL` at the dashboard host. Leave `POWDER_SITE_HOST` unset and nothing changes.

```
POWDER_DASHBOARD_HOST=deploy.example.com
POWDER_DASHBOARD_HOST_ALIAS=example.com
POWDER_DASHBOARD_HOST_ALIAS2=www.example.com
BETTER_AUTH_URL=https://deploy.example.com
POWDER_SITE_HOST=example.com,www.example.com
```

- On a site host powder serves only `/`, `/docs/*`, Next assets (`/_next/*`, icons, `robots.txt`, `sitemap.xml`), root-level files from `public/` (e.g. `llms.txt`), `/api/webhooks/*`, `/api/health` and `/ingest`. Every other path returns a plain 404, no redirect.
- A request counts as site traffic when its `Host` or any `X-Forwarded-Host` entry is a site host, so a forged header cannot reach the dashboard there.
- New GitHub push webhooks use the first site host, so they match hooks installed before the split. Existing hooks keep working.
- Dashboard links (deploy statuses, alerts, env file headers, `DEPLOYMENT.md`) use `BETTER_AUTH_URL`.
- The GitHub OAuth app needs the callback `<BETTER_AUTH_URL>/api/auth/callback/github`.
- Sessions are host-only cookies: after moving the dashboard to a new host everyone signs in again there. API tokens keep working against the new host.
- The public pages show no sign-in link when split.

## First login

1. Start powder with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set and `POWDER_ADMIN_USER_IDS` empty.
2. Find the setup token in the powder log, the line `[first-run] setup token: <token>`. It is printed only there, and a restart makes a new one. In `/opt/apps/powder/src`:

   ```bash
   docker compose --env-file /opt/apps/powder.env logs powder
   ```

   or `docker logs powder`.
3. Open `/setup` on the dashboard host, the one in `BETTER_AUTH_URL` (not a `POWDER_SITE_HOST` or another alias: the cookie is host-only and the GitHub login comes back to `BETTER_AUTH_URL`), and enter the token. This sets a 30-minute httpOnly cookie in your browser.
4. In the same browser, sign in with GitHub. You are the admin. Without the token no login can create the first user, so a stranger who finds the install first cannot take it. The log prints a line like `[first-run] ... POWDER_ADMIN_USER_IDS=<id>`. In `/opt/apps/powder/src`, run:

   ```bash
   sudo bin/install.sh --set-admin <id>
   ```

   It adds the id to the env file and recreates both containers so they read it. By hand: put the id in the env file, then in `/opt/apps/powder/src` run the command below, or re-run `bin/self-deploy.sh`.

   ```bash
   docker compose --env-file /opt/apps/powder.env up -d --force-recreate powder worker
   ```

   A plain `docker compose restart` does not re-read the env file. Until the id is in the env file, powder keeps the first-run admin in its database (`powder_meta`) and logs `[first-run] WARN: POWDER_ADMIN_USER_IDS is empty` on every start, so a restart does not lock you out. The first start with `POWDER_ADMIN_USER_IDS` set deletes that stored id: from then on the env file alone decides who is admin.
5. If the first login errors, restart powder, take the new token from the log and try again.

Installs that already have `POWDER_ADMIN_USER_IDS` set never use the setup token.

Everyone who uses powder is an admin. To add a second one, create the user at `/admin/users` in the dashboard and add their id with `sudo bin/install.sh --set-admin <id>`.

A user created at `/admin/users` counts as email-verified, so a GitHub account with the same verified email signs in as that user. **remove** on the same page deletes a user who is not an admin, with their sessions, sign-in methods and API tokens.

## Add a server

On the servers page, run the authorize command it shows on the server (it adds powder's public key to `~/.ssh/authorized_keys` of the SSH user), then register the server with a display name, its host or IP and the SSH user. Or install the key from the powder server:

```bash
cat /root/.ssh/id_ed25519.pub | ssh root@<server> 'cat >> /root/.ssh/authorized_keys'
```

Open the server's page to set its routing and base domain, then click "check server". It is read-only and reports, in this order:

- Docker engine and the compose plugin (required);
- the docker networks `web` and `internal` (required);
- a container named `traefik` with the file provider on `POWDER_TRAEFIK_DYNAMIC_DIR` (required on servers routed by Traefik, informational on nginx servers);
- `/opt/apps` (required) and the Traefik dynamic dir (required on Traefik servers);
- ufw (report only);
- free disk on `/` and memory (a warning under 10 GB free or 2 GB total);
- `git` and `flock` (required: deploys clone with git and take the per-app lock with flock; the fix does not install them, install `git` and `util-linux` with the distro's package manager);
- the [per-server helpers](#per-server-helpers) `powder-migrate` and `powder-image-prune` (a warning when one is missing or outdated);
- the image prune cron `/etc/cron.d/powder-image-prune` (a warning when it is missing);
- `powder-resource-guard` (information only: installed, or optional and not installed).

"fix missing pieces" lists the exact commands first and only adds what is missing: networks, directories, Docker 29.x from Docker's apt repository when Docker is absent (Debian and Ubuntu; the repository key is trusted only when its fingerprint is `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`), the helpers `powder-migrate` and `powder-image-prune`, the prune's cron file, `/etc/logrotate.d/powder-traefik` on Traefik servers, and a Traefik container only on a Traefik server with no Traefik container, no nginx installed or enabled, and nothing listening on or bound to ports 80 and 443. Replacing an outdated helper is listed apart, unticked, and runs only when you tick it. It never changes an existing container, Traefik, nginx, cron or logrotate file and never runs ufw. Installing Docker changes iptables, and ports Docker publishes bypass ufw. The Traefik access log (`/var/log/traefik/access.log`, dir mode 0750) records every request's client IP and full path, including the token in a deploy webhook URL (`/api/webhooks/deploy/<token>`): treat it as secret. The logrotate file rotates it daily (sooner past 100 MB) and keeps 7 copies. To run the same check on the server itself (add `--apply` to run the plan, and `--replace-helpers` to also replace outdated helpers; `--apply` requires `--proxy`):

```bash
sudo bin/server-bootstrap.sh --proxy <traefik|nginx|nginx-container>
```

The dashboard home shows a setup checklist until everything is green.

Then import an app at `/new`: pick a GitHub repository, the server and a name. Powder generates a read-only deploy key and a webhook for the repository. After that, `git push` deploys. See [What your repo needs](app-requirements.md) and [Deploys](deploys.md).

An app already running on the server under Docker Compose is adopted from its container instead, not through `/new`: open the server, pick the container and use "connect" on its git card (GitHub must be connected first). Powder links the repository to that container, adds the deploy key and webhook, and imports its env file.

## Per-server helpers

Scripts from the repository's `infra/` directory that run on each app server:

- `powder-migrate`: every deploy runs `powder-migrate <app> apply` before the swap, applying the app's new `*.sql` migrations, tracked in `_powder_migrations` in the app's database, each transactional file with `lock_timeout` 10s; a non-transactional file is never recorded while an index it names is INVALID (see [Migrations with your own runner](deploys.md#migrations-with-your-own-runner)). Without it the deploy log says `[migrate] powder-migrate not installed on this host - skipping` and no app migration runs.
- `powder-image-prune`: reclaims disk hourly and keeps the `:deploy-*` rollback images. It runs from `/etc/cron.d/powder-image-prune`. Without both, images and build cache fill the disk. It also removes dangling anonymous volumes created more than 7 days ago, never a named volume: a container removed without `-v` (an app deleted in the dashboard, `docker rm`, `docker compose down`) leaves its anonymous volumes behind, and they are reclaimed after that grace. Put `ANON_VOLUME_MAX_AGE_DAYS=<days>` in front of the command in the cron line to change it. Keep app data in a named volume or a bind mount.
- `powder-resource-guard` (optional): every 5 minutes, caps each running container that has no memory limit at the size in `/opt/apps/.mem-cap`, or 2g when that file is absent (database, cache and proxy images are left alone), and keeps the OOM killer off powder and its database.

"fix missing pieces" (and `bin/server-bootstrap.sh --apply`) installs `powder-migrate` and `powder-image-prune` from the powder image when they are missing, and writes the prune's cron file when it is missing. A cron file that exists is reported and left alone. After a powder upgrade, "check server" reports a helper that differs from the copy in the new release as outdated; the fix dialog lists its replacement apart, unticked, and replaces it only when you tick it (on the server: `--replace-helpers`). A copy you changed on purpose stays until you tick it.

`powder-resource-guard` is never installed, compared or updated by powder; "check server" only shows whether it is there. Install it, or update it after an upgrade, by hand from a checkout of the same release:

```bash
install -m 755 infra/powder-resource-guard.sh /usr/local/bin/powder-resource-guard
printf '%s\n' '*/5 * * * * root /usr/local/bin/powder-resource-guard' '@reboot root sleep 90 && /usr/local/bin/powder-resource-guard' > /etc/cron.d/powder-resource-guard
```

The other two by hand, the same way the fix does it:

```bash
install -m 755 infra/powder-migrate /usr/local/bin/powder-migrate
install -m 755 infra/powder-image-prune.sh /usr/local/bin/powder-image-prune
echo '17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1' > /etc/cron.d/powder-image-prune
```

## The app layout on a server

```
/opt/apps/<app>/
├── docker-compose.yml   # runtime compose, server-local, written by powder
├── .deploy-key          # read-only deploy key (mode 0600)
└── ...                  # the git checkout of the app repo (has the Dockerfile)
```

The compose service carries both `image: <tag>` and `build: { context: ., dockerfile: <path> }`. The `build:` key is what makes deploys build on the server. Every deploy force-syncs the checkout to GitHub (keeping the runtime compose), so the copy on the server is disposable and the repository is the source of truth.

Optional server-wide memory cap: put a size such as `2g` in `/opt/apps/.mem-cap` on an app server (`echo 2g > /opt/apps/.mem-cap`). With that file present and non-empty, every deploy caps each app container at that size (`docker update --memory --memory-swap`), overriding a compose `mem_limit` (the file is the operator's server-wide opt-in), and sets `restart: unless-stopped` on one whose restart policy is none; an explicit restart policy wins. Without the file a deploy leaves memory limits and restart policies as compose set them; the optional `powder-resource-guard`, if you install it, still caps every container that has no limit at 2g. Only a deploy applies the file: a container recreated by a rollback or a domain change runs with its compose settings until the next deploy.

Set `health_url` on the app's Settings tab ("health and uptime"), or with `PATCH /api/projects/<id>` and `{"healthUrl": "/api/health"}` from a signed-in browser session. `health_url` may be a path (`/api/health`) or an absolute `http(s)` URL. A path is used by both the deploy health gate (against the new container) and the uptime checker (joined with the app's live domain, else the server's default host); an absolute URL is only used as-is by uptime, and only its path by the deploy gate.

What a repository needs and what `/new` generates: [What your repo needs](app-requirements.md).

## Upgrading powder

See [Upgrading](upgrading.md). On the server, in `/opt/apps/powder/src`:

```bash
git fetch --tags && git checkout vX.Y.Z && sudo bin/install.sh
```

Or run `bin/self-deploy.sh` from a workstation. The schema is applied for you. To remove powder: [Uninstall](uninstall.md).

## Login protection

Two limits apply to email sign-in:

- Per IP: better-auth's rate limiter. The IP comes from the header named by `POWDER_TRUSTED_IP_HEADER`. The default, `x-real-ip`, is the one powder's Traefik sets from the TCP peer. Behind Cloudflare set `POWDER_TRUSTED_IP_HEADER=cf-connecting-ip` (otherwise every visitor shares the bucket of a Cloudflare edge IP), and lock the origin to Cloudflare's IP ranges in the firewall: if the server is reachable directly, a client can set `cf-connecting-ip` itself and every attempt lands in a new bucket. A host firewall such as ufw does not filter ports Docker publishes (Docker's own iptables rules run first): put the Cloudflare allow-list in the `DOCKER-USER` iptables chain, or use your cloud provider's firewall.
- Per account: 10 failed email sign-ins for one address within 15 minutes lock email sign-in for that address for 15 minutes, even with the right password. A successful sign-in resets the count. The counter is in memory and resets when powder restarts. Someone who knows the address can keep its email sign-in locked; GitHub sign-in is not affected.

Behind a proxy other than powder's Traefik, that proxy must set `X-Real-IP` from the TCP peer (and overwrite any value the client sent). nginx:

```nginx
proxy_set_header X-Real-IP $remote_addr;
```

Caddy (inside `reverse_proxy`):

```caddyfile
header_up X-Real-IP {remote_host}
```

Without it powder sees whatever the client sent in that header (nginx and Caddy pass a client-supplied `X-Real-IP` through unless you overwrite it, so a client could pick its own rate-limit bucket); set it as above so the proxy overwrites it. With no header at all powder logs a `[client-ip] WARN` line once, and the limiters fall back so that no client can lock out everyone: webhooks are limited per token, MCP per credential, and sign-in per email only.

## Operational notes

- Builds are serialized per server with a lock and are memory-gated. Do not build by hand outside the lock.
- Deploy logs can contain environment banners. Keep the dashboard behind HTTPS.
- Powder pins each server's SSH host key on first connect (per host and port, in `ssh_host_keys`). If powder cannot read or write that table it refuses the connection instead of connecting unverified. After you rebuild a server, delete its row (use `'<ip>:<port>'` for a non-22 port):

  ```sql
  DELETE FROM ssh_host_keys WHERE host = '<ip>';
  ```

  `POWDER_SSH_HOSTKEY_MODE=off` turns checking off entirely; it is an explicit opt-out and powder logs a warning at startup.
- A watchdog reaps deploys stuck in `running` or `queued`, so a dead SSH session cannot hold an app's deploy lock forever.

## Operator appendix

A new install with the defaults needs none of this.

### A schema applied by hand

A database that has powder's tables but an empty `powder_deploy_migrations` ledger had its schema applied by hand, and powder does not guess what was applied: the first file without the `-- idempotent` marker stops the start (rule 4 in [The schema](upgrading.md#the-schema)). Record the files that lack the marker (a fixed list pinned in `bin/lib-migrations.sh`) as applied, once: with `bin/self-deploy.sh --baseline` from a workstation, or with `POWDER_MIGRATE_BASELINE=1` in the env file for one start of the `powder` container (remove it afterwards). Both record only that list and print it under `baselined:`; the marked files run again, which is safe because they are idempotent. A new install never needs this: an empty database gets the whole schema on its first start (with `POWDER_ALLOW_FRESH_SCHEMA=1`, which `bin/install.sh` sets).

### Ops endpoint reporting

The `POWDER_HQ_INGEST_TOKEN`, `POWDER_HQ_INGEST_URL`, `POWDER_HQ_GENERIC_URL`, `POWDER_HQ_CRON_URL` and `POWDER_HQ_PROJECT` keys turn on ops endpoint reporting, for operators who run an ops endpoint of their own that collects events from many systems. Powder then POSTs deploy results, degraded-deploy warnings and cron results to it with the bearer token. Nothing is sent unless the token and at least one URL are set. A normal install leaves them unset and gets alerts through `POWDER_NOTIFY_WEBHOOK_URL`. `POWDER_HQ_PROJECT` names the project in those events (default `powder`).

`POWDER_STABILITY_CARDS=on` also posts the [deploy-setup warning cards](deploys.md#deploy-setup-warnings); unset or `off`, powder only logs each one as `[stability] would warn: <key> <reason>`.
