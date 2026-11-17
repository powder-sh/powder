---
title: Backups
order: 6
description: Encrypted Postgres backups to S3-compatible storage with retention, download, restore into a new database, and verify.
---

Powder backs up each app's Postgres database to S3-compatible object storage. From the app's backups tab you can download a backup, restore it into a new database next to the live one, or verify it. Powder never restores over the live database.

## Configure the target

Set these in `powder.env`:

- `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`
- `BACKUP_S3_REGION` (optional, defaults to `us-east-1`)
- `POWDER_BACKUP_KEY`: the passphrase used to encrypt every dump. Keep a copy elsewhere. Without it a backup cannot be opened.

A server can override the endpoint, bucket and keys with its own settings. The passphrase is always the global one, so a single key opens every backup.

For each app, set which database to dump. By default powder dumps database `app` as user `app` from the container `<container>-db`, which is the shape of an app with its own `db` service in its compose file. For any other Postgres, an admin sets it in the database form on the app's backups tab (or `PATCH /api/projects/<id>` from an admin browser session, with `hasPostgres`, `backupDbContainer`, `backupDbHost`, `backupDbName`, `backupDbUser` and `backupDbPassword`; empty or `null` goes back to the default):

- **container**: a Postgres container on the app's server, for example a shared one that holds several databases. Powder runs `pg_dump` in it with `docker exec`.
- **host**: Postgres outside Docker, as `host` or `host:port` the app server reaches (a throwaway `pg_dump` container on the host network connects to it). It needs the password, excludes a container, and restore is not available from the dashboard.
- **database**, **user** and **password**: what `pg_dump` connects with. The password is stored encrypted with `POWDER_ENCRYPTION_KEY`, like env values, and the dashboard and API only say whether one is set.

An app without a database of its own shows the same form with "turn on backups".

## What a backup does

Powder runs the backup on the app server and the S3 credentials stay with powder: the server only receives upload links that expire after a few hours and cover one object.

1. `pg_dump` the database, compress with gzip and encrypt with AES-256-CBC (PBKDF2) using `openssl`.
2. Verify the file before uploading: decrypt, decompress, and require the closing `PostgreSQL database dump complete` line from `pg_dump`.
3. Record a SHA-256 checksum of the encrypted file.
4. Upload in chunks (multipart) to `<container>/<timestamp>.sql.gz.enc` in the bucket.

Backups run on a schedule: the scheduler checks every hour and takes a new backup for an app when its last good one is more than 23 hours old. If `POWDER_HQ_INGEST_TOKEN` and `POWDER_HQ_CRON_URL` are set, powder posts an alert to that endpoint when an app has had no good backup for 36 hours; otherwise nothing is sent, so check the backups list in the dashboard.

## Retention

Powder keeps the newest `BACKUP_KEEP_PER_APP` scheduled backups per app (default 7) and, separately, the newest `BACKUP_KEEP_MANUAL_PER_APP` manual ones (default 3). Pruning is cautious: if the newest backup is much smaller than the ones before it, powder keeps older ones too instead of deleting the last real backup.

Pruning runs after a backup succeeds and counts only backups of the same kind. A manual backup (the dashboard button, or `POST /api/projects/<id>/backups` with an API token) prunes older manual backups and never pushes scheduled ones out; a scheduled backup never pushes manual ones out. One backup runs per app at a time, an API token can trigger 2 backups per app per 10 minutes, and every caller except an admin in the browser can trigger at most 12 manual backups per app per 24 hours.

## Get a backup back (dashboard)

On the app's backups tab, each successful backup has three actions. They are admin only and each one shows up on `/activity` with who did it.

- **Download** gives a link that works for 15 minutes and the exact commands to check, decrypt and load the file. The dump is plain SQL, so you load it with `psql`, not `pg_restore`.
- **Restore** creates a new database named `<db>_restore_<yyyymmdd_hhmm>` (UTC) in the app's database container and loads the backup into it. It refuses if that database already exists, and the app keeps using the live database. The log shows while it runs. When it is done the tab shows the app's `DATABASE_URL` with the new database name. To switch, set it on the env tab and redeploy; to go back, roll the env var back and redeploy. **Drop restore database** removes it again; it only accepts `_restore_` names, never the database `DATABASE_URL` points at, and Postgres refuses while anything is connected.
- **Verify** restores into a throwaway database, counts its tables, drops it, and records the result.

Restore needs the database in a Docker container. For an app on host Postgres, download the backup and use the manual steps below.

## Restore (manual)

You need the bucket credentials, the passphrase, and shell access to the server running the database.

1. Write the passphrase to a file, for example `/root/backup.key`, with mode 0600.
2. Download, decrypt, decompress and load it into the app database:

   ```bash
   aws s3 cp s3://<bucket>/<container>/<timestamp>.sql.gz.enc - \
     | openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/root/backup.key \
     | gunzip \
     | docker exec -i <container>-db psql -U app app
   ```

Use `--endpoint-url <endpoint>` with `aws s3 cp` if your store is not AWS. Load into an empty database, or into a fresh one first to check the dump. Delete the key file when you are done.
