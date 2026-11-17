# next-standard template

A Dockerfile for a Next.js app that uses pnpm, for apps deployed with powder.
Copy `Dockerfile` into the root of your app's repository.

You do not need it to get started: when you create an app with /new and the repo has
no Dockerfile, powder commits a generated one for the detected framework. Use this
template when you want a pnpm-pinned build with placeholder build-time env vars.

## What is in it

- Three stages: `deps` (`pnpm install --frozen-lockfile`), `builder` (`pnpm build`)
  and `runner` (the Next.js standalone server, `node server.js` on port 3000, as a
  non-root user).
- pnpm pinned through corepack, so a new pnpm major cannot change the build.
- Placeholder values for env vars that some libraries check when a module loads
  (auth, database, payment and mail clients), so `next build` does not crash while
  collecting page data. They are build-only: the real values come from the app's env
  at runtime.
- `public/` and `drizzle/` are copied into the runtime image.

## How powder uses it

On `git push` to the deploy branch, powder fetches the repo into `/opt/apps/<name>`
on the app's server and builds this Dockerfile there with `docker compose build`. The
compose file powder writes for the app uses the repo root as the build context, tags
the image `<name>:latest`, names the container `<name>` and loads the env from
`/opt/apps/<name>.env`, which powder renders from the env vars you set in the
dashboard. Powder also writes a `.dockerignore` so its own runtime files (deploy key,
compose file, database data) stay out of the build context. After the build it
health-checks the new container and swaps it in; a failed build keeps the old
version serving.

## Adapting it

- `next.config` must set `output: 'standalone'`.
- Remove the placeholder `ENV` lines your app does not need, and add one for any
  other variable your code reads at module load during the build.
- `NEXT_PUBLIC_*` values are inlined into the client bundle at build time, so the
  runtime env cannot change them: set the real value in the `builder` stage.
- If the app listens on another port, change `PORT` and `EXPOSE` and set the
  container port in powder to match.
- For npm or yarn, replace the corepack line and the install and build commands.
