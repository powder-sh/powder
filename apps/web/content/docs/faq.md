---
title: FAQ
order: 9
description: What you need to run powder, how the single-tenant model works, the licence and where to get help.
---

## What do I need?

One Linux server with Docker for powder itself, one or more servers to deploy to with root SSH (they can be the same server), a GitHub repository with a Dockerfile per app, a GitHub OAuth app for sign-in, and a public hostname for the dashboard with DNS you control. See the [Quickstart](quickstart.md).

## Is there a hosted version or an account with you?

No. Powder is single-tenant. You install it on your own servers, your data stays there, and there is no account with us. The first GitHub login on an empty install (with the one-time setup token from the server log, entered at `/setup`) becomes the admin. Everyone who uses it is an admin: an admin creates more users at `/admin/users` and adds their ids to `POWDER_ADMIN_USER_IDS` (`sudo bin/install.sh --set-admin <id>`). A signed-in user whose id is not listed gets a 403 `single_tenant`.

## Which licence?

AGPL-3.0-or-later. The licence text is in the repository.

## Does powder need a registry or a CI service?

No. It builds the image on your server on every push. Rollback uses the previous images kept on that server.

## What happens if a build or a check fails?

The old container keeps serving. See [How a deploy runs](deploys.md).

## Are backups restored automatically?

No. An admin restores a backup from the app's backups tab into a new database, then points the app's `DATABASE_URL` at it. See [Backups](backups.md).

## Releases

Releases are tagged `vX.Y.Z` on [GitHub](https://github.com/powder-sh/powder/releases), with notes in `CHANGELOG.md`. To upgrade a tag checkout (a detached HEAD, where `git pull` fails with "You are not currently on a branch"), run this on the server, or `bin/self-deploy.sh` from a workstation:

```bash
git fetch --tags && git checkout vX.Y.Z
sudo bin/install.sh
```
 See [Upgrading](upgrading.md).

## How do I get help?

Email hello@powder.sh, or open an issue on [GitHub](https://github.com/powder-sh/powder).
