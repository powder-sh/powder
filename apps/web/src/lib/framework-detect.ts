// Best-effort framework detection from a repo's package.json.
// Used to prefill sensible defaults in the /new wizard so the user doesn't
// have to think about ports / dockerfile path / etc.

export interface FrameworkInfo {
	id: string // 'next' | 'vite' | 'astro' | 'remix' | 'sveltekit' | 'bun-server' | 'node' | 'unknown'
	displayName: string
	defaultContainerPort: number
}

export function detectFromPackageJson(text: string): FrameworkInfo {
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {}
	try {
		pkg = JSON.parse(text)
	} catch {
		return unknown()
	}
	const deps = { ...pkg.dependencies, ...pkg.devDependencies }
	const has = (name: string) => name in deps

	if (has('next')) return { id: 'next', displayName: 'Next.js', defaultContainerPort: 3000 }
	if (has('@remix-run/react') || has('@remix-run/node'))
		return { id: 'remix', displayName: 'Remix', defaultContainerPort: 3000 }
	if (has('@sveltejs/kit')) return { id: 'sveltekit', displayName: 'SvelteKit', defaultContainerPort: 3000 }
	if (has('astro')) return { id: 'astro', displayName: 'Astro', defaultContainerPort: 4321 }
	if (has('vite')) return { id: 'vite', displayName: 'Vite', defaultContainerPort: 4173 }
	if (has('hono')) return { id: 'bun-server', displayName: 'Hono (Bun)', defaultContainerPort: 3000 }
	if (has('elysia')) return { id: 'bun-server', displayName: 'Elysia (Bun)', defaultContainerPort: 3000 }
	if (has('express') || has('fastify') || has('koa'))
		return { id: 'node', displayName: 'Node server', defaultContainerPort: 3000 }
	return unknown()
}

function unknown(): FrameworkInfo {
	return { id: 'unknown', displayName: 'unknown', defaultContainerPort: 3000 }
}

// Detects which package manager the repo uses by lockfile presence.
// Caller passes a map of `path -> exists` for the four lockfiles we care about.
export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

export function detectPackageManager(lockfiles: {
	'bun.lockb'?: boolean
	'bun.lock'?: boolean
	'pnpm-lock.yaml'?: boolean
	'yarn.lock'?: boolean
	'package-lock.json'?: boolean
}): PackageManager {
	if (lockfiles['bun.lockb'] || lockfiles['bun.lock']) return 'bun'
	if (lockfiles['pnpm-lock.yaml']) return 'pnpm'
	if (lockfiles['yarn.lock']) return 'yarn'
	return 'npm'
}

// Generates a sensible Dockerfile for the detected framework + package
// manager. Multi-stage where it makes sense; static-output frameworks (Vite,
// Astro static, etc) get served by `serve` so the runtime image stays tiny.
//
// All generated Dockerfiles use BuildKit cache mounts (`--mount=type=cache`)
// for the dependency install step + Next.js build cache, so later rebuilds
// reuse the downloaded packages and the build cache. Requires the
// `# syntax=docker/dockerfile:1.4` directive at the top, which all modern
// docker engines support (and which docker compose v2 enables by default).
const SYNTAX =
	'# syntax=docker/dockerfile:1.4@sha256:9ba7531bd80fb0a858632727cf7a112fbfd19b17e94c4e84ced81e24ef1a0dbc\n'

// Base images and tool versions for generated Dockerfiles, pinned to exact
// versions so a rebuild of the same commit gets the same toolchain. Bump them
// here, in one place.
export const NODE_IMAGE = 'node:22.23.3-alpine'
export const BUN_IMAGE = 'oven/bun:1.2.14-alpine'
/** Same pnpm version as this repo's packageManager field. */
export const PNPM_VERSION = '10.34.9'

// Belt and braces next to the .dockerignore powder writes: delete powder's
// runtime files from the build stage before a runtime stage copies it.
const SCRUB = 'RUN rm -rf .deploy-key docker-compose.yml pgdata kvdata .git .powder-* .env* *.env'

/** Readable per-cache ids for generated Dockerfiles. Isolation does not rest on
 *  them: every Dockerfile powder builds (generated or the repo's) has its cache
 *  mount ids rewritten to per-app salted ones before the build (build-cache.ts). */
export function cacheId(appName: string, cache: string): string {
	const a = appName.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 60) || 'app'
	return `${a}-${cache}`
}

