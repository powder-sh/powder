# Self-hosting powder

Powder is single-tenant: one install per person, for their own servers. There
is no signup. **On an empty install, the first GitHub login that carries the
one-time setup token becomes the admin.**

Powder is one Next.js app (`powder`, the dashboard + API) plus a worker
container (`worker`, executes deploys) and a Postgres database. It reaches your
servers over SSH with a key you control.

The same guide, page by page, is in `apps/web/content/docs/` (served at
`/docs` on every install): quickstart, self-hosting, what your repo needs,
upgrading, uninstall, troubleshooting. Those pages are the user guide and hold
the one env variable reference; this file adds operator detail on top.

## Getting started

Install and first steps: the [Quickstart](../apps/web/content/docs/quickstart.md)
(`/docs/quickstart` on every install). The details of each step, the first
login and adding a server are in
[Self-hosting](../apps/web/content/docs/self-hosting.md); upgrades in
[Upgrading](../apps/web/content/docs/upgrading.md).

## Requirements

- Docker with the Compose plugin, `docker compose` 2.24 or newer (the opt-out
  overrides `docker-compose.unharden.yml` and `docker-compose.shared-db.yml` use
  `!reset` / `!override`).
- A Linux server for powder itself, with root and 2 GB of memory or more. App
  builds run on your app servers, but `bin/install.sh` and every upgrade build
  powder's own image (a Next.js build) on this server; `bin/install.sh` warns
  when memory plus swap is under 2 GB. On a smaller server add swap first:
  `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`,
  then `echo '/swapfile none swap sw 0 0' >> /etc/fstab`. `bin/install.sh` also
  needs `git`, `openssl`, `curl`, `ssh-keygen` and `awk`.
- A public HTTPS hostname for the dashboard, ports 80 and 443 open: GitHub
  OAuth returns to it and push webhooks are delivered to it.
- Postgres 15+ (the reference compose bundles `pgvector/pgvector:pg16`, digest-pinned).
- Root SSH on every server powder manages, with powder's public key in
  `authorized_keys` and port 22 open to it from the powder server. The private
  key is mounted into the powder container. Servers that serve apps need ports
  80 and 443 open too.
- A GitHub OAuth app (for dashboard login and the first-run admin).

# Reference

## Environment variables

One env file: `/opt/apps/powder.env`. The services read it via `env_file:`, and the
deploy scripts also pass `--env-file /opt/apps/powder.env` to every `docker compose`
call, so compose-time interpolation (`POWDER_DB_*`, build args such as
`NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` / `NEXT_PUBLIC_POSTHOG_UI_HOST`, where
the KEY needs the HOST or analytics stays off) comes from the same file. The
deploy rsync excludes `.env`, so never keep config in a `.env` inside the source dir.
`bin/install.sh` creates the file from `docker/powder.env.example` (mode 0600) and
fills the required keys. By hand: `cp docker/powder.env.example /opt/apps/powder.env && chmod 600 /opt/apps/powder.env`
(it holds every secret; `bin/self-deploy.sh` warns while group or other can read it).

Every variable, with its default, is in one table: "The env file" in
`apps/web/content/docs/self-hosting.md` (served at `/docs/self-hosting#the-env-file`),
with the settings the scripts read from their shell environment right below it.
`docker/powder.env.example` carries the same names with generation commands; a test
fails when the code reads a variable that neither lists.

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
- `/api/health` answers the public only `{"status":"ok"}` (or `degraded`, 503), on every host; the version, DB, scheduler and claim-loop detail goes to a signed-in admin (session or API token) on the dashboard host and to callers inside powder's own container (`127.0.0.1:3000`, e.g. `docker exec powder ...`). In that detail `claimLoop` is `{started, owner, lastTickAt, staleSeconds}` of the deploy worker's claim loop when `POWDER_DEPLOY_WORKER` is on, and the string `"in-web"` when it is off (deploys run in the web process; there is no claim loop to watch). An on-server `curl 127.0.0.1:<port>` through the published port gets the public body, which is all `bin/self-deploy.sh` needs. The site host never shows it.

## Login protection

Two limits apply to email sign-in:

- Per IP: better-auth's rate limiter. The IP comes from the header named by `POWDER_TRUSTED_IP_HEADER`. The default, `x-real-ip`, is the one powder's Traefik sets from the TCP peer. Behind Cloudflare set `POWDER_TRUSTED_IP_HEADER=cf-connecting-ip` (otherwise every visitor shares the bucket of a Cloudflare edge IP), and lock the origin to Cloudflare's IP ranges in the firewall: if the server is reachable directly, a client can set `cf-connecting-ip` itself and every attempt lands in a new bucket. A host firewall such as ufw does not filter ports Docker publishes (Docker's own iptables rules run first): put the Cloudflare allow-list in the `DOCKER-USER` iptables chain, or use your cloud provider's firewall.
- Per account: 10 failed email sign-ins for one address within 15 minutes lock email sign-in for that address for 15 minutes, even with the right password. A successful sign-in resets the count. The counter is in memory and resets when powder restarts. Someone who knows the address can keep its email sign-in locked; GitHub sign-in is not affected.

Behind a proxy other than powder's Traefik, that proxy must set `X-Real-IP` from the TCP peer (and overwrite any value the client sent):

