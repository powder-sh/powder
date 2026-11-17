---
title: How a deploy runs
order: 3
description: The steps of a powder deploy in order, from preflight to health check and rollback, the swap-check and how to switch it off, and how to stop, start or delete an app.
---

A deploy starts when you push to the configured branch (GitHub calls powder's webhook), or when you redeploy from the dashboard. Powder runs one script on the target server over SSH and streams its output into the deploy log. Each stage prints a banner like `── preflight ──`, and when a deploy fails, the dashboard records the name of the last stage that started.

## Steps in order

1. **app lock.** A per-app lock on the server is held for the whole script, so two deploys of one app cannot overlap.
2. **preflight.** Checks the server, then syncs `src/` to the branch on GitHub with the app's read-only deploy key (`git sync`). Further preflight checks cover the build context and refuse test files placed under `pages/` or `app/` routes.
3. **Build.** Either `docker compose build` on the app server (local build), or, when the server has a dedicated builder host ("build host" on the server's page, or `PATCH /api/servers/<id>` with `{"buildHost": "<host>"}` as an admin), the image is built there and streamed over (`prebuilt image (builder)`). Builds are serialized per server and memory-gated. By default both build paths pass `--pull`: every `FROM`, `COPY --from=<image>` and image build context is then resolved from its registry, never from images that only exist on the server, so a Dockerfile cannot read another app's local build (and a base image you built locally on the server is not usable; stages inside the same Dockerfile, `FROM base AS deps`, are fine). Anonymous Docker Hub pull limits can block a burst of builds: log the build servers in to Docker Hub, or set `POWDER_BUILD_PULL=0` in powder's env to turn `--pull` off (a Dockerfile can then read images present on the server; one that reads another app's local build is refused in enforce mode and logged as `dockerfile_image` in warn mode). Every BuildKit cache mount (`RUN --mount=type=cache`) is rewritten to a cache id of its own app before the build, so apps never share a cache; the first build after an upgrade starts cold.
4. **test gate.** Optional. If the app ships `.powder/test.sh` in its build context, it runs in a throwaway Node container against a read-only copy of the code: in a git checkout only the committed files of the build context (so `.powder/test.sh` must be committed), never `.deploy-key`, `docker-compose.yml`, `docker-compose.powder.yml`, `*.env`, `.env*`, `pgdata`, `kvdata` or `.powder-*` at any depth (outside git: a copy of the context without those names). A non-zero exit stops the deploy and the old container keeps serving. A first-line comment `# powder-test-image: <image>` overrides the default `node:22-alpine`. Allowed: an official `node:<tag>` image, or any image pinned by digest (`name@sha256:<64 hex>`). The image is pulled once and run by its registry digest; if the pull fails, a local copy with a registry digest of the same repository is used (with a `[compose-guard] WARN` line), and a local tag with no such digest is refused (it could be another app's build under the official name; retry when the registry answers). It runs on a network of its own, created for that run and removed after it (`powder-testgate-<random>`, internet access for installs, no app networks and no other test gate), without the `NET_RAW` capability (if that network cannot be created, the deploy is refused and the old container keeps serving; there is no shared test network), with Traefik routing and compose-project labels neutralised. Any other image is refused (a local-only tag of another app would expose its filesystem). `traefik.*` / `com.docker.compose.*` image labels on the test image are refused by default (the compose guard enforces) and only a WARN line with `POWDER_COMPOSE_GUARD=warn`. Memory: uncapped unless `POWDER_TESTGATE_MEM` (powder env, e.g. `2g`) is set; the log names the cap used. A failure that ran out of memory is named in the deploy summary: `heap-oom` when Node hit its V8 heap limit (`JavaScript heap out of memory`, `Reached heap limit`; not a code bug: set `NODE_OPTIONS=--max-old-space-size=<MB>` on that line of `.powder/test.sh`, sized from `tsc --extendedDiagnostics` or the step's peak), `container-oom` when the run was killed with exit 137 (add memory or swap on the server, or free memory there; if `POWDER_TESTGATE_MEM` is set, raise it; the heap flag does not help).
5. **swap gate.** A newer deploy of the same app always wins. If an older deploy finishes building after a newer one has started swapping, the swap gate refuses it, so an old commit cannot replace a newer healthy one.
6. **db migrate.** Runs `powder-migrate <app> apply` if it is installed on the server. A failing migration aborts the deploy before anything is swapped. Each transactional file runs with `lock_timeout` 10s, and a non-transactional file is never recorded while an index it names is INVALID (see [Migrations with your own runner](#migrations-with-your-own-runner) for the lock timeout, invalid indexes and the release-label path).
7. **release.** Optional. If the image has the label `powder.release.cmd`, that command runs once in a one-off container from the new image before the swap (for example, the app's own migrator: `knex migrate:latest`, `prisma migrate deploy`). If it fails, the deploy stops and the old container keeps serving. Preview deploys skip it, like `db migrate`: a preview never runs the release command.
8. **swap-check.** Starts the new image as `<app>-next` and probes it before the live container is touched. See below.
9. **docker compose up.** Recreates the app's containers from the new image. Before it, every image of the compose (workers, crons, sidecars, databases), not only the app's, must carry no `traefik.*` label and no label with a line break: an image `up` would build or pull is built or pulled first, checked, and then used as is. If the compose file has database or cache services next to the app, only the app service is recreated.
10. **health check.** Probes the running app. The log shows the target, the number of attempts and which status codes count as healthy.
11. **tag.** A successful deploy tags the image as `<app>:deploy-<id>`. These tags are what rollback uses.

## swap-check

Before `docker compose up`, powder starts the new image as a second container called `<app>-next` and probes it by its container address, using the app's health URL path and the right Host header. It gets 60 seconds, one try every 5 seconds. The candidate is not routed by the proxy and publishes no ports.

The candidate inherits the service's resolved config: `env_file` and `environment:`, `command:`, `user:`, `working_dir`, volumes and networks. Volumes are mounted like the real container, so the candidate shares the live app's volumes for the probe window, usually under a minute.

The log lines start with `swap-check:`.

- `healthy in Ns (HTTP 200)`: the recreate runs and `<app>-next` is removed.
- `FAILED`: with a health URL, any non-2xx answer or no answer fails; without one, a real 5xx fails; in both cases an exited candidate fails. The last 200 log lines of the candidate go into the deploy log, the candidate is removed, and the deploy fails at step `swap-check`. The old container was never touched, so nothing needs rolling back.
- `skipped (candidate never answered HTTP)`: no health URL was set, the candidate never answered over HTTP and is still running. Typical for workers and non-HTTP services. The deploy continues.
- Also skipped, with the deploy continuing: host-network apps, no running container, no `curl` on the server, or `docker compose run` failing.

Powder checks every 5 minutes for a candidate container older than 30 minutes on each server. If `POWDER_HQ_INGEST_TOKEN` and `POWDER_HQ_GENERIC_URL` are set, it posts a `swap-check leftover` warning to that endpoint; otherwise nothing is sent. Remove a leftover with `docker rm -f <app>-next`.

### better-auth sign-in probe

After the candidate is healthy, if the app's cloned source mentions `better-auth` (in `package.json` or a lockfile, in the app dir or its `src/`), powder also requests `/api/auth/get-session` with no cookie. A 5xx fails the swap (`swap-check: FAILED (auth check: /api/auth/get-session returned 500 (better-auth schema mismatch? run the migration))`, plus the first response line when it mentions SCHEMA_MISMATCH); 2xx, 3xx, 4xx and no answer pass. It tries twice, 3 seconds apart. Per app, set `POWDER_AUTH_CHECK` in the app's env: `off` opts out, a path starting with `/` probes that path and forces the probe without detection. For every app: `POWDER_SWAP_CHECK_AUTH=off` in `powder.env`.

### The kill switch

If an app must never have two processes on its volumes at once, turn the check off for that app by setting its `swap_check` column to false:

```sql
UPDATE app_repos SET swap_check = false WHERE container_name = '<app>';
```

To turn it off for every app on an install, set `POWDER_SWAP_CHECK=off` in `powder.env` and recreate powder and the worker: in the powder source dir run `docker compose --env-file /opt/apps/powder.env up -d --force-recreate powder worker` (or re-run `bin/self-deploy.sh`). A plain restart does not re-read the env file. Unset means on. When it is off, the log says `swap-check: skipped (...)` with the reason.

## Rollback

Two things protect a deploy after the swap.

- **Automatic.** After the recreate, powder polls the app. If it does not answer within the timeout and an earlier successful deploy has a tagged image, powder rolls back to it: it restores the env file that image last ran with, retags the image, recreates the container and runs the same health check again. If there is no earlier tagged image, the log says so and leaves the state for you to fix by hand.
- **Manual.** Use Rollback in the dashboard on any earlier successful deploy. It does the same retag and recreate, which means a few seconds of downtime. The env file that image last ran with is restored only for a rollback from an admin session in the browser; a rollback through an API token restores the image only and keeps the current env file. A target image that is no longer on the server is pulled only from a registry repo the app pushed its rollback tags to.

A database migration is not undone by a rollback. Write migrations so that the previous version of the app still works with the new schema, and remove columns only after the code that read them is gone.

### Rollback preflight for monitors

A monitor or ops tool of your own that watches error rates may want to roll an app back without a person. Powder does not decide that a deploy made things worse; it answers whether that deploy may be undone automatically, and to which image:

```
GET /api/internal/auto-rollback?deploy=<deployId>
```

It needs an admin (session or API token), is read-only and changes nothing. The answer holds `eligible`, the `blockers` that said no, and the `target` deploy. When it is eligible, the caller rolls back through the same route as the Roll back button, `POST /api/servers/<serverId>/containers/<name>/rollback` with `{"targetDeployId": "<target id>"}`, so the usual retag, recreate and health check apply.

The preflight says no when:

- the deploy finished more than 25 minutes ago, is not the app's latest deploy (a newer one, or one in flight, wins) or is not a successful git deploy;
- there is no earlier image of other code to go back to, or that image is gone from the server;
- the app is powder itself, is named in `POWDER_AUTO_ROLLBACK_NEVER` (see [Self-hosting](self-hosting.md#the-env-file)), has automatic rollback turned off, or another server has an app with the same container name;
- the diff changed the database schema, unless every change is an added `.sql` migration made only of additive statements (new tables, indexes, nullable or defaulted columns) or a migration file that carries the line `-- powder:reversible`. With that marker the author promises the previous code runs on the new schema;
- the diff adds a line of destructive DDL (`DROP TABLE`, `RENAME COLUMN`, `ALTER COLUMN`, `TRUNCATE` and the like) outside `.sql` files, for example code that changes the schema at boot, marker or not. In `.sql` migrations the `-- powder:reversible` marker is trusted: the author vouches for it;
- the diff cannot be read: an unknown answer is a no.

To keep one app out, turn off "allow automatic rollback" on its Settings tab (or send `PATCH /api/projects/<id>` with `{"autoRollback": false}` from an admin browser session). The rollback after a failed health check during a deploy and the Roll back button are not affected.

## The push webhook

GitHub calls the app's webhook URL (`/api/webhooks/deploy/<token>`, on the Settings tab) on every push; powder verifies the signature with the app's webhook secret before anything else (see "Webhooks" in the [security model](security-model.md)). A GitHub hook that keeps posting to a token powder no longer has (an app deleted or connected again outside powder's own flows, which leaves the old hook behind) gets the same 401 as a bad signature, and powder then removes that hook from the repository on its own, once all of these hold: the repository is one this powder manages, the token is unknown when the delivery arrives and again right before the removal, and the hook GitHub returns for the delivery's hook id posts to this powder's own URL for exactly that token. The log says `[webhook] removed stale GitHub hook <id> on <owner>/<repo>`.

## Bundling quick pushes

Each push to the branch is a production deploy. A push that arrives while another deploy of the app is waiting folds into that waiting deploy, which then builds the newest commit of the branch. A settle window makes powder wait a little before it starts a push deploy, so a run of pushes ships as one deploy.

It is off unless you set it. Set it per app on the app's Settings tab, under "settle window": a number of seconds up to 1800, `0` to never wait, or empty for the install default (or send `PATCH /api/projects/<id>` with `{"deploySettleSeconds": 600}`, `0` or `null` from an admin browser session). The install default is off. Set it with `POWDER_DEPLOY_SETTLE_SECONDS=<seconds>` in `/opt/apps/powder.env`, then recreate the containers (`docker compose --env-file /opt/apps/powder.env up -d`, or a self-deploy); powder stores it when it starts, as the `deploy_settle_seconds` entry in its settings table (`powder_meta`). `POWDER_DEPLOY_SETTLE_SECONDS=0` turns it off again; removing the line keeps the stored value. An app's own value wins over the install default and needs no restart: the value is read when a push arrives.

- The wait counts from the first push: later pushes fold into the waiting deploy and never move it later. It is never longer than 1800 seconds, whatever the setting says.
- While it waits, the deploy stays `queued` and says `waiting until HH:MM UTC to bundle further pushes`.
- A push where any commit message of the push contains `[urgent]` (any case), or a signed body with `powder_force`, deploys at once and also releases a waiting deploy of the app. **redeploy now** in the dashboard does the same. Manual redeploys, rollbacks, restarts, starts, stops and previews never wait.
- Setting the window to 0 (for every app, or for one app) releases deploys that are already waiting. Lowering it to another number does not: a deploy already waiting keeps the time it was given, so use 0, **redeploy now** or an `[urgent]` push to release it.
- A rollback or a stop while a push waits goes ahead at once and cancels the waiting push (marked failed, step `superseded`, its GitHub deployment set to failure), so the push cannot redeploy the rolled-back code or start the stopped app. Push again or redeploy to ship it. A restart or start lets it deploy as planned, and a delete fails it with the app.

## Zero-downtime bridge

`docker compose up` stops the old container before the new one answers, so an app is briefly unreachable on every deploy. The bridge closes that gap: before `db migrate`, powder starts a copy of the running container from its current image (`<container>-powder-bridge`), waits until it answers, recreates the app, waits until the new container answers, then drains and removes the bridge. A deploy never fails because of the bridge: when it cannot run, the log says `[bridge] skipped: <reason>` and the deploy goes on as usual.

It is opt-in. Put the label on the running container, as a Dockerfile `LABEL` or in the compose service's `labels:`:

```yaml
labels:
  powder.bridge.enabled: "true"
```

The label is read from the container that runs now, so it takes effect from the deploy after the one that adds it.

- **Traefik apps.** The container needs a Docker healthcheck and explicit Traefik router and service labels. The bridge carries the same labels and its own healthcheck, so Traefik routes to it only while it is ready. A Traefik app whose published ports are all bound to `127.0.0.1` or `::1` is bridged too (the bridge publishes no ports); a port published on any other interface skips the bridge (verdict `host-ports`).
- **nginx-fronted apps.** An app that publishes a port on the server also needs `powder.bridge.host-port=<N>`. The app must publish exactly one tcp port, bound to `127.0.0.1` only, and `N` must be that host port plus 10000 (app on `127.0.0.1:3001`, bridge on `127.0.0.1:13001`). The bridge is published on `127.0.0.1:<N>` with its Traefik labels dropped; no healthcheck or Traefik labels are needed. Add it to the vhost as a backup upstream, so nginx retries a refused connection on the bridge while the app container is recreated:

```nginx
upstream <app>_app {
    server 127.0.0.1:<port> max_fails=0;
    server 127.0.0.1:<N> backup;
}
# in each proxied location:
proxy_pass http://<app>_app;
proxy_next_upstream error timeout;
```

While the bridge serves, the new migration has already run, so the old code must work with the new schema (the same rule as for rollback). The bridge re-runs the old image's start command, so it is skipped when that command pushes a schema at boot (`push --force`, `db push`, `accept-data-loss`) unless the container also carries `powder.bridge.boot-push-ok=true`. It is also skipped, among others, for host networking, a command or entrypoint that differs from the image's, mounts that cannot be expressed as bind mounts, `tmpfs`, `cap_add`, `sysctls`, `init` or `shm_size`, `extra_hosts` on a Traefik app (an nginx-fronted app may use `name:ip` and `name:host-gateway` entries), no `curl` on the server, or a bridge that does not answer within 60 seconds.

When the server has an `nginx` binary, every deploy (bridge or not) also runs `nginx -T` on the server, a read-only dump of the loaded configuration that changes nothing, with a 20-second limit when `timeout` is installed. The deploy log says what it found (`[nginx] upstreams ok`, or `[nginx] WARNING: ...` naming each upstream whose only primary server lacks `max_fails=0` next to a `backup` server: one slow response marks that primary down, and nginx answers 502/503 until the backup is up). For an app in host-port mode it also says whether an upstream lists `server 127.0.0.1:<N> backup;`. With `POWDER_HQ_INGEST_TOKEN` and `POWDER_HQ_GENERIC_URL` set, each finding is also posted as a warning card (one per server for the upstreams, one per app for a missing bridge upstream) that clears on the next deploy that finds none. A server without nginx, or an `nginx -T` that fails, is skipped and posts nothing. The check never fails a deploy.

## Stop, start or delete an app

The danger zone on the app's settings page has three actions.

- **Stop** runs `docker stop` on the app container. Anyone who may restart the app may stop it. It is recorded in the deploy history and the activity feed, and it is refused while a deploy of the app is in flight. A push still waiting on the settle window does not block it: the stop cancels that push. The app stays registered: a push still deploys it.
- **Start** brings the app container up again with `docker compose up`, after the same compose guard a deploy runs. A redeploy starts it too.
- **Delete** needs an admin browser session (never an API token) and the app name typed to confirm. Under the app's deploy lock it removes the app container and, when the compose project is the app's own, every container and network of that project. It then tears down the app's previews, deletes powder's deploy key and webhook on GitHub (like a repo disconnect), and removes the app's row, crons and custom domains. If the containers cannot be removed, nothing else is touched and the delete can be run again.

Delete keeps on the server: the app directory `/opt/apps/<app>/` (compose file, checkout, bind-mounted data such as `pgdata/`), named Docker volumes, and the env file, which moves to `/var/lib/powder/deleted-env/<app>-<time>/` (root only) once no container of the app is left. Remove them by hand when you no longer need them: the app directory, each volume with `docker volume rm <volume>` (list them with `docker volume ls`), and the archive dir.

Anonymous volumes are not kept for good. Containers are removed without `-v`, so an anonymous volume (a `VOLUME` in the image, or a compose volume with no name) is left dangling, and the hourly `powder-image-prune` on the server removes dangling anonymous volumes created more than 7 days ago (`ANON_VOLUME_MAX_AGE_DAYS`, see [Per-server helpers](self-hosting.md#per-server-helpers)). The same happens after a `docker rm` or `docker compose down` by hand. Keep data you care about in a named volume or a bind mount: those are never removed by powder.

A push that arrives while the delete runs is refused with HTTP 409 (`app is being deleted`), and a deploy that was already queued for the app is failed. After the delete, a deploy of that app is refused: it is no longer registered, and powder never guesses a compose file for it. Import the repository again at `/new` to bring it back.

## Keeping secrets out of images

Apps created with `/new` and preview deploys (opt-in per app on its Settings tab, or `PATCH /api/projects/<id>` with `{"previewsEnabled": true}`; pushes to non-branch refs and by `[bot]` pushers never spin one) are cloned into the app directory itself (the "workdir" layout), so the directory also holds powder's runtime files: `.deploy-key`, `docker-compose.yml` and any `pgdata/` or `kvdata/`. To keep them out of image layers, powder writes a `.dockerignore` next to the compose (an existing one in the repo is kept and topped up). The Dockerfiles powder generates are multi-stage on `node:22`. On a dedicated builder, powder also writes the file before `docker build` and refuses to build if a `.deploy-key` or `*.env` file sits in the build context unignored.

A repository is untrusted input in this layout. Right after the clone powder refuses to continue if `docker-compose.yml`, `powder.json`, `.deploy-key`, `.dockerignore` or any `.powder-*` file is a symlink, and it installs the compose and key through a temp file and `mv -f`, so a committed link can never redirect a root-run write. Moving these apps to the `src/` layout (runtime files outside the repo tree) is the follow-up. It needs `readPowderConfig` to read `src/powder.json` first.

## Redirects and powder.json

An optional `powder.json` in the repository can declare redirects, rewrites and response headers. No file in the repository is required: a Dockerfile is enough.

## Published ports

Powder publishes ports on `127.0.0.1` only. It never edits your compose file: it writes its own generated `docker-compose.powder.yml` under `/var/lib/powder/compose/<app key>/` (outside any checkout, do not edit; passed by absolute path as the last `-f` to every `docker compose` call; a repo that tracks a file with that name is refused) holding the Traefik labels and the loopback bindings. For the app service and for database/cache siblings (postgres, pgvector, mysql, mariadb, redis, valkey, memcached, mongo, clickhouse, elasticsearch, rabbitmq, minio images) every published port that binds all interfaces is replaced by the same port on `127.0.0.1`, using the compose `!override` tag, which needs docker compose 2.24 or newer (older: the deploy log says `left public:` and nothing is changed). Proxies (nginx, caddy, traefik, haproxy) and other services are left as written and listed as `left public:` in the deploy log and, with ops endpoint reporting on (`POWDER_HQ_*`), as a warning sent to that endpoint. To keep a service's ports public, give it the label `powder.public-port=true` in your compose file; powder reads it from the resolved config. The deploy log shows a `compose override` step with the result.

## Migrations with your own runner

`powder-migrate` applies plain `*.sql` files (step 6). An app whose migrations are code, such as knex migration files or prisma's migration folders, keeps its own runner and ledger instead: put the command in the image label, not in `CMD`, `ENTRYPOINT` or `package.json` `start`.

```dockerfile
LABEL powder.release.cmd="npx knex migrate:latest"
```

Powder runs it once from the new image before the swap (step 7); a non-zero exit fails the deploy and the old container keeps serving. A migrator at container start instead runs in every new container, the swap-check candidate included, and the app is not serving while it runs. Keep one ledger per app: no `*.sql` folder that `powder-migrate` reads next to the release label. Never run `drizzle-kit push` or `prisma db push` here: a push diffs the live schema with no ledger and can drop columns or data (the `release-cmd` warning). That warning reads only the label text: a push hidden inside a script the label calls (`sh <script>`, an `npm run` script whose name does not contain `db:push`) is not detected.

Both paths change the schema while the old container still serves, and a rollback restores the previous image, not the schema. So every migration must work with the previous release: add first (a nullable column, a new table), switch the code, and drop or rename in a later deploy.

A migration that waits on a lock queues every later query on that table behind it. `powder-migrate` therefore applies each transactional file with `lock_timeout` 10s: a file blocked for longer fails with `canceling statement due to lock timeout`, rolls back, and the deploy stops before the swap. The 10s is sent with the connection, so it also replaces a `lock_timeout` set on the role or database. A file that needs longer sets it itself (`SET lock_timeout = '60s';` at the top). Set a `lock_timeout` in your own migrator too.

Files that `powder-migrate` runs outside a transaction (any file whose SQL, comments left out, uses `CONCURRENTLY` or `ALTER TYPE ... ADD VALUE`) get no lock timeout. `CREATE INDEX CONCURRENTLY` waits for every older transaction in the database (a backup, a long query) without blocking reads or writes, so there is no queue to cut, and stopping it half way leaves an INVALID index. Outside a transaction a timeout would also leave the statements before it applied. These files run with the role or database default.

An INVALID index is what a failed or cancelled concurrent build leaves: Postgres keeps updating it on every write but never uses it, and a rerun with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` skips it because the name exists. The guarantee: a non-transactional file is never recorded while an index it names is INVALID. After such a file runs, `powder-migrate` lists the invalid indexes and fails the file (not recorded, the deploy stops before the swap) when one of them is named in the file's SQL (comments left out) as a whole word (any case; `"Quoted"` and `schema.name` forms count), even if it was invalid before the file ran, so a plain retry that `IF NOT EXISTS` skips fails too. An index that turned invalid while the file ran fails it as well, unless another session's `CREATE INDEX CONCURRENTLY` is still building it when the file ends. When the file itself fails (for example `already exists` on a retry without `IF NOT EXISTS`), the log names the same indexes. The fix is always: `DROP INDEX CONCURRENTLY <name>;`, fix the cause (for a unique index, the duplicate rows), then redeploy. Do not record the file by hand while the index is invalid. An unrelated index that was already invalid and that the file does not name never fails it, and neither does a name that appears only in a comment. If the catalog query fails, the deploy goes on with a warning.

`POWDER_MIGRATE_LOCK_TIMEOUT` changes the default: `0` (none) or a duration from 1s to 600s (`30s`, `1500ms`, `2min`); anything else logs a warning and uses 10s. `powder-migrate` reads it from its own environment, and powder does not pass it: there is no supported per-server setting. It applies when you run the helper by hand (`POWDER_MIGRATE_LOCK_TIMEOUT=30s powder-migrate <app> apply` on the server), or when it is already in the environment of the SSH session powder opens on that server (for example `/etc/environment` on a server whose sshd loads it through PAM), which powder neither sets nor checks. To change it for one migration, set `lock_timeout` in the file.

## Deploy-setup warnings

Some setups deploy fine but carry a known weakness. Powder spots them during the deploy (read-only checks; a check that fails or times out raises nothing) and can raise an ops endpoint warning card for each (`POWDER_HQ_*`, see [Ops endpoint reporting](self-hosting.md#ops-endpoint-reporting)). None of them fails, blocks or changes a deploy.

The cards are posted only with `POWDER_STABILITY_CARDS=on` in powder's env. Off by default: the worker then logs each card it would raise as `[stability] would warn: <key> <reason>` (`docker logs powder-worker`) and posts nothing. There is one card per app and key, and the next deploy without the condition clears it.

| Card key | Raised when | How to clear |
|---|---|---|
| `no-bridge:<server>/<app>` (verdict `nginx-unbridged`) | Traefik does not route the app, it has no `powder.bridge.enabled=true` label, and host nginx (`nginx -T`) proxies to the `127.0.0.1` port the container publishes. The swap 502s for a few seconds on every deploy. | Add the labels `powder.bridge.enabled=true` and `powder.bridge.host-port=<app host port + 10000>`, and the bridge as a backup upstream in the vhost (`server 127.0.0.1:<that port> backup;`, `max_fails=0` on the primary, `proxy_next_upstream error timeout;`). |
| `no-bridge:<server>/<app>` (verdict `host-network`) | Traefik does not route the app, it has no bridge label and it runs with `network_mode: host`, which the bridge cannot clone. | Move the app off host networking first (a bridge network with a published `127.0.0.1:<port>` that nginx proxies to), then enable the bridge as above. |
| `compose-drift:<server>/<app>` | The repo's `docker-compose.yml` differs from the compose file powder runs on the server (the `[compose-drift] WARNING` line of the deploy log). Powder never copies the repo's compose, so a committed compose change does not deploy. | Apply the change to the server's `/opt/apps/<app>/docker-compose.yml` too (or remove an unused `docker-compose.yml` from the repo). |
| `migrate-path:<server>/<app>` | Schema changes bypass `powder-migrate`. The card names the case: `stray-sql` (migration-looking `*.sql` files, numbered or in a `*migrat*` folder, sit in the repo but none in a folder `powder-migrate` reads, so the deploy applies none of them; `node_modules`, build output and test folders are skipped), `boot-cmd` (the image `CMD`/`ENTRYPOINT` runs a schema tool such as `drizzle-kit push`/`migrate`, `prisma migrate deploy` or a migrate script), `release-cmd` (the `powder.release.cmd` label runs a schema push: `drizzle-kit push`, `prisma db push`, `--accept-data-loss`, a `db:push` script; a ledgered migrator there, such as `knex migrate:latest` or `prisma migrate deploy`, is the supported path and raises nothing) or `start-script` (`package.json` `start` runs one). The scan runs right before `db migrate`; previews skip it. An app in the workdir layout gets no `*.sql` walk (its app dir also holds data and backups, where a dated dump would read as a migration), so the scan never reports such an app clean and only the image and start-script cases can raise its card. | Put the schema changes in `src/drizzle`, `drizzle`, `migrations`, `src/migrations`, `supabase/migrations` or `db/migrations` as `*.sql` files: `powder-migrate` applies them before the swap, records each one, and a failing file stops the deploy while the old container keeps serving. |
| `health-url:<server>/<app>` | The app has no health URL, so the health gate passes on any 1xx-4xx answer from `/`: it only proves the app answers HTTP. Not raised for an app the gate could not judge over HTTP (a worker on the liveness fallback) or for a preview. | Set a health URL on the app's Settings tab (or `PATCH /api/projects/<id>` with `healthUrl`) on a cheap route that answers 2xx only when the app can serve (for example `/api/health` checking its database); the gate then requires a 2xx from it. |
| `test-gate:<server>/<app>` | The build context has no `.powder/test.sh`, so nothing tests or typechecks a commit before it replaces the running app. A deploy reports presence either way (on a builder host too). | Commit a `.powder/test.sh` (see **test gate** above). |

## Rotating DATABASE_URL

The `db migrate` step reads `DATABASE_URL` from what the new container will get: the `env_file:` entries of the compose service in order (last wins), then its `environment:` overrides, resolved with `docker compose config`. It does not ask the running container, which still holds the old value until the swap. So a rotated `DATABASE_URL` (or database password) takes effect at the next deploy's migrate step. Only when no env file or `environment:` declares it does the step fall back to the running container, and it says so in the log.

## Deploy and app states

A deploy is in one of four states. The dashboard shows the label.

| State | Label | Meaning |
|---|---|---|
| `queued` | queued | Waiting to start, for example behind another deploy of the same app. |
| `running` | building | The deploy script is running on the server. |
| `success` | ready | Every step passed and the new container serves. |
| `failed` | failed | A step failed. The old container keeps serving; the deploy page names the step. |

An app has one of six states, worked out from its last deploy, its uptime check, the server and the container. A reason can follow the word after a middle dot, such as "unknown · server unreachable".

| State | Meaning |
|---|---|
| `live` | The last deploy succeeded or the uptime check passes. |
| `deploying` | A deploy is running, or queued ("deploying · queued"). |
| `failed` | The last deploy failed. The previous container, if any, keeps serving. |
| `down` | The last uptime check (within 30 minutes) failed, or the container is gone after a good deploy. |
| `stopped` | You stopped it: the last deploy is a stop that succeeded and the container is not running. A start, push or redeploy starts it again. |
| `unknown` | Never deployed, the server does not answer over SSH, or Docker on it does not answer. |
