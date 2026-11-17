---
title: Security model
order: 2
description: What powder protects, what you have to protect, and what leaves your servers. Shared responsibility for a self-hosted deploy tool.
---

Powder runs on your servers and you are responsible for them. This page says where powder helps and where it does not. To report a vulnerability, see [SECURITY.md](https://github.com/powder-sh/powder/blob/main/SECURITY.md).

## Powder has root on your servers

Powder deploys over SSH with a key you install in `authorized_keys` on each server (see [Self-hosting](self-hosting.md)), usually for root. That is by design: it runs Docker, writes under `/opt/apps` and reads logs. Anyone who controls powder controls those servers. Treat the control plane like a root credential.

## Protect the control plane

- **One admin.** There is no signup. The first GitHub login on an empty install becomes the admin, but only with the one-time setup token that powder prints to its own log (entered at `/setup`), so whoever reaches a fresh public install first cannot claim it. After that `POWDER_ADMIN_USER_IDS` pins admin ids from then on. Once any id is set, no new user can be created through login. Set it right after first login, and keep the GitHub account behind it protected (2FA).
- **GitHub OAuth.** Sign-in asks for the `repo`, `admin:repo_hook`, `read:user` and `user:email` scopes, because powder installs deploy keys and webhooks. The stored GitHub tokens are encrypted at rest.
- **Single tenant.** Non-admin sessions get a 403 on every API route. This is always on; `POWDER_SINGLE_TENANT` is ignored (a note is logged at startup if it is set).
- **HTTPS.** Serve the dashboard over HTTPS only. Sessions last 30 days.
- **Network.** The compose file binds powder to `127.0.0.1:3050`. Put a reverse proxy in front of that port, firewall everything else, and if you can, keep the dashboard on a VPN or Tailscale instead of the open internet. GitHub must still reach `/api/webhooks` for push deploys, so then serve the public site and webhooks on a public host with `POWDER_SITE_HOST` (see [Self-hosting](self-hosting.md)) or expose only that path publicly. A proxy other than powder's Traefik must set `X-Real-IP` from the TCP peer (nginx: `proxy_set_header X-Real-IP $remote_addr;`, Caddy: `header_up X-Real-IP {remote_host}`), or the rate limiters cannot tell clients apart (powder logs a warning).
- **SSH key.** The private key mounted into the containers is the key to every server. Use one key for powder, restrict who can read it on the host, and remove it from `authorized_keys` on a server you no longer manage. Deploy git traffic checks GitHub's published host keys strictly.

## Protect the database and the encryption key

Secrets are stored encrypted in powder's Postgres under one of two keys:

- `POWDER_ENCRYPTION_KEY` (AES-256-GCM): deploy keys, webhook secrets, app env vars, cron tokens, notification webhook URLs and GitHub personal access tokens.
- `BETTER_AUTH_SECRET`: the GitHub OAuth tokens of signed-in users (better-auth `encryptOAuthTokens`), besides signing sessions.

- Whoever has the database and EITHER key can read the secrets under that key: with `POWDER_ENCRYPTION_KEY`, every deploy key, env var and token above; with `BETTER_AUTH_SECRET`, the GitHub OAuth tokens. Keep the database apart from both keys, and do not expose Postgres to the network.
- Every stored secret depends on that key. If you lose it, they are lost: you have to re-enter env vars and regenerate keys and webhooks.
- Rotating it is manual. Nothing re-encrypts existing rows for you. Back the key up somewhere other than the server.
- `BETTER_AUTH_SECRET` signs sessions and encrypts the GitHub OAuth tokens. Keep it secret. If it leaks, rotate it (everyone is signed out), revoke powder's GitHub OAuth grant (GitHub, Settings, Applications, Authorized OAuth Apps) for every user, and sign in again so a new token is stored.

## What a deployed repo can do on the server

When you connect a repo, powder clones it on your server and builds its Dockerfile there with Docker. Build steps run on your server, and the container runs there afterwards as root inside its own namespaces. Assume anyone who can push to a connected repo (collaborators, a compromised CI token, a merged pull request) can run code in that app's container and its build. Powder limits what that code can reach on the server; it does not make an untrusted app safe to host next to secrets it should not see.

What powder enforces on every deploy:

- **Compose guard.** Before anything is built, powder resolves the app's compose config (`docker compose config`, merges and interpolation applied; compose `include` and `extends` are refused outright) and checks it against an allow-list: no privileged containers, added capabilities, devices, host or other-container namespaces, `network_mode: host`, binds outside `/opt/apps/<app>`, env files, secrets or build contexts outside the app, another app's container name, DNS alias, volume, image or Traefik route, and more (full list: `docs/SECURITY-COMPOSE.md`). It enforces by default (`POWDER_COMPOSE_GUARD` unset). The checked config is pinned by hash: if a git sync or anything else changes it before `compose up`, the deploy is refused. A config that differs from the one the last successful deploy ran with is always checked again, and a refused deploy resets the checkout to the last good commit.
- **Build pulls.** Builds pass `--pull` by default, so `FROM` and `COPY --from` resolve from the registry, never from another app's local-only image on the same server.
- **Test gate.** `.powder/test.sh` runs in a throwaway container with `no-new-privileges`, on its own per-run network (if Docker cannot create that network, the deploy is refused: there is no shared test network where test containers of different apps could reach each other), against a copy of the committed files only (never the deploy key, rendered env files or data dirs), with an allow-listed image (official `node:<tag>` or a digest-pinned one).
- **At import,** the runtime compose powder renders goes through the same allow-list, plus a check of the Dockerfile path and container port.

Limits:

- The guard reads the compose config, not your Dockerfile or source. A build step can do anything a Docker build can do (network access, large downloads, using CPU and disk), and the running app can do anything its container allows: read its own env vars, reach the networks it is on (including any shared network you attach it to), and talk to the internet.
- Docker is the only isolation. A container escape or a kernel bug is out of scope, and so is anything an operator exempts with `POWDER_COMPOSE_GUARD_EXEMPT` or allows with `POWDER_COMPOSE_GUARD=warn`.
- The Docker daemon is shared by every app on a server. BuildKit cache mounts (`RUN --mount=type=cache`) get per-app salted cache ids: powder rewrites every cache mount of the Dockerfile before the build, so one app cannot name another app's cache. The layer cache and the daemon itself stay shared, and `--pull` closes the local-image path; two apps' builds are still not fully independent.
- Traefik, started by `bin/server-bootstrap.sh` (or the dashboard's "fix missing pieces"), mounts `/var/run/docker.sock` read-only to read container labels. Read-only applies to the socket file, not to the Docker API: whoever controls the Traefik container can run any Docker command, which is root on the server. Keep Traefik's image pinned and its dashboard and API off, or put a Docker socket proxy in front of it that only allows the read calls Traefik needs (containers, networks, events, version) and point Traefik's Docker provider at that proxy.
- Apps on the same server share its CPU, memory and disk.

## Hardening for shared servers

If more than one party can push to the apps on a server, or a server hosts apps you do not fully trust:

- Keep the defaults: `POWDER_COMPOSE_GUARD` unset (enforce), `POWDER_BUILD_PULL` unset (pull), `POWDER_HARDEN` unset (powder and the worker run with no capabilities and `no-new-privileges`), the private DB network (powder's database reachable only by powder and the worker).
- Keep `POWDER_COMPOSE_GUARD_EXEMPT` empty, or limited to `<server>/<app>` keys for apps you control.
- Give untrusted apps their own server. The guard stops a compose file from taking over the server; it does not stop a noisy neighbour.
- Do not attach untrusted apps to the shared `internal` network (`/new` leaves it off by default); every container on a shared network can reach the others on it.
- powder and the worker are on the `web` network so Traefik can reach the dashboard, and every app on that server that joins `web` (every Traefik-routed app does) can reach powder's port 3000 directly, without Traefik. Such a request carries whatever `X-Real-IP` and `Host` headers the app sets: it can pick a fresh per-IP rate-limit bucket for every request (the per-email sign-in lockout and the per-token webhook limit still apply), and the `/api/health` detail meant for on-server callers. Everything still needs a session or a token, and the site/dashboard host split is a routing convenience, not a boundary. If apps on the dashboard's server are untrusted, run powder on a server of its own, or see `docs/SELF-HOSTING.md` "powder on the web network" for a dedicated Traefik network.
- Protect the branch powder deploys: require reviews on it, since a merge to it is a deploy.
- Set `POWDER_TRUSTED_IP_HEADER` for your proxy (`x-real-ip` behind powder's Traefik, the default; `cf-connecting-ip` behind Cloudflare only with an origin lock in the `DOCKER-USER` iptables chain or a cloud firewall, since ufw does not filter ports Docker publishes), so login and webhook rate limits see the real client.
- Serve the dashboard over HTTPS (`BETTER_AUTH_URL` with `https://`), and keep its port bound to `127.0.0.1`.
- Use long random values for `BETTER_AUTH_SECRET` and `POWDER_ENCRYPTION_KEY` (`openssl rand -hex 32`); powder refuses short or low-entropy ones.
- Turn on `POWDER_WEB_READONLY=true` once you have checked it on your server.

## Webhooks

Each repo gets its own webhook secret and URL token. Powder checks the `X-Hub-Signature-256` HMAC-SHA256 signature of push and ping deliveries against that repo's secret with a constant-time comparison and rejects a bad signature with 401. A token that names no app gets the same 401, after the same database lookups and the same HMAC work, so a caller without the secret cannot tell a valid token from an unknown one. Other events are ignored.

An unknown token cannot be signature-checked, so the removal of stale GitHub hooks (a hook still posting to a token powder no longer has) rests on other guards. It starts only for a delivery that carries GitHub's `X-GitHub-Event` and `X-GitHub-Hook-ID` headers and a `repository.full_name`, after the 401 is sent, and only when all of these hold:

- the repository is one this powder manages (an app or monorepo group with that GitHub repository URL);
- the token names no app and no group, checked before the GitHub calls and again right before the delete, so a token registered meanwhile is never touched;
- the hook GitHub returns for that hook id, read with powder's own GitHub integration, has as its URL this powder's own `/api/webhooks/deploy/<that exact token>` (on the webhook base URL, the dashboard URL or a `POWDER_SITE_HOST`), so a forged delivery cannot make powder delete any other hook;
- the attempt budget allows it: one attempt per hook id per 10 minutes and at most 30 attempts per 10 minutes in all, counted only for deliveries that name a managed repository, so forged deliveries naming other repositories cannot use it up.

Uptime checks, HTTP crons and notification webhooks may target addresses in 100.64/10, the range private overlay networks such as Tailscale use, and in fd7a:115c:a1e0::/48. Some clouds serve instance metadata on 100.100.100.200 inside that range, so that one address is refused for all three, like loopback and link-local addresses (169.254.169.254 included). The IPv6 metadata address fd00:ec2::254 (in any spelling) is refused for all three too, although notification webhooks otherwise accept unique-local IPv6 addresses. HTTP crons, which send the app's bearer token, refuse the whole of 100.64/10 and fd7a:115c:a1e0::/48.

## What powder does not protect against

- A compromised GitHub account: it holds the admin login, the repos and the webhooks.
- Code from a repo you deploy, beyond the limits above: what it does inside its own container and build (see "What a deployed repo can do on the server").
- Root on the powder server or a managed server: it reads the key, the env file and the containers.
- A leaked `POWDER_ENCRYPTION_KEY` or `BETTER_AUTH_SECRET` together with a copy of the database.

## Backups

If you configure S3-compatible storage, powder uploads encrypted Postgres dumps there, with the passphrase `POWDER_BACKUP_KEY`. Powder's S3 credentials stay with powder, and the server only gets expiring upload links. The dump is encrypted on the app server, so powder sends `POWDER_BACKUP_KEY` there for each backup (briefly, in a temp file): root on any app server can read that passphrase and decrypt every backup made with it, including other apps' and other servers'. Restore runs from the app's backups tab in the dashboard: into a new database next to the live one (never over it), or as a verify run into a throwaway database; a download comes with the exact decrypt commands. Test a restore before you need it, and keep a copy of the passphrase elsewhere. See [Backups](backups.md).

## Updates

Nothing updates automatically. Powder never pulls a new version of itself. Watch the repository releases and GitHub Security Advisories, and upgrade as described in [Upgrading](upgrading.md).

## Logs

Deploy output is stored and shown in the dashboard. It contains whatever your build and start commands print, which can include environment banners, paths and error messages with secrets in them. Treat deploy logs as sensitive, and keep your builds from printing secrets.

## Telemetry and outbound calls

Powder has no required phone-home. The one outbound call on by default is the daily release check; every other call that leaves the server is a feature you use or configure, or part of installing and building.

- **Release check (on by default):** once a day, one request to the public GitHub releases API with a `powder/<version>` User-Agent and nothing else. Turn it off with `POWDER_UPDATE_CHECK=off`.
- **GitHub API:** login, webhook and deploy key setup, and CI status, for the repositories you connect. Each deploy of a connected repository also creates a GitHub deployment through the Deployments API, with the deploy's page on your dashboard (`BETTER_AUTH_URL`) as its `log_url`.
- **Docker install:** only when you accept the Docker install in `bin/install.sh` (or run `bin/server-bootstrap.sh --apply` on a server without Docker): packages from Docker's apt repository at download.docker.com (Debian and Ubuntu), whose key is trusted only when its fingerprint is `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`. Docker's convenience script from get.docker.com runs only with `--docker-script`; its sha256 is printed, and `POWDER_GET_DOCKER_SHA256` pins it.
- **Docker Hub:** image pulls for `node`, `pgvector/pgvector`, `traefik`, `postgres` and `redis`. Powder's own services pin them by digest; Dockerfiles powder generates for your apps pin exact tags.
- **npm registry:** package installs during image builds, for powder's own image and for your apps.
- **Let's Encrypt:** the Traefik that `bin/server-bootstrap.sh` starts requests certificates over ACME for the domains you route to it.
- **PostHog analytics:** only if `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` are set when the image is built. The dashboard sends events through its own `/ingest` path and identifies the signed-in user by id, email and name. Session recording is off; exception capture is on.
- **Ops endpoint reporting:** only when the `POWDER_HQ_*` variables are set (`POWDER_HQ_INGEST_TOKEN` plus the matching URL). Powder then posts deploy results, warning cards and cron results to the endpoints you configured, fail-silent.
- **Anthropic:** only with `ANTHROPIC_API_KEY`, and only when you click "diagnose with AI" on a failed CI run. That sends the last 6000 characters of the GitHub Actions job log of that run, after redacting URLs with credentials, `*KEY`/`*TOKEN`/`*SECRET`/`*PASSWORD` assignments, bearer tokens and common token prefixes. The log is wrapped as untrusted data, the reply is coerced to capped strings and shown labelled "model-generated, verify before running". Calls time out after 30 seconds and are capped per day by `POWDER_LLM_DAILY_MAX` (default 50).
- **Notification webhook:** only with `POWDER_NOTIFY_WEBHOOK_URL`. Powder POSTs JSON `{event, app, server, message, url, at}` for `deploy_failed`, `app_down`, `app_up` and `cron_failed` (the message carries the first 500 characters of the deploy error). Discord and Slack incoming webhooks work as the target.
- **Alerts:** `POWDER_NOTIFY_WEBHOOK_URL` (always on) and the notification targets at `/settings/notifications`: more webhooks, and email through your own SMTP server (`POWDER_SMTP_URL`, `POWDER_MAIL_FROM`). With none of them set, deploy failures and app-down events are visible only in the dashboard.
- **Your own S3-compatible storage:** backups upload there when `BACKUP_S3_*` is set.
- **Your own apps:** uptime probes and HTTP crons request the URLs you configure, plus the SSH connections to your servers.