```nginx
location / {
    proxy_pass http://127.0.0.1:3050;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

```caddyfile
deploy.example.com {
    reverse_proxy 127.0.0.1:3050 {
        header_up X-Real-IP {remote_host}
    }
}
```

Without it powder sees whatever the client sent in that header (nginx and Caddy pass a client-supplied `X-Real-IP` through unless you overwrite it, so a client could pick its own rate-limit bucket); set it as above so the proxy overwrites it. With no header at all powder logs `[client-ip] WARN a request reached powder without a x-real-ip header` once, and the limiters fall back so that no client can lock out everyone: webhooks are limited per token, MCP per credential, and sign-in per email only (better-auth's per-IP limiter is skipped for requests without an IP instead of sharing one bucket).

## Notifications

`/settings/notifications` lists notification targets: webhooks (any http(s) URL, stored encrypted with `POWDER_ENCRYPTION_KEY`) and email addresses (needs `POWDER_SMTP_URL` and `POWDER_MAIL_FROM`; without them the page shows "SMTP not configured"). Each target subscribes to events and can be limited to one app. "send test" sends one test message.

| Event | When |
|---|---|
| `deploy_failed` / `deploy_succeeded` | A deploy ends |
| `app_down` / `app_up` | The uptime check sees an app stop responding / recover |
| `backup_failed` | A backup row ends `failed` (dump, upload or watchdog reap) |
| `backup_stale` | No successful backup within 36h (held to one alert per app per 23h) |
| `cron_failed` | A powder-scheduled cron run fails or times out (held to one per app per 30 min) |

- Webhook body: `{event, app, server, message, url, at}` plus `content` and `text` (same one-line message) for Discord and Slack.
- `POWDER_NOTIFY_WEBHOOK_URL` stays an implicit target for `deploy_failed`, `app_down`, `app_up` and `cron_failed`.
- Sends are best effort: 5s webhook and 10s SMTP timeouts, failures are logged and never block a deploy. The same event for the same app is sent once per 5 minutes (per process; a restart can send one repeat).
- Webhook URLs must be http or https, without credentials, and must not resolve to loopback, link-local (cloud metadata) or `0.0.0.0/8`; stored targets never follow redirects. Private and tailnet addresses are allowed.

## DEPLOYMENT.md sync (per app, opt-in)

After a successful deploy powder can commit a `DEPLOYMENT.md` (server id, live hostnames, how to deploy) to the app's GitHub repo. It is off by default; turn it on per app on the project's settings tab, or with SQL: `update app_repos set sync_deployment_md = true where container_name = '<app>';`. It commits to the deploy branch only when the file changed, and that commit triggers its own deploy.

## Server bootstrap (check first)

"check server" on the server's page is read-only. Over SSH it reports, in
this order: the Docker engine and the compose plugin, the docker networks `web`
and `internal`, a container named `traefik` running the file provider on
`POWDER_TRAEFIK_DYNAMIC_DIR` (traefik servers), `/opt/apps` and the dynamic
dir, ufw (report only), free disk on `/` and memory (warnings under 10 GB free
or 2 GB total), `git` and `flock` (required; "fix missing pieces" does not
install them: use the distro's package manager, packages `git` and
`util-linux`), the helpers `powder-migrate` and `powder-image-prune` (a warning
when missing or outdated), the cron file `/etc/cron.d/powder-image-prune` (a
warning when missing; other content is reported and left alone), and
`powder-resource-guard` as information only (installed, or optional and not
installed). On `nginx` / `nginx-container` servers the Traefik pieces are
informational and never count as missing. The check and the fix follow the
server's saved `proxy`.

"fix missing pieces" shows the exact commands first, then re-checks the server and
runs only those still needed. It only adds: missing networks, missing
directories (the dynamic dir only on traefik servers), Docker 29.x from
Docker's apt repository only when docker is absent, the helpers `powder-migrate` and `powder-image-prune` when absent,
`/etc/cron.d/powder-image-prune` (root:root 0644, the line from the script's
header) when absent and the helper is there or being installed,
`/etc/logrotate.d/powder-traefik` on traefik servers when absent (see "Traefik
access log" below), and a
`traefik:v3.6` container pinned by registry digest (file provider on the dynamic dir,
`le` ACME resolver over HTTP-01, JSON access log at
`/var/log/traefik/access.log`) only when all of these hold: the server's proxy
is `traefik`, there is no container named `traefik`, nginx is not installed
(`command -v nginx`) and no nginx systemd unit is enabled, `ss -ltn` succeeds
and shows nothing on 80/443, and no container, running or stopped, binds 80/443
or comes from an nginx/traefik/caddy/haproxy/envoy image. Anything it cannot
read counts as a reason to refuse. Right before `docker run` the Traefik step
checks again on the server for a container named `traefik`, nginx (binary and
systemd unit), listeners on 80/443 and containers binding 80/443; the proxy
image check is not repeated there. A helper that differs from the copy in this
powder is reported as outdated, and its replacement is listed apart in the
dialog, unticked: it runs only when you tick it. A cron file that exists is
never changed.

The Docker step supports Debian and Ubuntu: it installs `ca-certificates`,
`curl` and `gnupg`, downloads Docker's repository key to a temp dir, and trusts
it only when the file holds one primary key with the fingerprint
`9DC858229FC7DD38854AE2D88D81803C0EBFCD88` (Docker's published key). The key
goes to `/etc/apt/keyrings/docker.asc`, the source
`/etc/apt/sources.list.d/docker.list` names it in `signed-by`, and the step
installs the newest `docker-ce` 29.x with `docker-ce-cli`, `containerd.io` and
the buildx and compose plugins. The 29.x pin holds for the install; a later
`apt upgrade` follows Docker's repository. On any other distro the step refuses:
install Docker Engine and the compose plugin yourself
(docs.docker.com/engine/install) before running the bootstrap, and the Docker
step then reports it as present and does nothing.

`bin/server-bootstrap.sh --docker-script` (and `bin/install.sh
--docker-script`) uses Docker's convenience script instead
(`get.docker.com --version 29.4`). Only that flag runs it; `--yes` alone never
does, and the dashboard never does. The script is fetched over HTTPS but has no
version pin of its own, so the step prints its sha256 before running it and
refuses a script that differs from `POWDER_GET_DOCKER_SHA256` when that is set
in its environment.

Traefik access log: the Traefik the bootstrap starts writes a JSON line per
request to `/var/log/traefik/access.log` (the dir is created root-only, mode
0750). Each line holds the client IP and the full request path, including the
token in a deploy webhook URL (`/api/webhooks/deploy/<token>`), so treat the file as secret and
keep it off shared backups. `/etc/logrotate.d/powder-traefik` rotates it daily
(sooner past 100 MB), keeps 7 compressed copies and uses `copytruncate`, so
Traefik keeps writing to the same file. An existing file at that path is left
as is.

It never restarts or modifies an existing container, Traefik or nginx, never
runs ufw, and does nothing when the SSH user is not root. Installing Docker
does change iptables (Docker adds its own chains and NAT rules), and the ports
Traefik publishes go through Docker's iptables rules, which bypass ufw.

Prefer a shell? `bin/server-bootstrap.sh` runs the same check on the server
itself (`sudo bin/server-bootstrap.sh --proxy nginx`; for a check `--proxy`
defaults to `traefik`). `--apply` requires `--proxy` (the server's routing
mode), prints the same plan and asks before running it (`--yes` skips the
prompt; it never picks the convenience script). An outdated helper is only
reported unless you add `--replace-helpers`. `--docker-script` installs a
missing Docker with Docker's convenience script instead of the apt repository.

## The standard app shape on a server

What `/new` creates:

```
/opt/apps/<app>.env      # the app's env file, rendered from powder's DB on deploy
/opt/apps/<app>/         # git checkout of the app repo (the build context, has the Dockerfile)
├── docker-compose.yml   # runtime compose, server-local, written by powder (0600)
├── .deploy-key          # read-only deploy key (0600)
├── .dockerignore        # powder's entries last: deploy key, compose, env files, data dirs
├── pgdata/              # the bundled Postgres data (when the app has a database)
└── kvdata/              # the bundled Redis data (when the app has a cache)
```

The compose service carries BOTH `image: <app>:latest` and
`build: { context: ., dockerfile: <path> }`, plus `env_file: /opt/apps/<app>.env`.
The presence of `build:` is what makes deploys build on-server. Every deploy
force-syncs the checkout to GitHub (keeping the runtime compose), so the copy on
the server is disposable and the repo is the source of truth. powder's own
override (published ports on 127.0.0.1, domain labels) lives outside the app dir,
as `docker-compose.powder.yml` under `/var/lib/powder/compose/`. An app adopted
from a running container keeps its own layout (often the checkout in `src/` and
`build: { context: ./src }`).

Optional server-wide memory cap: put a size such as `2g` in `/opt/apps/.mem-cap` on an app server (`echo 2g > /opt/apps/.mem-cap`). With that file present and non-empty, every deploy caps each app container at that size (`docker update --memory --memory-swap`), overriding a compose `mem_limit` (the file is the operator's server-wide opt-in), and sets `restart: unless-stopped` on one whose restart policy is none; an explicit restart policy wins. Without the file a deploy leaves memory limits and restart policies as compose set them; the optional `powder-resource-guard`, if you install it, still caps every container that has no limit at 2g. Only a deploy applies the file: a container recreated by a rollback or a domain change runs with its compose settings until the next deploy.

Apps should bundle their own Postgres as a `db` service in the same compose -
powder's backup pipeline discovers it from the project's backup settings.

Networks: an app created at `/new` joins `web` (Traefik) and its own db/kv networks
only. If it must reach a container of another project on the server (a shared
database on the `internal` network), tick "join the shared internal network" on
`/new`, or send `"sharedInternal": true` to `POST /api/apps`. For an existing app,
add `internal` (external: true) to its runtime compose's networks.

## Health check before swap

After the image is built and the release step, before `up -d --force-recreate`,
the deploy starts the new image as `<app>-next` with
`docker compose run -d --no-deps --name <app>-next --label traefik.enable=false --label powder.candidate=1 <service>`
and probes it by container IP with the app's `health_url` path and Host header
(60 s budget, one try per 5 s).

Set `health_url` on the app's Settings tab ("health and uptime"), or with `PATCH /api/projects/<id>` and `{"healthUrl": "/api/health"}` from a signed-in browser session. `health_url` may be a path (`/api/health`) or an absolute `http(s)` URL. A path is used by both the deploy health gate (against the new container) and the uptime checker (joined with the app's live domain, else the server's default host); an absolute URL is used as-is by uptime, and the deploy gate probes the new container with its path and sends its host as the Host header.

What the candidate inherits: the compose service's resolved config, i.e.
`env_file` AND `environment:` (which overrides the env file), `command:`,
`user:`, `working_dir`, volumes, and networks. It gets no published ports (no
`--service-ports`) and is not routed by Traefik. Volumes are mounted exactly like
the real container, so the candidate shares the live app's volumes for the probe
window (typically under a minute); an app that must not have two processes on its
volumes at once should set `swap_check = false`. The memory cap is
`/opt/apps/.mem-cap` (else the live container's limit).

Probe port, in order: `PORT` in the candidate's effective env, the container side
of the live container's published ports, the Traefik `loadbalancer.server.port`
label, the image's `EXPOSE`, then 3000.

Outcomes (log lines `swap-check: ...`):
- Healthy (`healthy in Ns`): the recreate runs, then `<app>-next` is removed.
- Failed: with a `health_url` any non-2xx or no answer; without one a real 5xx; in
  both cases also when the candidate exits. The last 200 log lines go into the
  deploy log, `<app>-next` is removed, the deploy fails with step `swap-check`,
  and the old container is untouched (no rollback needed).
- Loose mode (no `health_url`): if no attempt ever got an HTTP answer and the
  candidate is still running (a worker or non-HTTP service), the step prints
  `swap-check: skipped (candidate never answered HTTP)` and the deploy continues.
- Skipped (deploy continues as before): host-network apps, no running container,
  no `curl` on the server, or `docker compose run` failing.

Switches: per app `UPDATE app_repos SET swap_check = false WHERE container_name = '<app>'`
(column from `packages/db/drizzle/0039_app_repos_swap_check.sql`, applied
automatically, default `true`); for every app, env `POWDER_SWAP_CHECK=off`.

A `*-next` container older than 30 minutes on any server raises one
`swap-check leftover` warn card per server (checked every 5 minutes by the scheduler).

## Routing mode per server (`servers.proxy`, `servers.tls_mode`)

Set them on the server's page in the dashboard (`/servers/<id>`, admins only),
next to `base_domain` and `ingress_ip`. They are the columns `servers.proxy`,
`servers.tls_mode`, `servers.base_domain` and `servers.ingress_ip` (migrations
0040, 0041, 0046). A server added from the dashboard starts on `traefik`.

- `proxy = 'traefik'` (supported, the default for new servers): apps are
  routed by Traefik labels in the app's compose. It switches on custom domains (`applyDomainsToCompose`),
  traffic stats (reads `/var/log/traefik/access.log`), atomic rollback,
  snapshots, the per-deploy label sync and www/path redirects, which are written
  as a Traefik file-provider fragment,
  `/opt/infra/traefik/dynamic/redirects-<app>.yml` (redirectRegex middleware plus
  a `websecure` router at priority 300).
- `proxy = 'nginx'` (column default) and `proxy = 'nginx-container'`
  : host nginx, or nginx in a container, plus a host port. Redirects
  are managed nginx server blocks. Kept working for servers that already use
  it; the Traefik features above are not available there (www/apex redirects
  are, from the Domains page). The column default stays `nginx`; servers added
  from the dashboard get `traefik`.
- `tls_mode` (only read when `proxy = 'traefik'`): `acme` (default) emits
  `tls.certresolver=le` (HTTP-01); `origin-cert` emits `tls=true` with no
  certresolver, for servers that serve a Cloudflare origin cert from Traefik's
  default store.

Redirects precondition: the server's Traefik container (named `traefik`) must run the
file provider on a directory mounted from `/opt/infra/traefik/dynamic`, with watch
on (`--providers.file.directory=...` plus `--providers.file.watch=true`, or the same
under `providers.file` in a mounted `traefik.yml`). Powder checks this with
`docker inspect traefik` before each write and fails the apply with `Traefik on
<server> has no file provider for /opt/infra/traefik/dynamic (add
providers.file.directory + watch and mount it)` otherwise. A docker-provider-only
Traefik therefore cannot take www/path redirects until that is
added.

Limits: the label writer emits one `Host(...) || Host(...)` rule per app.
Wildcards, `www` variants and other non-Host rules belong in the file provider.
If the compose service has no `labels:` key, powder inserts one directly under the
service, at the service's own property indent.

Traefik's service health check probes the path of the app's health URL
(`app_repos.health_url`, scheme, host and query dropped; `/` when unset). That
path must answer 2xx/3xx without a Host header, or Traefik marks the service
unhealthy and serves 503. Set `health_url` to a path that does (e.g. `/api/health`)
on the app's Settings tab.

### Base domain per server (`servers.base_domain`)

Each app gets a default host `<app>.<base_domain>` and each preview
`pv-<app>-<branch>.<base_domain>`. Set it on the server's page: a bare
lowercase hostname (no scheme, no wildcard, e.g. `apps.example.com`); empty
clears it. "check DNS" resolves a random `<label>.<base_domain>` and compares
it with `ingress_ip` (else the server's host): ok, mismatch (expected behind a
Cloudflare proxy) or no wildcard record.

- DNS: a wildcard record `*.<base_domain>` pointing at the server (A record to its
  public IP; behind Cloudflare, proxied). On `tls_mode='acme'` each host gets its
  cert on first hit; on `origin-cert` the default-store cert must cover
  `*.<base_domain>`.
- With `base_domain` NULL there is no default host: new apps get no router label
  until you attach a custom domain, uptime checks need `health_url` or a live
  custom domain, HTTP crons need a live custom domain (see "Managed crons"), snapshots are unavailable,
  and the webhook answers a branch push with `{ignored, reason}` (previews need
  the base domain).
- There is no fallback domain for any server: NULL always means no default host.
- The Servers page shows `base_domain` next to `proxy` / `tls_mode` and links
  to the server's page to edit them; `/api/servers` and `/api/servers/list`
  include it.

## Deploying powder itself

Powder cannot deploy itself through a webhook, so you deploy it with a script. On the server,
`git checkout` the new tag and re-run `bin/install.sh`. From a workstation use
`bin/self-deploy.sh` - it encodes the runbook: refuses while deploys are in
flight, builds **both** `powder` and `worker` (deploys execute in the worker -
rebuilding only the web container ships stale deploy code), health-checks
before declaring success. Configure with `POWDER_HOST=<root@ip>` (see the
script header).

### Container hardening

By default `powder` and `worker` drop every Linux capability and set
`no-new-privileges` (docker-compose.yml). Both stay root: the entrypoint and node
need no capabilities (no chown/su), and root still reads its own 0600 SSH key.
`POWDER_HARDEN=false` in powder.env (true or false) makes `bin/self-deploy.sh` add
`docker-compose.unharden.yml`, which removes both settings: use it only while a server
is not verified yet. Check a server after the upgrade with
`docker inspect powder powder-worker -f '{{.Name}} {{.HostConfig.CapDrop}} {{.HostConfig.ReadonlyRootfs}}'`,
`/api/health`, one dashboard action that uses SSH (servers page sync), creating a
deploy key (a new app or a preview) and one app deploy. Any failure: set
`POWDER_HARDEN=false` and self-deploy.

`POWDER_WEB_READONLY=true` (opt-in) adds `docker-compose.web-readonly.yml`: a
read-only root filesystem for `powder`, with tmpfs `/tmp` and
`/app/apps/web/.next/cache`. The worker is never read-only (pnpm/corepack and tsx
write caches at start).

### powder on the web network

`powder` and `worker` join the external `web` network so Traefik can route the
dashboard. Every app container on the same server that joins `web` (all Traefik-routed
apps) can therefore open `http://powder:3000` directly, skipping Traefik, with any
`X-Real-IP` and `Host` headers it likes: a fresh per-IP rate-limit bucket per
request (the per-email sign-in lockout and the per-token webhook limit still apply)
and the `/api/health` detail meant for on-server callers (`isLoopbackRequest` in
`apps/web/src/lib/hosts.ts`). Every dashboard and API
route still needs a session or an API token, webhooks still need their HMAC
signature, and the `POWDER_SITE_HOST` split is routing, not a security boundary.

