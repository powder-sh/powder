# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# powder dashboard (apps/web)
# multi-stage build for the next.js dashboard
# produces a slim runtime image using next standalone output

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS base
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /app

# ── deps ────────────────────────────────────────────────────────────────────
# pnpm store cache mount survives across builds via BuildKit. When package.json
# changes invalidate this layer's cache, install still pulls from the local
# store instead of re-downloading every tarball — minutes saved on most pushes.
#
# Cache ids: every app build on this daemon shares BuildKit's cache
# store, and a mount without an id is keyed by its target path, which any repo
# (or an ONBUILD trigger of a base image) could name. powder's mounts therefore
# carry an explicit id with POWDER_BUILD_CACHE_ID, a random per-server value that
# bin/self-deploy.sh and the dashboard self-deploy keep in
# /opt/apps/.powder-build-cache-id. App builds never produce this shape (powder
# rewrites every app cache id to <app>-<20 hex>, apps/web/src/lib/build-cache.ts).
# Empty (a plain `docker compose build`): the id is still distinct from every
# app's, just not secret.
FROM base AS deps
ARG POWDER_BUILD_CACHE_ID=""
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
RUN --mount=type=cache,id=powder-self-pnpm-${POWDER_BUILD_CACHE_ID},target=/root/.local/share/pnpm/store/v3 \
    pnpm install --frozen-lockfile --filter @powder/web... --filter @powder/db...

# ── build ──────────────────────────────────────────────────────────────────
# Next.js .next/cache mount keeps the incremental compile cache across builds.
# Most rebuilds reuse 80%+ of compiled output even when source changes.
FROM base AS builder
ARG POWDER_BUILD_CACHE_ID=""
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY apps/web ./apps/web
COPY packages/db ./packages/db
COPY tsconfig.json package.json pnpm-lock.yaml pnpm-workspace.yaml ./
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST=""
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_POSTHOG_UI_HOST=""
ENV NEXT_PUBLIC_POSTHOG_UI_HOST=$NEXT_PUBLIC_POSTHOG_UI_HOST
RUN --mount=type=cache,id=powder-self-next-${POWDER_BUILD_CACHE_ID},target=/app/apps/web/.next/cache \
    pnpm -F @powder/web build

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS runner
WORKDIR /app

# openssh-client gives us ssh-keygen + libcrypto for ssh2 native; not strictly
# required (ssh2 has pure-js fallback) but nice to have for diagnostics.
# postgresql-client: the entrypoint applies pending migrations with psql.
# OS_PATCH_WEEK (ISO week, e.g. 2026-W47, passed by the self-deploy paths) is part
# of this layer's cache key: the base image is pinned by digest, so without it
# BuildKit reuses the first `apt-get upgrade` forever and Debian security fixes
# never land. A new week re-runs the upgrade once; builds within a week stay cached.
ARG OS_PATCH_WEEK=""
RUN echo "os patch week: ${OS_PATCH_WEEK:-unset}" && apt-get update -qq && apt-get upgrade -y && apt-get install -y --no-install-recommends openssh-client postgresql-client \
	&& rm -rf /var/lib/apt/lists/*

# No package manager at runtime: the server runs `node apps/web/server.js` and the
# entrypoint only needs bash + psql. npm, npx, corepack and yarn ship in the node base
# image with their own bundled dependencies (tar, glob, minimatch, sigstore, pacote,
# ...), which were most of the image scanner's HIGH findings.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# next standalone output bundles only what's needed
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Schema on boot (docker/powder-entrypoint.sh): the committed migration SQL and
# the one rules file, bin/lib-migrations.sh, shared with bin/self-deploy.sh.
COPY packages/db/drizzle/*.sql ./migrations/
COPY bin/lib-migrations.sh ./bin/lib-migrations.sh
COPY docker/powder-entrypoint.sh ./bin/powder-entrypoint.sh
# Per-server helpers "fix missing pieces" installs on app servers
# (lib/server-helpers.ts reads them from this fixed path only).
COPY infra/powder-migrate infra/powder-image-prune.sh ./helpers/

EXPOSE 3000
ENTRYPOINT ["/bin/bash", "/app/bin/powder-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]

# ── worker runtime ───────────────────────────────────────────────────────────
# The deploy worker (apps/web/src/worker.ts) runs raw TS via tsx. The Next
# standalone bundle only ships the web server entrypoint, not arbitrary scripts,
# so the worker needs the full source + node_modules instead. Heavier than the
# web image, but it's a single internal replica with no inbound traffic — fine.
# It orchestrates builds over SSH on the TARGET servers (it doesn't build images
# locally), so it stays light on CPU/RAM despite shipping the toolchain.
# Starts from the plain node image, not `base`: the worker runs node + tsx and needs
# no package manager (pnpm, npm, npx, corepack and yarn and their bundled
# dependencies were the scanner's HIGH findings in this image).
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS runner-worker
WORKDIR /app

# openssh-client: same rationale as the web runner (ssh2 native libcrypto +
# diagnostics). The worker SSHes every managed server to drive deploys.
# OS_PATCH_WEEK: same weekly refresh of the upgrade layer as the web runner.
ARG OS_PATCH_WEEK=""
RUN echo "os patch week: ${OS_PATCH_WEEK:-unset}" && apt-get update -qq && apt-get upgrade -y && apt-get install -y --no-install-recommends openssh-client \
	&& rm -rf /var/lib/apt/lists/* \
	&& rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Full workspace from the builder: node_modules (incl. tsx + workspace symlinks),
# app source, and the two workspace packages the worker imports at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web ./apps/web
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/tsconfig.json ./

# Same as `pnpm -F @powder/web run worker` (tsx src/worker.ts, cwd apps/web), without
# pnpm: node loads tsx in-process, so node is PID 1 and gets SIGTERM directly (the
# worker drains in-flight deploys on SIGTERM, see worker.ts).
WORKDIR /app/apps/web
CMD ["node", "--import", "tsx", "src/worker.ts"]