export function dockerfileFor(framework: FrameworkInfo, pm: PackageManager, appName: string): string {
	const port = framework.defaultContainerPort
	const install = installSnippet(pm, appName)
	const buildCmd = buildCommand(pm)

	switch (framework.id) {
		case 'next':
			// assumes next.config.{js,ts} sets `output: 'standalone'`.
			// Build-step env vars are aimed at build OOMs on hosts with little memory:
			//   - NODE_OPTIONS=--max-old-space-size=2048 gives Node 2GB heap,
			//     enough for most Next.js builds without crashing a small host.
			//   - NEXT_TELEMETRY_DISABLED=1 saves a network round-trip + a few MB.
			//   - `${buildCmd} -- --no-lint` skips eslint at build-time. Linting
			//     is the largest single contributor to Next.js build memory.
			//     Type-check still runs unless next.config has typescript.ignoreBuildErrors.
			return `${SYNTAX}# Powder-generated Dockerfile for Next.js
FROM ${NODE_IMAGE} AS build
WORKDIR /app
${install}
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN --mount=type=cache,id=${cacheId(appName, 'next-cache')},target=/app/.next/cache ${buildCmd} -- --no-lint

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE ${port}
CMD ["node", "server.js"]
`
		case 'vite':
		case 'astro':
		case 'sveltekit':
			return `${SYNTAX}# Powder-generated Dockerfile for ${framework.displayName}
FROM ${NODE_IMAGE} AS build
WORKDIR /app
${install}
COPY . .
RUN ${buildCmd}

FROM ${NODE_IMAGE}
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/dist ./dist
EXPOSE ${port}
CMD ["serve", "-s", "dist", "-l", "${port}"]
`
		case 'remix':
			return `${SYNTAX}# Powder-generated Dockerfile for Remix
FROM ${NODE_IMAGE} AS build
WORKDIR /app
${install}
COPY . .
RUN ${buildCmd}

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}
COPY --from=build /app/build ./build
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
EXPOSE ${port}
CMD ["npx", "remix-serve", "build/index.js"]
`
		case 'bun-server':
			return `${SYNTAX}# Powder-generated Dockerfile for ${framework.displayName}
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN --mount=type=cache,id=${cacheId(appName, 'bun-cache')},target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
${SCRUB}

FROM ${BUN_IMAGE}
WORKDIR /app
ENV PORT=${port}
COPY --from=build /app ./
EXPOSE ${port}
CMD ["bun", "run", "start"]
`
		case 'node':
			return nodeServerDockerfile('Node server', install, port)
		default:
			return nodeServerDockerfile('generic Node', install, port)
	}
}

// Plain Node servers have no fixed output dir, so the runtime stage copies the
// build stage's /app after SCRUB removed every powder runtime file from it.
// Together with the .dockerignore powder writes, the deploy key, compose and DB
// data can never end up in the final image.
function nodeServerDockerfile(label: string, install: string, port: number): string {
	return `${SYNTAX}# Powder-generated Dockerfile (${label})
FROM ${NODE_IMAGE} AS build
WORKDIR /app
${install}
COPY . .
${SCRUB}

FROM ${NODE_IMAGE}
WORKDIR /app
ENV PORT=${port}
COPY --from=build /app ./
EXPOSE ${port}
CMD ["npm", "start"]
`
}

function installSnippet(pm: PackageManager, appName: string): string {
	if (pm === 'bun') {
		return `COPY --from=${BUN_IMAGE} /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock* bun.lockb* ./
RUN --mount=type=cache,id=${cacheId(appName, 'bun-cache')},target=/root/.bun/install/cache bun install --frozen-lockfile`
	}
	if (pm === 'pnpm') {
		return `RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=${cacheId(appName, 'pnpm-store')},target=/root/.local/share/pnpm/store/v3 pnpm install --frozen-lockfile`
	}
	if (pm === 'yarn') {
		return `COPY package.json yarn.lock ./
RUN --mount=type=cache,id=${cacheId(appName, 'yarn-cache')},target=/usr/local/share/.cache/yarn yarn install --frozen-lockfile`
	}
	return `COPY package*.json ./
RUN --mount=type=cache,id=${cacheId(appName, 'npm-cache')},target=/root/.npm npm ci`
}

function buildCommand(pm: PackageManager): string {
	if (pm === 'bun') return 'bun run build'
	if (pm === 'pnpm') return 'pnpm run build'
	if (pm === 'yarn') return 'yarn build'
	return 'npm run build'
}
