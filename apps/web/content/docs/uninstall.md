---
title: Uninstall
order: 1.7
description: Remove powder from its server, from the servers it managed and from GitHub. Deployed apps keep running.
---

Removing powder does not stop the apps it deployed: their containers, compose files and env files stay on the servers.

## On the powder server

In the checkout (`/opt/apps/powder/src`), take a last dump if you may want the data back, then stop and remove the containers. The dump below uses the defaults: the container `powder-postgres`, user `admin` and database `powder`. Use the values of `POWDER_DB_USER` and `POWDER_DB_NAME` from `/opt/apps/powder.env` when they differ, and the container `postgres` on a server in the shared-network layout:

```bash
docker exec powder-postgres pg_dump -U admin powder | gzip > /root/powder-final-$(date +%F).sql.gz
docker compose --env-file /opt/apps/powder.env down
docker image rm powder:latest powder-worker:latest
```

Then delete what the install created: `/opt/apps/powder.env` (it holds every secret), the database at `/opt/apps/powder-pgdata` (or `$POWDER_DATA_DIR/powder-pgdata`), `/opt/apps/.powder-build-cache-id` and the checkout. The Traefik container and the `web` network serve the apps too: leave them while apps run on this server.

## On each managed server

- Remove powder's line from `~/.ssh/authorized_keys` of the SSH user: after that powder's key no longer works there.
- `/var/lib/powder/compose/<app key>/docker-compose.powder.yml` holds each app's Traefik labels and loopback port bindings. To recreate an app by hand, pass it as the last `-f`, or move those settings into the app's own compose file first.
- Remove the per-server helpers if you installed them: `/usr/local/bin/powder-migrate`, `/usr/local/bin/powder-image-prune`, `/usr/local/bin/powder-resource-guard` and their files in `/etc/cron.d/`.

## On GitHub

- Delete the OAuth app at github.com/settings/developers.
- On each repository powder imported, delete the deploy key and the push webhook it added (Settings, Deploy keys and Webhooks).
- Revoke powder's access under Settings, Applications, Authorized OAuth Apps.
