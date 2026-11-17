---
title: Domains and proxy
order: 4
description: Routing with Traefik per server (the default) or nginx, TLS modes, the base domain, custom domains, redirects and a note on Cloudflare.
---

## Two routing modes per server

Each server has two settings, `proxy` and `tls_mode`. Change them on the server's page in the dashboard (open a server from the Servers page). New servers start on `traefik`.

- **`proxy = 'traefik'`** (the default): apps are routed by Traefik labels that powder keeps in its own generated `docker-compose.powder.yml` under `/var/lib/powder/compose/` (your file is never edited). This turns on custom domains, traffic stats (read from the Traefik access log), atomic rollback, snapshots, label sync on every deploy, and www and path redirects.
- **`proxy = 'nginx'`** and **`proxy = 'nginx-container'`**: a host nginx (or nginx in a container) plus a host port, with redirects as managed nginx server blocks. Apps deploy and roll back as usual, but there are no custom domains, previews, snapshots or traffic stats, and a rollback recreates the container instead of switching traffic atomically. Pick these for a server whose nginx already serves other sites.

`tls_mode` is only read when `proxy = 'traefik'`:

- `acme` (default): Traefik's `le` resolver gets each certificate from Let's Encrypt over HTTP-01. It asks when a router with that host appears (a deploy, a new domain), so DNS must already point at the server; see [Certificates](#certificates).
- `origin-cert`: the router uses TLS without a resolver, for servers that serve a Cloudflare origin certificate from Traefik's default store.

### Health path for Traefik

Traefik's service health check probes the path of the app's health URL, with scheme, host and query dropped, or `/` when unset. That path must answer 2xx or 3xx without a Host header, otherwise Traefik marks the service unhealthy and serves 503. Set the health URL to a path that does, for example `/api/health`.

## Base domain

Each app gets a default host `<app>.<base_domain>`, and each preview gets `pv-<app>-<branch>.<base_domain>`. Set the base domain on the server's page: a bare lowercase hostname such as `apps.example.com`, without a scheme or wildcard.

Point a wildcard DNS record `*.apps.example.com` at the server's public IP. On `acme`, each host gets its own certificate when its router appears. On `origin-cert`, the default-store certificate must cover `*.apps.example.com`. "check DNS" on the server's page resolves a random name under the base domain and compares it with the server's ingress IP. Behind a Cloudflare proxy it shows a mismatch, because the record answers with Cloudflare's addresses.

With no base domain, an app has no default host: it gets no router label until you attach a custom domain, uptime checks need a health URL or a live custom domain, HTTP crons need a live custom domain, snapshots are unavailable, and the webhook ignores branch pushes (previews need the base domain).

## Custom domains

On a project's page choose domains, then add a domain, and enter the hostname. Set the DNS record at your DNS provider and click verify.

- **A record** pointing at the server's public IP (the server's ingress IP from its page, else the server's host when it is an IP).
- **CNAME** to `<app>.<base_domain>`, preferred for subdomains.

On success powder adds the host to the app's Traefik router rule and recreates the container, and Traefik requests the certificate for it ([Certificates](#certificates)). The label writer emits one `Host(...) || Host(...)` rule per app; wildcards and other non-Host rules belong in the file provider.

## Certificates

On `acme`, Traefik requests a certificate from Let's Encrypt (HTTP-01 on port 80) when a router with that host appears: when the app is deployed, a domain is verified or a preview starts. Let's Encrypt must reach the host on the server at that moment. If DNS did not point at the server yet, the request fails and the browser shows Traefik's default certificate until Traefik retries, which is not immediate. Once the record resolves, force a new attempt on that server:

```bash
docker restart traefik
```

Each host has its own certificate, previews included, and Let's Encrypt [limits how many certificates a domain gets per week](https://letsencrypt.org/docs/rate-limits/).

## Redirects

- **nginx servers:** www-to-apex and apex-to-www redirects are managed from the Domains page as nginx server blocks.
- A www-to-apex redirect also answers on `www.<domain>` (apex-to-www on `<domain>`). That other host must be a verified domain of the same app, or a hostname no other app has a domain entry for; otherwise the redirect is refused.
- **Traefik servers:** redirects are written as a Traefik file-provider fragment at `/opt/infra/traefik/dynamic/redirects-<app>.yml`. Before each write, powder checks with `docker inspect traefik` that the Traefik container is named `traefik` and runs the file provider on a directory mounted from `/opt/infra/traefik/dynamic` with watch on (`--providers.file.directory=...` and `--providers.file.watch=true`). If not, the apply fails with a message naming the missing setting. A Traefik with only the Docker provider cannot take www or path redirects until you add the file provider.

## Cloudflare

Cloudflare is optional. If a domain is proxied through Cloudflare, create the wildcard record as proxied and use `tls_mode = 'origin-cert'` with a Cloudflare origin certificate. HTTP-01 issuance needs the request to reach the server directly, so a proxied host cannot rely on `acme`. DNS-only records work with either mode.
