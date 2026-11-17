---
title: Crons, uptime and logs
order: 7
description: HTTP and exec crons run by powder, how uptime checks pick a URL and when they alert, and where to find deploy and runtime logs.
---

## Scheduled jobs (crons)

Powder has an in-process scheduler that ticks every 60 seconds, runs the jobs that are due and records each result and its output in powder's own database. Each app's crons tab lists its jobs and their history.

There are two kinds of job:

- **HTTP** jobs call a path on the app (GET or POST) with a bearer token: by default the app's `POWDER_CRON_TOKEN`. Powder shows that token once, when it is created: add it to the app's env (the env page) and redeploy so the app can check the header. They need a live custom domain, or a base domain on the server so that the default host exists.
- **Exec** jobs run a command inside the app container with `docker exec`, as the container's user, with its env and network. The command is stored as an argument list, never run through a shell.

- Each job has its own timeout, 30 seconds unless you set another (1 second to 1 hour). A run that passes it is recorded as `timeout`.
- A job does not start while its previous run is still running; that firing is recorded as skipped.
- Stored output is capped.
- Schedules are standard 5-field cron expressions, with a timezone per job.

Jobs that already live in a server's root crontab are shown for reference. Powder does not run them, but it reads each server's cron journal every 5 minutes and records when they fired, so their runs appear in the activity feed. A host line can be imported as a managed job.

## Uptime checks

Uptime checks are opt-in per app: tick "uptime checks" on the app's Settings tab, or send `PATCH /api/projects/<id>` with `{"uptimeEnabled": true}` from a signed-in browser session (API tokens cannot change app settings). The health URL is set in the same card (`{"healthUrl": "/api/health"}`; an empty value clears it). When enabled, powder requests the app every 5 minutes with a 10 second timeout. The URL is the first of:

1. the app's health URL, if set;
2. the app's first live custom domain;
3. `https://<container>.<base_domain>/`, if the server has a base domain.

An app with none of these is skipped. A single failure does not alert: the app is marked down after 2 consecutive failures, and powder sends one notification on the up-to-down change.

Uptime checks and HTTP crons only connect to public addresses. When the URL resolves to a loopback, link-local, `0.0.0.0/8`, RFC 1918 or IPv6 unique-local address, powder does not send the request: the check counts as a failure (so the app shows as down) and the worker log says why once per app (`resolves to a loopback, link-local or private address`). Tailscale addresses (`100.64/10`, `fd7a:115c:a1e0::/48`) stay allowed for uptime checks; an HTTP cron sends the app's bearer token, so it refuses them too. Point the health URL at a public or Tailscale address, and an HTTP cron's domain at a public one.

An API token can manage HTTP crons that send the default `POWDER_CRON_TOKEN`. An exec cron, or an HTTP cron that sends another env var as its bearer, needs an admin browser session to be created, edited, imported, resumed or run now.

## Logs

- **Deploy logs.** Every deploy keeps its full output, streamed live while it runs. Open a deploy from the Deploys page. Failed deploys name the step that failed.
- **Search.** Each app's logs tab searches its deploy output and errors (at least 2 characters, filter by status, default window 30 days). Secrets are masked before matching snippets are cut, so a search that only matches inside a secret returns nothing.
- **Runtime logs.** The app's logs tab streams the live container logs (the last 200 lines, then new lines as they come), with secrets masked. It is the default view; the deploy output is next to it. On the server itself: `docker logs <container> --tail 100`.

Deploy output can include environment banners, so keep the dashboard behind HTTPS.