Not built in, because moving the dashboard's Traefik network on a running
server can take the dashboard offline. The design, for a server whose apps are not
trusted:

1. `docker network create powder-edge` and attach only Traefik to it
   (`docker network connect powder-edge traefik`, plus the network in Traefik's own
   compose so it survives a recreate).
2. An override file that replaces `web` with `powder-edge` for `powder` (and drops
   `web` from `worker`, which needs no inbound traffic; it reaches the managed
   servers over SSH, not over `web`), and adds the label
   `traefik.docker.network=powder-edge` so Traefik routes over that network.
3. `POWDER_HQ_*` URLs or anything else the worker reached over `web` by container
   name must move to a public URL first.
4. Verify: `docker network inspect powder-edge -f '{{range .Containers}}{{.Name}} {{end}}'`
   lists only traefik and powder; from an app container `getent hosts powder`
   resolves nothing; the dashboard answers through Traefik.

Simplest alternative: run powder on a server with no tenant apps.

## Managed crons

Each app's **Crons** tab defines jobs that powder itself runs, logs and alerts on.
Schema: `packages/db/drizzle/0053_managed_crons.sql` (new columns on `cron_jobs`,
new table `cron_job_runs`).

- **Kinds.** `http`: a GET or POST to a path on the app. The host is resolved
  like the uptime check: the app's first live custom domain, else its default
  host (`<container>.<servers.base_domain>`); with neither the run fails. The
  path must be a path, never an absolute URL, and redirects are not followed.
  The request carries `Authorization: Bearer <value>`, where the value is the
  app env var you name (read from powder's env DB, production scope, else from
  the running container's env), or the per-app `POWDER_CRON_TOKEN` when no name
  is set. That token is shown once, only to an admin browser session whose create or
  import minted it; the crons card says "is set" otherwise, and its "rotate token"
  button (admin browser session only, never an API token) mints a new one and shows it
  once. Crons send the new token from then on: put it in the app's env. `exec`: `docker exec <container> <argv...>` over SSH. The argv is
  stored as an array and every element is single-quoted on the host, so nothing
  is expanded; to use shell syntax write `sh -c '...'` explicitly (the container
  needs a shell). The host runs it under coreutils `timeout`; a timeout ends
  the `docker exec` client, a process inside the container may outlive it.
- **Schedule.** 5-field cron plus an IANA timezone (default `UTC`). The
  in-process scheduler fires due jobs once a minute. It runs in exactly one
  process (the worker with `POWDER_DEPLOY_WORKER` on, else web), and each firing
  is claimed with a conditional UPDATE on `next_run_at`, so a second process
  cannot fire the same slot. A job paused and resumed does not fire missed runs.
- **Overlap.** If the previous run is still running, the new firing (scheduled
  or "run now") is recorded as `skipped`. The running mark (`cron_jobs.running_since`)
  counts as dead after the job timeout plus 60 s, so a worker restart mid-run
  does not block the job.
- **Runs.** Every run stores status, duration, HTTP status or exit code and the
  output (first 4 KB plus last 12 KB). The newest 50 runs per job are kept.
- **Alerts.** The first failed or timed-out run after a success sends
  `cron_failed` to `POWDER_NOTIFY_WEBHOOK_URL` and every notification target
  subscribed to it; further failures in the same
  streak do not repeat it.
- **Host crons.** The tab also lists root-crontab lines that look like they
  belong to the app, read-only. "Import" turns a `docker exec <this app>` or
  `curl`/`wget` line into a managed job, created paused. Powder never edits the
  host crontab: run the job with "run now", remove the line from the crontab
  yourself, then enable the job. The host cron daemon uses the server timezone,
  so check the job timezone when importing.

## Upgrading (schema applied automatically)

Steps for both paths (on the server with `bin/install.sh`, or `bin/self-deploy.sh`
from a workstation) and rollback:
[apps/web/content/docs/upgrading.md](../apps/web/content/docs/upgrading.md).
The rules in detail:

There is no SQL to hand-apply before an upgrade, but take a dump first: some
migrations remove tables or delete rows (the release notes in CHANGELOG.md name them),
and a rollback past them needs it.

```
docker exec powder-postgres pg_dump -U admin powder | gzip > /root/powder-pre-upgrade-$(date +%F).sql.gz
```

(`postgres` instead of `powder-postgres` on the shared-network layout, see "DB network cutover"; your
`POWDER_DB_USER` / `POWDER_DB_NAME` if set.) Powder brings its own schema
up to date, and two paths do it with the same rules, from one file
(`bin/lib-migrations.sh`) and one ledger table
(`powder_deploy_migrations(file text primary key, applied_at timestamptz)`):

- **`bin/self-deploy.sh`** (recommended). Pre-deploy files run before it builds
  or recreates anything, post-deploy files right after the recreate. It reads
  the SQL from the extracted `git archive HEAD`, never the working tree.
- **The `powder` container on every start** (`docker/powder-entrypoint.sh`),
  so `docker compose --env-file /opt/apps/powder.env build && docker compose --env-file /opt/apps/powder.env up -d` (in
  `/opt/apps/powder/src`, or a new image) upgrades
  the schema too. Pre-deploy files run before the server starts serving.
  Post-deploy files run in the background once `/api/health` answers 200, or on
  the next start if the app does not get healthy within 10 minutes. The SQL
  is the set baked into the image at build time. The `worker` container does
  not migrate: without the script, start `powder` first
  (`docker compose --env-file /opt/apps/powder.env up -d powder`) and wait until
  `curl -s http://127.0.0.1:3050/api/health` answers at all (the server listens only
  after the pre-deploy files ran; with `POWDER_DEPLOY_WORKER=true` it answers 503
  `degraded` until the worker runs, because the worker owns the scheduler), then
  `docker compose --env-file /opt/apps/powder.env up -d worker` and wait for
  `"status":"ok"`. `bin/install.sh` uses the same order.

The rules:

1. Files in `packages/db/drizzle/` run in filename order through
   `psql -v ON_ERROR_STOP=1` with `SET lock_timeout='5s'`. Each success is
   recorded and printed under `applied:`.
2. Only files with the exact line `-- idempotent` are ever run. Every
   migration from 0051 on must carry it (a test enforces this), so in practice
   every new file applies itself.
3. Phases: files that also carry the exact line `-- post-deploy` (table
   drops) run only in the post phase, so the old code still sees its tables
   while the new image builds. Everything else runs in the pre phase.
4. An unrecorded file without the marker stops everything: the script aborts
   the deploy, and the container exits before serving with the same message
   (`docker logs powder` names the file). Make it idempotent and add the
   marker, or confirm it was applied by hand and insert its name into
   `powder_deploy_migrations`.
5. An empty database (no ledger rows and none of powder's tables) gets every
   file, pre and post-deploy, in filename order, each recorded in the
   transaction that applies it. A marker row makes a first start that fails half
   way resume on the next start. Nothing else is baselined implicitly: a schema
   created by hand is handled in "A schema applied by hand" at the end of this
   page.
6. Each file runs in one transaction, except files using `CONCURRENTLY` or
   `ALTER TYPE ... ADD VALUE`. Appliers take a Postgres advisory lock per file,
   so the script and a starting container can overlap safely.
7. Opt-outs, for emergencies: `bin/self-deploy.sh --skip-migrations` skips
   the script's step AND the boot-time step of the container it recreates (it
   passes `POWDER_SKIP_BOOT_MIGRATIONS=1` through `docker-compose.yml`), so a
   failing file cannot crash-loop the new container. The next run without the
   flag sets it back to 0. Without the script, `POWDER_MIGRATE_ON_BOOT=off` in
   the env file does the same for the container.

Write new migrations idempotent (`IF NOT EXISTS`, `OR REPLACE`, `DO` blocks)
and put `-- idempotent` on its own line.

## Backups and restore

Set `BACKUP_S3_*` and `POWDER_BACKUP_KEY` (table above). Backups run on the app
server: plain-SQL `pg_dump | gzip | openssl enc -aes-256-cbc -pbkdf2 -salt` with
`POWDER_BACKUP_KEY` as the passphrase, verified (decrypt + gunzip + pg_dump
trailer) and uploaded multipart to `<container>/<timestamp>.sql.gz.enc`.
Retention keeps `BACKUP_KEEP_PER_APP` scheduled backups per app and, as a separate
pool, `BACKUP_KEEP_MANUAL_PER_APP` manual ones (default 3): a manual success prunes
manual backups only, a scheduled success scheduled ones only. Manual triggers are
capped at 12 per app per 24 hours for API tokens and non-admin sessions.

Getting one back, on the app's **backups** tab (also linked from `/databases`).
Admin only, and every action is a row in `app_backup_restores` that `/activity`
lists with who did it:

- **download**: a presigned GET link valid for 15 minutes (admin browser
  session, not an API token) plus the exact commands to check the SHA-256,
  decrypt (`openssl enc -d -aes-256-cbc -pbkdf2 -pass file:<key>`), gunzip and
  load it with `psql` (plain SQL dump, so not `pg_restore`).
- **restore**: creates a NEW database `<db>_restore_<yyyymmdd_hhmm>` (UTC) in
  the app's own db container and streams the backup into it on the server (S3 →
  openssl → gunzip → `psql -v ON_ERROR_STOP=1`, nothing written to disk). The
  live database is never a target: the script refuses when the name exists and
  only connects to the live database to run `CREATE DATABASE`. The log streams
  into the tab while it runs. On success the tab shows the app's DATABASE_URL
  with the database name swapped (password masked). To switch, set it on the env
  tab and redeploy; to go back, roll the env var back and redeploy.
