---
title: Env vars and secrets
order: 5
description: How powder stores environment variables encrypted, records who changed what, rolls back single keys and delivers values to containers.
---

Powder's database is the source of truth for app environment variables. The file on the server, `/opt/apps/<name>.env`, is generated from the database at deploy time. Edit values in the dashboard at `/projects/<id>/env`, never on the server.

This applies when `POWDER_ENV_VARS_DB_MODE=true` is set in `powder.env`. With it off, deploys keep using the file on the server as is.

## Encrypted at rest

Values are encrypted with `POWDER_ENCRYPTION_KEY` (AES-256-GCM) before they are stored. The dashboard shows only the length of each value, never the plaintext or any part of it. Keep a copy of the encryption key somewhere safe: without it, stored values cannot be decrypted.

New ciphertexts are written as `v1:<iv>:<tag>:<ciphertext>` (hex). Rows in the unversioned `<iv>:<tag>:<ciphertext>` form are also read and are rewritten as `v1:` the next time the value is saved. Decryption checks that the IV is 12 bytes and the tag is 16 bytes.

Key rotation is not implemented yet. The `v1:` prefix is the hook for it: a follow-up will accept `POWDER_ENCRYPTION_KEYS` (old keys, decrypt only), write `v2:` with the new key, and ship a one-shot re-encrypt of every encrypted column. Until then, changing `POWDER_ENCRYPTION_KEY` orphans every stored secret.

## Scopes

- **production:** used by the live app on every deploy from the configured branch. Rendered to `/opt/apps/<name>.env`.
- **preview:** used by preview deploys from other branches. Rendered to `/opt/apps/<name>.preview.env`. A preview reads this file only and never the production env, so it holds only the keys you set for preview (a test API key, a separate database URL). Previews are opt-in per app: tick "deploy previews of other branches" on the app's Settings tab, or send `PATCH /api/projects/<id>` with `{"previewsEnabled": true}` from a signed-in browser session.

With previews on, anyone who can push a branch to the app's repo runs that branch's code on the app's production server, joined to the shared `web` network, with every value in `/opt/apps/<name>.preview.env`. Treat that file as readable by every person with push access: never copy production secrets (the production `DATABASE_URL`, live payment or mail keys) into the preview scope. A preview that points at the production database can read and change production data. A preview deploy never runs `powder-migrate` or the `powder.release.cmd` release command (the log says `[release] skipped: preview deploys never run the release command`), so a branch's unmerged migrations never run from a preview; the branch's own code still runs against whatever database its env names.

## Audit trail and rollback

Every write records an audit entry: who did it, from which session, and what happened (create, update, delete, rollback). Before a value is overwritten, the current one is saved as a version. Powder keeps the last 5 versions per project, key and scope and removes older ones on each write.

Rollback is per key: pick a version from the key's history and restore it. The restore saves the current value first, so you can roll back the rollback, and records a rollback entry in the audit trail. A restored value reaches the app on the next deploy.

Deploys also snapshot the env their image ran with, and a deploy rollback restores that env together with the image.

## How values reach containers

1. At deploy time powder decrypts the values and writes `/opt/apps/<name>.env` on the app server, with a header that says it is generated.
2. The compose service lists that file under `env_file:`. When the container is recreated, Docker reads it.
3. Values set under `environment:` in the compose file override the same key from the env file.

Changing a value does not change a running container. Redeploy so the container is recreated with the new file.

`NEXT_PUBLIC_*` variables in Next.js are baked into the client bundle during `next build`. Setting one in powder does not change the client code; set it as a build argument in the Dockerfile and push a commit.

## Drift guard

If someone edits the file on the server directly, powder refuses to overwrite it with a render that would delete those keys. The deploy still runs with the existing file, and the log shows a banner `env render REFUSED` listing the disk-only keys. Two ways to recover:

- Add the value to the dashboard, save, and deploy again.
- Use "backfill from server" on the env page. It imports every key found on disk that the database does not have, and leaves existing keys alone.

Deleting a key in powder does not remove it from the file on disk. Remove that line from the file by hand, then redeploy and check that no REFUSED banner appears.

## Adopting a running container

If you adopt a container that already has an env file, the env page starts empty. Use "backfill from server" once to import the existing values. From then on the dashboard is the source of truth.
