---
title: Quickstart
order: 0
description: Install powder on one Ubuntu server with bin/install.sh, sign in as the admin, add a server and deploy an app with git push.
---

You need one Linux server with root and a public hostname for the dashboard (GitHub must reach it for login and push webhooks). `bin/install.sh` offers to install Docker when the server has none; an existing Docker needs `docker compose` 2.24 or newer.

- **Distro.** Ubuntu is the tested distro, Debian also works: the Docker install uses Docker's apt repository with the key's fingerprint checked. On another distro install Docker Engine and the compose plugin yourself first (or pass `--docker-script` to use Docker's get.docker.com script), and `git` and `flock` (util-linux) from the distro's packages.
- **Memory.** 2 GB or more: powder builds its own image on this server ([Requirements](self-hosting.md#requirements) has the swap commands for a smaller one).
- **IPv4.** The server needs outbound IPv4: GitHub is reached over IPv4 only.
- **Ports.** Inbound 80 and 443 on the dashboard server and on every server that serves apps, and SSH (22) on every app server from the dashboard server. Open them in the cloud provider's firewall or security group as well as in `ufw`.
- **One server is enough.** The dashboard's server can also run the apps: see step 6.

1. **DNS.** Point an A record for the dashboard host, e.g. `deploy.example.com`, at the server, before you install: Traefik asks Let's Encrypt for the dashboard's certificate as soon as powder starts. `bin/install.sh` warns when the host does not resolve to the server.
2. **GitHub OAuth app.** On github.com/settings/developers choose "New OAuth App":
   - Homepage URL: `https://deploy.example.com`
   - Authorization callback URL: `https://deploy.example.com/api/auth/callback/github`

   Generate a client secret and keep it at hand: `bin/install.sh` asks for it and does not echo it.
3. **Install.** On the server:

   ```bash
   sudo git clone --branch v0.10.0 https://github.com/powder-sh/powder /opt/apps/powder/src
   cd /opt/apps/powder/src
   sudo bin/install.sh
   ```

   The tag is the release these docs belong to. Run without flags, `bin/install.sh` asks for every value. For a run without prompts, pass the host and the client id:

   ```bash
   sudo bin/install.sh --host deploy.example.com --github-client-id <client id>
   ```

   Put the secret in a file (`chmod 600`) for `--github-client-secret-file <file>` (delete it afterwards) or export `GITHUB_CLIENT_SECRET`, and add `--yes` on a server without Docker so it installs Docker without asking. `--dry-run` prints the plan and changes nothing; all options: [Install script options](self-hosting.md#install-script-options). It creates `/opt/apps/powder.env` (mode 0600, new secrets) and the SSH key `/root/.ssh/id_ed25519`, runs the server bootstrap on the server (the `web` and `internal` networks, the helpers `powder-migrate` and `powder-image-prune` with the prune's hourly cron, and Traefik if the server has no proxy), builds and starts powder, and creates the database schema on the first start. Re-running it is safe.
4. **First login.** The script prints the setup token. To read it again:

   ```bash
   docker logs powder 2>&1 | grep 'setup token'
   ```

   Open `https://deploy.example.com/setup`, enter it, then continue with GitHub. That login is the admin.
5. **Keep the admin.** The log prints `[first-run] ... POWDER_ADMIN_USER_IDS=<id>`. Pin that id:

   ```bash
   sudo bin/install.sh --set-admin <id>
   ```

6. **Add a server.** On the servers page, run the authorize command it shows on the target server (it adds powder's public key to `~/.ssh/authorized_keys`), then enter a display name, the host or IP and the SSH user. Use root: deploys run Docker, and the server check fixes nothing for another user. To run apps on the dashboard's own server, add it by its public IP (`127.0.0.1` and `localhost` are refused) after putting powder's key in its own `authorized_keys`:

   ```bash
   cat /root/.ssh/id_ed25519.pub >> /root/.ssh/authorized_keys
   ```

   Open the server and set its base domain, e.g. `apps.example.com`, then point a wildcard DNS record `*.apps.example.com` at that server's public IP. Run "check server", then "fix missing pieces": it installs Docker when it is missing, the proxy, the helpers `powder-migrate` and `powder-image-prune` and the prune's hourly cron. `git` and `flock` (util-linux) it does not install: add them with the distro's package manager.
7. **Import an app.** At `/new`, pick a GitHub repository, the server and a name. Powder adds a read-only deploy key and a push webhook. See [What your repo needs](app-requirements.md).
8. **Deploy.** `git push` to the default branch. The deploy log is on the app's page. The app answers at `https://<app>.apps.example.com`. Traefik requests its certificate when the app's router appears; if the wildcard record did not resolve yet, the browser shows Traefik's default certificate until Traefik retries (`docker restart traefik` on that server forces it). Each preview host gets its own certificate, and Let's Encrypt [limits certificates per domain and week](https://letsencrypt.org/docs/rate-limits/), so keep previews to the branches you need. To serve an app on your own domain, see [Domains and proxy](domains-and-proxy.md).

More: [Self-hosting](self-hosting.md), [Troubleshooting](troubleshooting.md), [Upgrading](upgrading.md).