- **verify**: the same restore into `<db>_restore_<ts>_verify`, counts tables,
  drops it, and records the result (shown as "last verify" on the tab).
- **drop restore database**: only names matching `_restore_<yyyymmdd_hhmm>`,
  never the live database or the one the app's DATABASE_URL points at, and
  without `FORCE`, so postgres refuses while anything is connected.

One restore/verify/drop runs per app at a time (a unique index on running rows
plus `flock -n` on `/var/tmp/powder-restore-<app>.lock` on the server). They do not
take the build lock: a long restore would stall every deploy on the server. A
restore loads the db container and needs free disk for the restored database
next to the live one. Apps with host postgres (a host in the backups tab's database form) can
download but not restore from the dashboard.

## Operational notes

- One build per server, ever (except the dedicated builder, which runs `POWDER_BUILD_SLOTS` (default 2) builds via `/run/powder-build.lock.N` slots): builds are serialized under
  `flock /run/powder-build.lock` and memory-gated. Never hand-build outside
  the lock. `bin/install.sh` and `bin/self-deploy.sh` also take
  `/tmp/powder-build.lock` when it is a regular root-owned file (a build holding
  that path is not serialised by the `/run` lock), so app builds running under
  that path and powder's own build never overlap. Deploys start only after the
  scripts drained the in-flight ones, so they take only the `/run` lock.
- Deploy logs can contain env banners - the log stream API is auth-gated;
  keep the dashboard behind HTTPS.
- A deploy watchdog reaps rows stuck in `running`/`queued` so a wedged SSH
  session can't hold an app's deploy lock forever.

### Restrict the master SSH key

powder's master key (`/root/.ssh/id_ed25519` on the powder host, mounted into
the powder containers) is root on every managed server. Limit where it works:

