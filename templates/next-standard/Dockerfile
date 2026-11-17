# Next.js Dockerfile for apps deployed with powder (see README.md).
#
# - pnpm pinned to 10.33.4 through corepack (pnpm 11 fails on ERR_PNPM_IGNORED_BUILDS)
# - Placeholder build-time env vars so module-load checks do not crash next build's
#   collect-page-data step; real values come from env_file at runtime.
# - Multi-stage build with output: 'standalone' (small final image)

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prefer-offline

FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
# Placeholders so module-load env checks don't crash next build.
# Real values come from env_file at runtime.
ENV RESEND_API_KEY=build_placeholder \
    BETTER_AUTH_SECRET=build_placeholder_min_32_chars_long_string_xx \
    BETTER_AUTH_URL=https://placeholder.local \
    DATABASE_URL=postgresql://placeholder@localhost:5432/db \
    OPENAI_API_KEY=sk-placeholder \
    ANTHROPIC_API_KEY=sk-ant-placeholder \
    NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder.placeholder \
    SUPABASE_SERVICE_ROLE_KEY=placeholder \
    STRIPE_SECRET_KEY=sk_test_placeholder \
    STRIPE_WEBHOOK_SECRET=whsec_placeholder \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_placeholder \
    GOOGLE_CLIENT_ID=placeholder \
    GOOGLE_CLIENT_SECRET=placeholder \
    NEXT_PUBLIC_SITE_URL=https://placeholder.local \
    NEXT_PUBLIC_APP_URL=https://placeholder.local \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /repo/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/.next/static ./.next/static
# Optional: public + drizzle dirs if they exist
COPY --from=builder --chown=nextjs:nodejs /repo/public* ./public/
COPY --from=builder --chown=nextjs:nodejs /repo/drizzle* ./drizzle/
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
