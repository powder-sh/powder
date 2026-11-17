---
title: What your repo needs
order: 1.5
description: Any repository with a Dockerfile deploys. What /new generates on the server, and which compose constructs powder refuses.
---

## A Dockerfile

Any app with a Dockerfile works: powder builds it on the server on every push, with no registry and no CI service. At `/new` you set the Dockerfile path (default `./Dockerfile` in the repo root) and the port the app listens on inside the container. A health path such as `/api/health` that answers 2xx makes the swap-check and the uptime check precise (see [Deploys](deploys.md)).

Optional, in the repository:

- `.powder/test.sh`: a test gate that runs before the swap and blocks it on a non-zero exit. See step 4 in [Deploys](deploys.md#steps-in-order).
- `*.sql` migrations: applied on every deploy by `powder-migrate` when it is installed on the server (see [Per-server helpers](self-hosting.md#per-server-helpers)).

## What /new creates

`/new` takes a GitHub repository, a server and a name (lowercase, digits, hyphens), and optionally a Postgres 16 and a Redis 7 sibling container, env vars, the Dockerfile path and the internal port. On the server it writes:

```
/opt/apps/<app>.env      # env file, rendered from powder's database on deploy
/opt/apps/<app>/         # git checkout of the repo (the build context)
├── docker-compose.yml   # runtime compose, written by powder (0600)
├── .deploy-key          # read-only deploy key (0600)
├── pgdata/              # Postgres data, when the app has a database
└── kvdata/              # Redis data, when the app has a cache
```

The compose service has both `image: <app>:latest` and `build: { context: ., dockerfile: <path> }`; `build:` is what makes deploys build on the server. The app joins `web` (Traefik) and its own db/kv networks only. Powder also adds a read-only deploy key and a push webhook to the GitHub repository.

## Your own compose file

An app adopted from a running container keeps its own compose file. Powder checks the resolved config against an allow-list before every build (full list: [SECURITY-COMPOSE.md](https://github.com/powder-sh/powder/blob/main/docs/SECURITY-COMPOSE.md)): no privileged containers, added capabilities, devices, host or other-container namespaces, `network_mode: host`, binds outside `/opt/apps/<app>`, env files, secrets or build contexts outside the app, or another app's container name, DNS alias, volume, image or Traefik route.

When the compose differs from the last successful deploy, the refusal lists what changed, one line per service and key (`services.app.network_mode: host -> (unset)`, `services.app.ports: added 127.0.0.1:3000:3000`), and never shows an environment value. A hand edit of the compose on the server counts as a change, like a repo commit. A changed compose also runs the `env_loopback` rule: a service that is not on host networking whose env tells it to connect to `127.0.0.1`, `localhost` or `[::1]` on a port it does not listen on itself (`DATABASE_URL=postgres://...@127.0.0.1:5433/app` after a switch from `network_mode: host` to bridge ports) is refused, because inside the container loopback is the container itself. To keep such a value on purpose, exempt the variable: `POWDER_COMPOSE_GUARD_EXEMPT={"<server>/<app>":{"env_loopback":["DATABASE_URL"]}}`.

These are refused in every guard mode, even with `POWDER_COMPOSE_GUARD=warn` or an exemption:

| Refused | Change |
|---|---|
| compose `include` or `extends`, the words `include` / `extends` anywhere in a compose file, a multi-line YAML node, anchors, aliases, merge keys, tags | inline the included services, write every value on one line |
| a compose `name:` other than the app name | drop `name:` or set it to the app name |
| an `env_file` / `label_file` path that is relative, built from a variable, goes through a symlink, or lies inside a writable bind | write the absolute path literally |
| a bind source, build context, Dockerfile, secret or config file that goes through a symlink, or a mount inside another writable bind | point at the real folder |
| a Dockerfile outside its build context; a `# syntax=` other than `docker/dockerfile` | keep the Dockerfile inside the context, use the stock frontend |
| an image label `traefik.*`, a label with a line break, or a `com.docker.compose.*` label other than `project`, `service`, `version` | remove those `LABEL` lines |
| a checkout whose `.git` is a symlink or a gitfile, or a `file://` / `git://` clone URL | a plain clone over https or ssh |
| other Dockerfile refusals ("More refusals of the same pass" and "Base images with `ONBUILD` triggers" in [SECURITY-COMPOSE.md](https://github.com/powder-sh/powder/blob/main/docs/SECURITY-COMPOSE.md)): an `ADD` source that is a URL, a git remote or built from a variable, `ADD --checksum` / `--keep-git-dir`; `RUN --network=` other than `default` / `none`, `RUN --security=`, `RUN --device=`; a `FROM` flag other than `--platform=$BUILDPLATFORM` / `$TARGETPLATFORM`, a `FROM` image ref that does not resolve, a base image with `ONBUILD` triggers or without a registry digest; heredoc forms other than `<<NAME`, `<<-NAME`, `<<"NAME"`, `<<'NAME'`; a Unicode space outside quotes; a `COPY --from=` stage index past the last stage | for `ADD https://...`: download it in a `RUN` step with `curl` and check its checksum, or `COPY` a vendored file from the repo; for the rest, write the line as the deploy log's refusal says, or pick a base image without triggers from a registry |

The full table is in [Upgrading](upgrading.md#refusals-no-mode-or-exemption-covers).
