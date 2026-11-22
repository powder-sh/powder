---
title: Troubleshooting
order: 8.5
description: The failure classes powder names on a failed deploy, what each means and what to do, plus install problems.
---

A deploy that fails before the swap (preflight, build, migration, swap-check) leaves the old container serving. A deploy whose health check fails after the swap rolls back automatically to the image of the last successful deploy when one is tagged; with no earlier tagged image (for example the app's first deploy) the new container stays in place and the log says `[rollback] no previous tagged deploy available` ([Rollback](deploys.md#rollback)). The deploy page shows a one-line summary of the cause; the full log is below it.

## Failed deploys

A failed deploy carries a one-line summary: on the deploy page, in the copied error block, in the GitHub commit status and in the event sent to an ops endpoint. powder reads it from the failed step's own part of the log, by what that step does: a build failure is explained only by the build's output (the Dockerfile `RUN` step that failed and its own lines, such as a TypeScript error), a test gate failure only by the test output (the runner's `N failed` line and the first failing file, or the gate script's last failure line), a failure after the swap only by the containers. A line from another step, or one a test prints on purpose (a simulated `ECONNREFUSED`), never names the cause. When powder itself stopped the step (a `preflight:` check, a guard's `refusing` line, `[build-cache] refusing`, `[migrate] ... cannot ...`, `swap-check: FAILED (...)`, the `[deadline]` line), the summary is that line. Only when the step's part of the log holds nothing readable does it say `failed during: <step>`.

| Summary | Cause and fix |
|---|---|
| ... (the Dockerfile step RUN ...) | The build's `RUN` step exited non-zero; the text before the brackets is its own failure lines (a package manager's "command failed" trailer is skipped for the line above it). The cause comes first so a cut summary keeps it. Fix the code or the Dockerfile. |
| test-failure: ... | The tests in `.powder/test.sh` (or a test `RUN` step) failed: the first failing file (or the first `FAIL` line or failing `not ok` test, and how many more) and the runner's count; or an unhandled error failed the run, with the file it came from. |
| the test gate failed: ... | The test gate failed on something other than a test runner: a located type error, or the gate script's own last word just above the gate's `FAILED` line (its labelled failure line, or a shell error). Output from the middle of the test run never counts. |
| container-oom: ... killed | The gate's process was killed (exit 137, or a bare `Killed` line from the shell just before the gate ended), usually by the memory limit or the kernel OOM killer. |
| `heap-oom:` / `container-oom:` | The step ran out of memory; see the test gate in [Deploys](deploys.md). These two prefixes are stable. |
| disk full on the server | `no space left on device`. Free space; make sure `powder-image-prune` and its hourly cron are installed ("check server", then "fix missing pieces"; [Per-server helpers](self-hosting.md#per-server-helpers)). |
| build ran out of memory (OOM-killed) | The build or the app was killed. Add memory or swap, or build on a dedicated builder. |
| git auth failed | The deploy key is missing or not authorized on the repository (or the remote URL is wrong): check the repository's Settings, Deploy keys on GitHub. |
| git pull blocked by uncommitted local changes | Someone edited the checkout on the server. The checkout is disposable: discard the changes. |
| git is in detached HEAD on the server | Reattach the checkout to the deploy branch. |
| docker daemon is down on the server | Start Docker (`systemctl start docker`). |
| container name conflict | A stale container holds the name: `docker rm -f <name>`. |
| lockfile rejected by the package manager in the image | The lockfile was written by a newer npm/pnpm. Pin the same version in the Dockerfile, or regenerate the lock with the image's version. |
| image not found in registry / registry auth denied | The image the compose file pulls does not exist, or the registry login is missing or expired. |
| migration collision | A migration re-creates an object that exists: it was applied by hand. Record it as applied instead of re-running it. |
| connection refused | A dependency (database, sibling service) was not reachable from the new container. |
| container failed to start / crash-looped after recreate | The new container exits. Read its log on the deploy page. |
| compose service not found | The compose service name differs from the app's container name. |
| SSH timed out | The server is unreachable or overloaded. |
| post-deploy health check failed | The app did not answer its health URL after the swap. Check the `[rollback]` lines in the log: when the automatic rollback ran and its health check passed, the previous version serves again. Otherwise roll back from the dashboard to an earlier successful deploy, or fix the app or its health URL (the app's Settings tab) and deploy again. |
| auth check returned 5xx (better-auth schema mismatch?) | The new image's auth tables are behind: run its migration. See [Deploys](deploys.md). |
| test file inside pages/app tree | Next would build the file as a route: move tests out of `pages/` or `app/`. |
| swap-check: FAILED | The candidate did not pass its health check; its log is in the deploy log. See [Deploys](deploys.md). |

A `[compose-guard]` line names the compose rule a deploy broke; see [What your repo needs](app-requirements.md#your-own-compose-file).

## Install and login

- **`bin/install.sh` stops at a missing prerequisite.** Install what it names. Docker and Traefik in one step:

  ```bash
  sudo bin/server-bootstrap.sh --apply --proxy traefik
  ```
- **powder does not get healthy.** Read its log:

  ```bash
  docker logs powder
  ```

  A refused config (short secret, `CHANGE_ME` left in the env file) is named there; a failed migration names the file.
- **The dashboard host does not answer.** Check the DNS record, that ports 80 and 443 are open, and `docker ps --filter name=traefik`. Behind your own proxy, forward to `127.0.0.1:3050` and set `X-Real-IP` ([Self-hosting](self-hosting.md#login-protection)).
- **The browser warns about the certificate (Traefik's default certificate).** DNS did not point at the server when Traefik asked Let's Encrypt for it, and Traefik does not retry at once. Check that the host resolves to the server and port 80 is open, then run `docker restart traefik` on that server. See [Certificates](domains-and-proxy.md#certificates).
- **`github 401` errors (importing repos, adding deploy keys or webhooks).** GitHub rejected the stored token: it was revoked or expired. Integrations shows "token rejected by GitHub"; reconnect there (or, for a personal access token, paste a new one under advanced).
- **GitHub login fails with a redirect error.** The OAuth app's callback must be exactly `<BETTER_AUTH_URL>/api/auth/callback/github`.
- **The first login is refused.** Enter the setup token at `/setup` first, on the `BETTER_AUTH_URL` host, in the same browser. A restart prints a new token.
- **Locked out after a database reset or restore.** The first admin is kept in the database until `POWDER_ADMIN_USER_IDS` is set; set it with `sudo bin/install.sh --set-admin <id>`.
- **A server stays red after "fix missing pieces".** The fix only adds what is missing and never touches an existing proxy; the check names what is left.
