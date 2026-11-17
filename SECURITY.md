# Security policy

## Reporting a vulnerability

Report it privately through GitHub: on the repository's Security tab, choose "Report a vulnerability" (GitHub private vulnerability reporting). If you cannot use GitHub, email hello@powder.sh with the subject `security`. Do not open a public issue or pull request for a vulnerability.

Include what you found, the version or commit, and steps to reproduce. We acknowledge a report within 3 business days.

## Supported versions

Fixes are made for the latest release only. If you run an older version, update before reporting, or tell us which commit you tested.

## Advisories

Confirmed vulnerabilities are published as GitHub Security Advisories on [powder-sh/powder](https://github.com/powder-sh/powder/security/advisories).

Powder is self-hosted and does not update itself. Every instance owner has to upgrade their own install: see [Upgrading powder](apps/web/content/docs/self-hosting.md#upgrading-powder) in the self-hosting docs. Watch the repository releases and advisories.

## Known advisories

`pnpm audit --prod` reports three moderate advisories in `stream-json` 1.x ([GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x), [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x), [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc)), a dependency of `minio` (the S3 client powder uses for backups). The fixed `stream-json` releases are a new major version that `minio` cannot load, and no `minio` release uses them yet. They are not reachable with untrusted input: `minio` uses only the line-by-line JSON parser of `stream-json` (one `JSON.parse` per line), not the filters, the JSONC parser or the assembler the advisories cover, and only to listen for bucket notifications, which powder does not do. The only responses it would parse come from the S3 endpoint the operator configures.

## Scope

In scope: the code in this repository (the dashboard and API, the worker, the database schema, the scripts in `bin/`, and the helpers in `infra/` that run as root on the servers powder deploys to: `powder-migrate`, `powder-image-prune.sh` and `powder-resource-guard.sh`).

Out of scope:

- The servers you run powder on or deploy to, and their configuration.
- Third-party apps you deploy with powder, and the repositories you connect.
- GitHub itself.

How the responsibility is split is described in the [security model](apps/web/content/docs/security-model.md).