- Only the powder host holds the master private key. Not a laptop, not a build
  server, not another app server.
- On every managed server, prefix powder's line in `/root/.ssh/authorized_keys`
  with a source restriction, so a copied key is useless from anywhere else:
  ```
  from="<address powder connects from>" ssh-ed25519 AAAA... powder
  ```
  Use the address the managed server sees powder's connections come from: the
  powder host's public IP, or its private or VPN address when powder reaches
  the server over a private network. List every such address, comma-separated, if
  powder reaches servers over more than one network. Test from the powder host
  (`ssh root@<server> hostname`) after every edit, before you close your own
  session.
- If a server should only be reachable by powder, also limit its sshd to that
  path: a firewall rule that allows port 22 only from powder's address, or
  `ListenAddress` set to a private address only powder can reach.

## Optional integrations

### Ops endpoint reporting (`POWDER_HQ_*`)

For operators who run an ops endpoint of their own that collects events from
many systems. Powder POSTs deploy results, degraded-deploy warnings and cron results
to it with a bearer token. Nothing is sent unless `POWDER_HQ_INGEST_TOKEN` and
at least one URL are set; a normal install leaves all of these unset and uses
`POWDER_NOTIFY_WEBHOOK_URL` for alerts.

| Variable | Purpose |
|---|---|
| `POWDER_HQ_INGEST_TOKEN` | Bearer token sent with every event |
| `POWDER_HQ_INGEST_URL` | Deploy events endpoint |
| `POWDER_HQ_GENERIC_URL` | Warning cards endpoint |
| `POWDER_HQ_CRON_URL` | Cron results endpoint |
| `POWDER_HQ_PROJECT` | Project name sent with events (default `powder`) |
| `POWDER_STABILITY_CARDS` | `on` posts the deploy-setup warning cards below; unset or `off` (default) only logs them as `[stability] would warn: <key> <reason>` |

