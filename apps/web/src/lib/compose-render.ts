// Default per-service memory limits for newly created apps. Conservative on
// purpose - they protect a shared server from a single
// runaway/leaky app eating all RAM and OOM-killing siblings. Users can bump
// in the generated docker-compose.yml if their app legitimately needs more.
//
// These DON'T affect build-time memory (compose `build:` runs unconstrained);
// for build OOMs see the Next.js Dockerfile template in framework-detect.ts.
const DEFAULT_APP_MEM_LIMIT = '512m'
const DEFAULT_DB_MEM_LIMIT = '256m'
const DEFAULT_KV_MEM_LIMIT = '128m'

import { healthPathFor, traefikRetryLabels } from './app-hosts'
import { drainActiveFor } from './drain-mode'
import { POSTGRES_IMAGE, REDIS_IMAGE } from './db-images'
import { traefikRouterTlsLabel } from './traefik-tls'
import { DEFAULT_TRAEFIK_NETWORK, assertDockerNetworkName } from './traefik-network'

export function renderComposeYaml(opts: {
	name: string
	dockerfilePath: string
	hostPort: number | null
	containerPort: number
	envFilePath: string
	publicHost: string | null
	healthUrl?: string | null
	/** True on a Traefik server: with no publicHost emit traefik.enable=false. */
	traefik?: boolean
	tlsMode?: 'acme' | 'origin-cert'
	postgres: { password: string; dataDir: string } | null
	kv: { dataDir: string } | null
	/** Explicit opt-in to the server's shared `internal` network (cross-project
	 *  DB containers shared by several apps). Default off: an app only joins `web` (Traefik) and
	 *  its own db/kv networks. */
	sharedInternal?: boolean
	/** The network the server's Traefik routes over (traefik-network-run.ts
	 *  resolveTraefikNetwork). Absent or `web`: the compose is exactly what it always
	 *  was. Another network: the app joins that one instead of `web` and carries
	 *  traefik.docker.network, so Traefik picks it among the app's networks (its db/kv
	 *  networks too). Also on an app with no host yet: the labels a custom domain adds
	 *  later (app-domains.ts, an override file) merge with these by key and keep it. */
	traefikNetwork?: string
}): string {
	const dbNet = `${opts.name}-db`
	const kvNet = `${opts.name}-kv`
	const routeNet = assertDockerNetworkName(opts.traefikNetwork ?? DEFAULT_TRAEFIK_NETWORK)
	const otherNet = routeNet !== DEFAULT_TRAEFIK_NETWORK
	const internal = opts.sharedInternal && routeNet !== 'internal'
	const appNetworks = [
		routeNet,
		...(internal ? ['internal'] : []),
		...(opts.postgres ? [dbNet] : []),
		...(opts.kv ? [kvNet] : []),
	]
	const dependsOn = [...(opts.postgres ? ['db'] : []), ...(opts.kv ? ['kv'] : [])]
	const appExtras =
		dependsOn.length > 0
			? `    depends_on:\n${dependsOn.map((d) => `      - ${d}`).join('\n')}\n`
			: ''
	const portsBlock = opts.hostPort
		? `    ports:
      - "127.0.0.1:${opts.hostPort}:${opts.containerPort}"
`
		: ''
	// No host (Traefik server without a base domain): route nothing, like
	// applyDomainsToCompose, until a custom domain is attached.
	const labelsBlock = opts.publicHost
		? `    labels:
      - traefik.enable=true
${otherNet ? `      - traefik.docker.network=${routeNet}\n` : ''}      - traefik.http.routers.${opts.name}.rule=Host(\`${opts.publicHost}\`)
      - traefik.http.routers.${opts.name}.entrypoints=websecure
      - ${traefikRouterTlsLabel(opts.name, opts.tlsMode)}
      - traefik.http.services.${opts.name}.loadbalancer.server.port=${opts.containerPort}
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.path=${healthPathFor(opts.healthUrl)}
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.interval=10s
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.timeout=3s
      - traefik.http.middlewares.${opts.name}-diag.headers.customresponseheaders.X-Powder-App=${opts.name}
${drainActiveFor(opts.name) ? traefikRetryLabels(opts.name).labels.map((l) => `      - ${l}\n`).join('') : ''}      - traefik.http.routers.${opts.name}.middlewares=${opts.name}-diag${drainActiveFor(opts.name) ? `,${traefikRetryLabels(opts.name).middleware}` : ''}
`
		: opts.traefik
			? `    labels:
      - traefik.enable=false
${otherNet ? `      - traefik.docker.network=${routeNet}\n` : ''}`
			: ''
	const dbBlock = opts.postgres
		? `
  db:
    image: ${POSTGRES_IMAGE}
    container_name: ${opts.name}-db
    restart: unless-stopped
    mem_limit: ${DEFAULT_DB_MEM_LIMIT}
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${opts.postgres.password}
      POSTGRES_DB: app
    volumes:
      - ${opts.postgres.dataDir}:/var/lib/postgresql/data
    networks:
      - ${dbNet}
`
		: ''
	const kvBlock = opts.kv
		? `
  kv:
    image: ${REDIS_IMAGE}
    container_name: ${opts.name}-kv
    restart: unless-stopped
    mem_limit: ${DEFAULT_KV_MEM_LIMIT}
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - ${opts.kv.dataDir}:/data
    networks:
      - ${kvNet}
`
		: ''
	const netDecls =
		(opts.postgres ? `  ${dbNet}: {}\n` : '') +
		(opts.kv ? `  ${kvNet}: {}\n` : '')

	return `name: ${opts.name}

services:
  ${opts.name}:
    image: ${opts.name}:latest
    build:
      context: .
      dockerfile: ${opts.dockerfilePath}
    container_name: ${opts.name}
    restart: unless-stopped
    mem_limit: ${DEFAULT_APP_MEM_LIMIT}
    env_file: ${opts.envFilePath}
${portsBlock}${labelsBlock}    networks:
${appNetworks.map((n) => `      - ${n}`).join('\n')}
${appExtras}${dbBlock}${kvBlock}
networks:
  ${routeNet}:
    external: true
${internal ? '  internal:\n    external: true\n' : ''}${netDecls}`
}
