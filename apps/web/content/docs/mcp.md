---
title: MCP for coding agents
order: 8
description: Connect Claude Code or any MCP client to powder over HTTP with an API token, the tools it gets and the scopes each one needs.
---

Powder is a remote MCP server. A coding agent connected to it can list your apps, read deploy logs, redeploy and manage env vars without SSH. It reaches powder's own API only: no tool runs a command on a server.

## Connect

The endpoint is `<your powder dashboard URL>/api/mcp`. It answers on the dashboard host only; when the public site runs on its own host (`POWDER_SITE_HOST`), the site host returns 404 for it.

1. In the dashboard open **settings, api tokens**. Pick an access level (see Scopes below) and create a token. It is shown once.
2. The same page shows the URL and ready-made configs with the new token filled in.

Claude Code:

```sh
claude mcp add --transport http powder <your powder dashboard URL>/api/mcp --header "Authorization: Bearer <token>"
```

Other clients that take a JSON config:

```json
{
  "mcpServers": {
    "powder": {
      "type": "http",
      "url": "<your powder dashboard URL>/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Tools

| Tool | What it does | Runs (and needs the scope of) |
|---|---|---|
| `list_apps` | Every app: id, container, server, domain, last deploy, uptime | `GET /api/projects` |
| `get_app` | One app: container state, ports, hostnames, domains, recent deploys, links | `GET /api/projects/<id>/context` and `GET /api/projects/<id>/domains` |
| `list_deploys` | The latest deploys of an app with status, commit and failure summary | `GET /api/servers/<server>/containers/<name>/deploys` |
| `get_deploy_log` | The last lines of one deploy's log (`tail`, default 200, max 2000) | `GET /api/deploys/<deploy id>` |
| `deploy_app` | Redeploy from the head of the app's branch, like the redeploy button | `POST /api/projects/<id>/redeploy` |
| `list_env_keys` | Env var names per scope with a length-only preview, never values | `GET /api/projects/<id>/env` |
| `set_env_var` | Create or overwrite one env var | `PUT /api/projects/<id>/env` |
| `delete_env_var` | Delete one env var | `DELETE /api/projects/<id>/env/<key>` |
| `list_servers` | Servers: id, name, host, status, proxy, TLS mode, base domain | `GET /api/servers/list` |

Tools that take `app` accept the project id from `list_apps`, or the container name when only one server has a container with that name.

Each tool calls the same API route the dashboard uses for that action, with that route's checks. So `deploy_app` is refused while a deploy of the app is in flight, and `set_env_var` and `delete_env_var` validate the key and write the same audit and version history rows as the env page. A changed env var reaches the running app on its next deploy: call `deploy_app` after.

`deploy_app` always builds the head of the configured branch. To ship a particular commit, push it to that branch.

Deploy logs pass through powder's secret masking before they reach the agent: credentials in URLs, `KEY=`/`TOKEN=`/`PASSWORD=`-style assignments, bearer tokens and common token formats become `[redacted]`. Masking is best effort; a log that prints a secret in another shape can still show it.

`deploy_app`, `set_env_var` and `delete_env_var` are marked `destructiveHint` and the other tools `readOnlyHint`, so clients that ask before risky calls can do so.

## Scopes

Authentication is a bearer API token. A session cookie is not accepted on `/api/mcp`.

A token with no scopes (full access) can use every tool. A scoped token needs `POST /api/mcp` to connect at all, and then, per tool, the scope of the route in the table above. Scopes match the real path, so a token can also be limited to one app, for example `POST /api/projects/rep_abc/redeploy`.

The tokens page offers two presets:

- **coding agent, read-only:** `POST /api/mcp` plus the `GET` routes of `list_apps`, `get_app`, `list_deploys`, `get_deploy_log`, `list_env_keys` and `list_servers`.
- **coding agent, read and write:** the read-only set plus `POST /api/projects/*/redeploy`, `PUT /api/projects/*/env` and `DELETE /api/projects/*/env/*`.

Some admin actions need a browser session and answer 403 to every API token, whatever its scopes: connecting, importing or cloning a repo, adding, applying, verifying or deleting a domain, revealing secrets (`?reveal=1`), backup downloads and restores, creating apps, managing tokens, users, settings and servers. None of them is an MCP tool.

A tool outside the token's scopes answers with an error naming the missing scope. Revoking or expiring a token cuts the agent off on its next call.

## Limits and errors

- One JSON-RPC message per `POST`, answered with JSON. There is no SSE stream and no session, so `GET` and `DELETE` return 405. Batches are refused.
- Requests are rate limited per client IP and per token (HTTP 429 with `Retry-After`), and bodies are capped at 256 KB.
- Requests that carry an `Origin` header must come from the dashboard origin.
- Errors are short messages such as `powder answered 404: project not found`. Internal errors are logged on the server and the agent sees only that the tool failed.