Every event is one `POST` with `Authorization: Bearer <POWDER_HQ_INGEST_TOKEN>`
and `Content-Type: application/json`. Powder waits at most 3 seconds, never
retries, and only logs a non-2xx answer or a failed request, so a receiver
cannot slow down or fail a deploy. Optional fields may be missing or `null`.
Error texts are masked (secrets redacted) before they leave powder.

**Deploy events** (`POWDER_HQ_INGEST_URL`), one per finished or abandoned deploy:

| Field | Value |
|---|---|
| `project` | `POWDER_HQ_PROJECT` (default `powder`) |
| `env` | always `"production"` |
| `kind` | always `"deploy"` |
| `app` | the app's container name |
| `server` | the server's id in powder |
| `status` | `"success"` or `"failure"` |
| `sha`, `branch` | the deployed commit and branch (optional) |
| `durationMs` | deploy duration (optional, success only) |
| `error` | the failure summary, at most 500 characters (failure only) |
| `deployId` | powder's deploy id, `null` for a queued catch-up deploy that never started; `GET /api/internal/deploys` lists the same ids, so a receiver can find events it missed |
| `deployKind` | the deploy kind, e.g. a rollback (optional) |

**Cron results** (`POWDER_HQ_CRON_URL`), for jobs powder runs itself (backups):

| Field | Value |
|---|---|
| `project` | `POWDER_HQ_PROJECT` (default `powder`) |
| `env` | always `"production"` |
| `kind` | always `"cron"` |
| `job` | `backup:<app>`, `backup-stale:<app>`, `backup-size:<app>`, `backup-tick` or `backup-stale-check` |
| `server` | the server's id in powder |
| `status` | `"success"` or `"failure"` |
| `exitCode`, `durationMs` | optional |
| `error` | the failure text (optional) |
| `heartbeat` | `false` when a success only closes an open failure and is not a heartbeat; missing otherwise |

**Warning cards** (`POWDER_HQ_GENERIC_URL`). A card opens with `severity` and
closes itself with `resolve: true` and the same `source` + `source_ref`, so a
receiver keys open cards on that pair:

| Field | Value |
|---|---|
| `source` | `powder-deploy-warn`, `powder-build-host-disk` or `powder-swap-check` |
| `source_ref` | the card key, see below |
| `project` | the app name for `powder-deploy-warn` (`"powder"` for `nginx-upstream`), `"powder"` for the others (open cards only) |
| `severity` | always `"warn"` (open cards only) |
| `channel` | always `"general"` (open cards only) |
| `resolve` | `true` on a closing event, missing on an open card |
| `title`, `body` | human-readable text |

The `source_ref` keys: `env-refused:<server>/<app>` (the env render was
refused), `builder-fallback:<server>/<app>` (the dedicated builder failed and
the app server built the image), `ports-left-public:<server>/<app>` (published
ports left on all interfaces), `no-bridge:<server>/<app>` (a traefik-routed app
whose deploy swap could not be bridged, so it 502s during every recreate),
`bridge-upstream:<server>/<app>` (a host-port bridge app with no host nginx
upstream that lists the bridge port as backup), `nginx-upstream:<server>` (host
nginx upstreams with a backup server and a single primary without
`max_fails=0`), `build-host-disk:<build host>` (a build host's disk is at risk
after the prune, or its cache prune has been skipped for hours) and
`swap-check-leftover:<server>` (a swap-check candidate container is left
running).

The deploy-setup cards are posted only with `POWDER_STABILITY_CARDS=on` (what
each means and how to clear it: [How a deploy runs](../apps/web/content/docs/deploys.md#deploy-setup-warnings)).
With the switch off powder logs each card it would open as
`[stability] would warn: <key> <reason>` and posts nothing for these keys:

| `source_ref` | Opened when |
|---|---|
| `no-bridge:<server>/<app>` | also for the bridge verdicts `nginx-unbridged` (host nginx proxies to the app's `127.0.0.1` port, no bridge label) and `host-network` (`network_mode: host`); with the switch off these two close it, as `not-routed` does |
| `compose-drift:<server>/<app>` | the repo's `docker-compose.yml` differs from the runtime compose on the server |
| `migrate-path:<server>/<app>` | schema changes bypass `powder-migrate`; the title names the cases (`stray-sql`, `boot-cmd`, `release-cmd` = a schema push in the release label, `start-script`) |
| `health-url:<server>/<app>` | the app has no health URL, so the health gate only proves it answers HTTP |
| `test-gate:<server>/<app>` | the build context has no `.powder/test.sh` |

A deploy that reports the condition gone closes the card; a check that could
not finish opens and closes nothing.

## Special cases

### A schema applied by hand

A database that has powder's tables but an empty `powder_deploy_migrations`
ledger had its schema applied by hand, and powder does not guess what was
applied. Baseline it once: with `bin/self-deploy.sh --baseline` from a
workstation, or one container start with `POWDER_MIGRATE_BASELINE=1` in the env
file (remove it afterwards). Both record ONLY the pinned list in
`bin/lib-migrations.sh` (the files without the marker, printed under
`baselined:`), so a failed first run can be retried; the marked files run again,
which is safe because they are idempotent. A new install never needs this.

### DB network cutover

powder's Postgres is the container `powder-postgres` on the private
network `powder-db` (`internal: true`), with only `powder` and `powder-worker` on it
(both also stay on `web`). No app container can reach it. Use the host
`powder-postgres` in `DATABASE_URL` (the env file `bin/install.sh` writes does). The DB
also answers to the name `postgres` on `powder-db`, so a `DATABASE_URL` with host
`postgres` connects too, but then the layout detection below reads a server with no DB
container as the shared-network layout unless powder.env sets
`POWDER_DB_NETWORK=private`.

The shared-network layout is a supported option, with a warning: the override
`docker-compose.shared-db.yml` runs the DB as `postgres` on the shared `internal`
network, which every app on the server can also join (and so reach the DB, or squat
the name). `bin/self-deploy.sh` detects a server in this layout and keeps it by
adding `docker-compose.shared-db.yml`, with a warning on every run. When a container
exists it decides: a `postgres` container on powder's data dir, or a `powder`
container attached to `internal` wherever its DB keeps its data. With no container
(for example after `docker compose down`), the host in `DATABASE_URL` in powder.env
decides: `postgres` is the shared-network layout unless powder.env sets
`POWDER_DB_NETWORK=private`; any other host (`powder-postgres`) is the private layout
when `powder-pgdata` exists in the data dir, and a new install (no DB yet) when it does
not. `bin/install.sh` and the dashboard self-deploy use the same rule
(`bin/lib-db-layout.sh`). A docker error counts as no container, so the env file
rule above decides. When the layout cannot be detected (the ssh call fails, or the
answer is not a known layout), `bin/self-deploy.sh` and the dashboard self-deploy
stop before anything is recreated. `bin/self-deploy.sh` never refuses a
shared-network server for its layout: it keeps the layout. Two paths do refuse it:
`bin/install.sh` on a shared-network server (upgrade it with `bin/self-deploy.sh`), and
`POWDER_DB_NETWORK=private` there without `--db-network-cutover` (the dashboard
self-deploy refuses that case always, see below). `POWDER_DB_NETWORK=shared` in powder.env selects the
shared-network layout on purpose; `POWDER_DB_NETWORK=private` moves the server to the
private network with the steps below. A self-deploy started from the dashboard
(`POWDER_SELF_SERVICE`) uses the same detection and the same override files
(`POWDER_HARDEN`, `POWDER_WEB_READONLY` too), and refuses `POWDER_DB_NETWORK=private`
on a shared-network server: the cutover needs the script.

Upgrading with plain `docker compose --env-file /opt/apps/powder.env up -d` instead of the script applies the
default layout directly: the DB container is renamed to `powder-postgres` on
`powder-db` (same data dir). powder itself keeps working, but everything else that
uses the name `postgres` breaks, so do the checks in step 1 first.

Before the cutover, move everything that uses the name `postgres`:
- host scripts and cron jobs that run `docker exec postgres` or
  `docker exec -i postgres` against powder's DB (backup jobs included): switch them
  to `powder-postgres`;
- anything that reaches powder's DB over `internal` by host name `postgres`;
- `POWDER_HQ_*` URLs of the form `http://<container>:...`: the worker keeps `web`,
  so a container reachable there stays reachable; one reached only over `internal`
  does not.

On the server that runs powder (`/opt/apps/powder.env`):

1. Check: `grep -l '@postgres:5432' /opt/apps/*.env` (only powder.env may match),
   `docker network inspect internal -f '{{range .Containers}}{{.Name}} {{end}}'`,
   `grep -rn 'exec postgres\|exec -i postgres' /etc/cron.d /usr/local/bin`, and the
   list above. Install `powder-resource-guard` from this release (it handles both
   container names): `install -m 755 infra/powder-resource-guard.sh /usr/local/bin/powder-resource-guard`.
2. Backup: `docker exec postgres pg_dump -U admin powder | gzip > /root/powder-pre-cutover-$(date +%F).sql.gz`.
3. In `/opt/apps/powder.env`: set `POWDER_DB_NETWORK=private` and change the
   DATABASE_URL host `@postgres:5432` to `@powder-postgres:5432` (running containers
   keep the old values until recreated).
4. From the workstation: `bin/self-deploy.sh --db-network-cutover`. It waits for a
   quiet deploy queue, builds, recreates `postgres` (same data dir, new name +
   network), waits for `pg_isready`, then recreates `powder` and `worker`.
5. Verify: health ok; `docker network inspect powder-db -f '{{range .Containers}}{{.Name}} {{end}}'`
   lists exactly powder-postgres, powder, powder-worker; from an app container
   `getent hosts powder-postgres` resolves nothing; a test deploy of one small app
   succeeds.

Rollback: set `POWDER_DB_NETWORK=shared`, set DATABASE_URL back to `@postgres:5432`,
run `docker compose --env-file /opt/apps/powder.env -f docker-compose.yml -f docker-compose.shared-db.yml up -d --force-recreate postgres`
in `/opt/apps/powder/src`, then `bin/self-deploy.sh`.


