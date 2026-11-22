// Per-deploy URL snapshots — Vercel-style "every past deploy keeps its own
// URL." On-demand spawn (not automatic) so we don't burn RAM on cold
// snapshots no one's looking at.
//
// User clicks "preview" on a past deploy → spawn a parallel container at
// dep-<deployId-suffix>-<container>.<servers.base_domain> running the tagged image.
// Auto-teardown after SNAPSHOT_TTL_MS via the cron-scheduler tick.

import { NO_BASE_DOMAIN_MESSAGE, hostForLabel } from './app-hosts'
import type { HostServer } from './app-hosts'
import { isTraefikServer } from './traefik-servers'
import { resolveRoutingNetwork } from './traefik-network-run'
import { db, deploys, eq, lte } from './db'
import type { Deploy, AppRepo } from './db'
import { getServer } from './servers'
import { runCommand } from './ssh'
import { runHealthGate } from './deploys'
import { COMPOSE_LABEL_BLANKS, appLockShell, composeFileArgs, composeUpCommand, imageComposeLabelProblems } from './deploy/fragments'
import { appLockPath } from './deploy-supersede'
import { shq } from './shell'
import { traefikRouterTlsLabel } from './traefik-tls'
import { SIDE_RUN_CAPS } from './side-run'
import { ALL_PROFILES } from './deploy/compose-hash'

/** flags for a container powder starts with plain `docker run` from an app
 *  image (URL snapshot, rollback bridge): the side-run hardening (lib/side-run.ts),
 *  and every compose label powder
 *  or compose reads set empty, so the image cannot place it in a compose project. */
export const SIDE_RUN_HARDEN = `${SIDE_RUN_CAPS} ${COMPOSE_LABEL_BLANKS} `

/** refuse an image that carries com.docker.compose.* labels compose never
 *  writes on an image (every mode). Throws with the keys. */
async function assertImageComposeLabels(server: Parameters<typeof runCommand>[0], image: string): Promise<void> {
	const r = await runCommand(server, `docker image inspect -f '{{json .Config.Labels}}' ${shq(image)} 2>/dev/null`, 15_000)
	if (r.code !== 0) throw new Error(`cannot inspect image ${image}`)
	let labels: Record<string, unknown> | null = null
	try {
		labels = JSON.parse(r.stdout.trim() || 'null') as Record<string, unknown> | null
	} catch {
		throw new Error(`cannot read the labels of image ${image}`)
	}
	const bad = imageComposeLabelProblems(labels)
	if (bad.length)
		throw new Error(
			`image ${image} carries com.docker.compose.* image label(s) compose never sets on an image (${bad.join(', ')}); powder refuses to run it`,
		)
}

const SNAPSHOT_TTL_MS = 60 * 60 * 1000 // 1 hour

function snapshotContainerName(containerName: string, deployId: string): string {
	const suffix = deployId.replace(/^dep_/, '').slice(0, 12).toLowerCase()
	return `dep-${suffix}-${containerName}`.slice(0, 50)
}

export function snapshotHost(server: HostServer, containerName: string, deployId: string): string | null {
	return hostForLabel(server, snapshotContainerName(containerName, deployId))
}

// Router TLS label for the ad-hoc containers below (lib/traefik-tls.ts).
function tlsLabel(name: string, tlsMode?: 'acme' | 'origin-cert'): string {
	return `-l ${shq(traefikRouterTlsLabel(name, tlsMode))} `
}

/** Traefik rule for the rollback bridge: the default host only, or null (no bridge). */
export function bridgeRuleFor(server: HostServer, liveName: string): string | null {
	const host = hostForLabel(server, liveName)
	return host ? `Host(\`${host}\`)` : null
}

export async function spawnSnapshot(
	deploy: Deploy,
	repo: AppRepo,
): Promise<{ url: string; expiresAt: Date }> {
	if (!(await isTraefikServer(repo.serverId))) {
		throw new Error('snapshots need an app on a Traefik server')
	}
	if (!deploy.imageTag) {
		throw new Error('this deploy has no tagged image, so it cannot be opened as a snapshot')
	}
	const server = await getServer(repo.serverId)
	if (!server) throw new Error('unknown server')

	const containerName = snapshotContainerName(repo.containerName, deploy.id)
	const host = snapshotHost(server, repo.containerName, deploy.id)
	if (!host) throw new Error(`snapshots unavailable: ${NO_BASE_DOMAIN_MESSAGE}`)
	const url = `https://${host}`
	const productionEnv = `/opt/apps/${repo.containerName}.env`
	const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS)

	// docker run with traefik labels. Reuses the parent's env file (snapshots
	// read prod data, that's the whole point: see what was live then). Joins
	// the network powder routes over on the server (`web` unless its Traefik is declared to route over
	// another; a validated name, so a bare word) so traefik picks it up. One network
	// only, so no traefik.docker.network label is needed.
	const net = await resolveRoutingNetwork(server)
	const safeImage = deploy.imageTag.replace(/[^A-Za-z0-9._\-:/]/g, '')
	if (safeImage !== deploy.imageTag) {
		throw new Error(`unsafe image tag: ${deploy.imageTag}`)
	}
	// Discover the exposed port from the image (works for both `EXPOSE 3000`
	// and `EXPOSE 3000/tcp`); fall back to the parent's compose port; final
	// fallback 3000.
	const portRead = await runCommand(
		server,
		`docker inspect ${shq(deploy.imageTag)} --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}}{{end}}' 2>/dev/null | head -c 16 || true`,
		8_000,
	)
	const exposedPort = (portRead.stdout.trim().match(/^(\d+)/)?.[1]) || '3000'

	await assertImageComposeLabels(server, deploy.imageTag)
	const cmd =
		`docker rm -f ${shq(containerName)} 2>/dev/null; ` +
		`docker run -d --pull=never --name ${shq(containerName)} --restart no --network ${net} ${SIDE_RUN_HARDEN}` +
		`--env-file ${shq(productionEnv)} ` +
		`-l traefik.enable=true ` +
		`-l ${shq(`traefik.http.routers.${containerName}.rule=Host(\`${host}\`)`)} ` +
		`-l ${shq(`traefik.http.routers.${containerName}.entrypoints=websecure`)} ` +
		tlsLabel(containerName, server.tlsMode) +
		`-l ${shq(`traefik.http.services.${containerName}.loadbalancer.server.port=${exposedPort}`)} ` +
		`${shq(deploy.imageTag)} 2>&1`
	const { code, stdout, stderr } = await runCommand(server, cmd, 30_000)
	if (code !== 0) throw new Error(stderr || stdout || 'docker run failed')

	await db
		.update(deploys)
		.set({
			snapshotContainer: containerName,
			snapshotUrl: url,
			snapshotExpiresAt: expiresAt,
		})
		.where(eq(deploys.id, deploy.id))

	return { url, expiresAt }
}

// Atomic rollback for apps on a Traefik server. Bridges the recreate gap with a
// priority=200 sibling so traffic stays continuous:
//   1. spawn `<name>-rb` running the target image with traefik labels
//      claiming the live Host at priority=200 (wins over the live router)
//   2. wait briefly so traefik picks it up
//   3. retag historical image as the compose service's `image:` ref so it
//      now resolves to the rolled-back content
//   4. recreate the live container via compose (gets all the right networks,
//      domains, powder.json labels — plus the rolled-back image now). The
//      sibling keeps serving during this gap.
//   5. tear down the sibling — live container is now serving the rolled-back
//      image with full labels/networks intact.
//
// Returns captured output for the deploy log.
/** Repository part of an image ref: strips a trailing `:tag` (only after the
 *  last `/`, so `reg:5000/app:deploy-x` keeps its registry port) and any digest. */
export function imageRepo(ref: string): string {
	const noDigest = ref.split('@')[0]
	const slash = noDigest.lastIndexOf('/')
	const colon = noDigest.lastIndexOf(':')
	return colon > slash ? noDigest.slice(0, colon) : noDigest
}

/** Pick the compose `image:` ref (from `compose config --images`) that the
 *  rolled-back tag belongs to: same repository. A lone image is accepted too. */
export function pickComposeImage(images: string[], imageTag: string): string | null {
	const list = images.map((i) => i.trim()).filter(Boolean)
	const repo = imageRepo(imageTag)
	const hit = list.find((i) => imageRepo(i) === repo)
	if (hit) return hit
	return list.length === 1 ? list[0] : null
}

export async function atomicRollback(
	deploy: Deploy,
	repo: AppRepo,
	/** From the route's container inspection (compose labels): the real compose
	 *  file and SERVICE, which differ from /opt/apps/<name> and the container
	 *  name for many apps (service `app`). */
	facts?: { configFile: string; service: string; composeFiles?: string[]; workingDir?: string },
): Promise<{ output: string }> {
	if (!(await isTraefikServer(repo.serverId))) {
		throw new Error('atomic rollback needs an app on a Traefik server')
	}
	if (!deploy.imageTag) {
		throw new Error('target deploy has no tagged image')
	}
	const safeImage = deploy.imageTag.replace(/[^A-Za-z0-9._\-:/]/g, '')
	if (safeImage !== deploy.imageTag) {
		throw new Error(`unsafe image tag: ${deploy.imageTag}`)
	}
	const server = await getServer(repo.serverId)
	if (!server) throw new Error('unknown server')

	const liveName = repo.containerName
	const tempName = `${liveName}-rb`
	// The bridge is a bare `docker run` container on the Traefik network only (`web`
	// unless the server's Traefik is declared to route over another) that cannot reach the app's
	// DB, so it claims ONLY the default host, never custom domains.
	const liveRule = bridgeRuleFor(server, liveName)
	const productionEnv = `/opt/apps/${liveName}.env`
	const composeFile = facts?.configFile ?? `/opt/apps/${liveName}/docker-compose.yml`
	const service = facts?.service ?? liveName
	const cf = composeFileArgs(composeFile, facts?.composeFiles)
	const workingDir = facts?.workingDir ?? composeFile.replace(/\/[^/]*$/, '')
	const lock = appLockPath(workingDir, service)
	// the rolled-back image is run by compose and by the bridge below.
	await assertImageComposeLabels(server, deploy.imageTag)
	// the deploy's compose guard on the compose on disk, before anything starts.
	const { checkComposeForRecreate } = await import('./recreate-guard')
	const approval = await checkComposeForRecreate(server, {
		app: liveName,
		configFile: composeFile,
		composeFiles: facts?.composeFiles,
		workingDir,
		what: 'rollback',
	})

	const portRead = await runCommand(
		server,
		`docker inspect ${shq(deploy.imageTag)} --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}}{{end}}' 2>/dev/null | head -c 16 || true`,
		8_000,
	)
	const exposedPort = portRead.stdout.trim().match(/^(\d+)/)?.[1] || '3000'

	const log: string[] = [approval.log.trimEnd()]
	const run = async (cmd: string, label: string, timeoutMs = 30_000) => {
		log.push(`── ${label} ──`)
		const { stdout, code, stderr } = await runCommand(server, cmd, timeoutMs)
		log.push(stdout || stderr || `(exit ${code})`)
		if (code !== 0) throw new Error(`${label} failed: ${stderr || stdout || code}`)
	}

	const bridged = liveRule !== null
	// Running image BEFORE the retag, so a failed recreate / health gate can put
	// the shared tag back (otherwise the next plain recreate ships the rejected image).
	let prevImageId = ''
	let composeImage: string | null = null
	let retagged = false
	let succeeded = false
	try {
		const prev = await runCommand(server, `docker inspect -f '{{.Image}}' ${shq(liveName)} 2>/dev/null`, 15_000).catch(() => null)
		prevImageId = prev && prev.code === 0 ? prev.stdout.trim() : ''
		// 1. Bridge container with priority=200 so traefik routes new traffic to
		//    it for the duration of the rollback.
		await run(`docker rm -f ${shq(tempName)} 2>/dev/null || true`, `cleanup leftover ${tempName}`)
		if (!bridged) log.push('(no default host to bridge: server has no base domain, rolling back without the bridge)')
		else await run(
			`docker run -d --pull=never --name ${shq(tempName)} --restart no --network ${await resolveRoutingNetwork(server)} ${SIDE_RUN_HARDEN}` +
				`--env-file ${shq(productionEnv)} ` +
				`-l traefik.enable=true ` +
				`-l ${shq(`traefik.http.routers.${tempName}.rule=${liveRule}`)} ` +
				`-l ${shq(`traefik.http.routers.${tempName}.entrypoints=websecure`)} ` +
				tlsLabel(tempName, server.tlsMode) +
				`-l ${shq(`traefik.http.routers.${tempName}.priority=200`)} ` +
				`-l ${shq(`traefik.http.services.${tempName}.loadbalancer.server.port=${exposedPort}`)} ` +
				`${shq(deploy.imageTag)}`,
			`spawn ${tempName} (priority=200)`,
		)

		// 2. Brief delay so traefik's docker provider picks up the new container.
		if (bridged) await run(`sleep 3`, 'wait for traefik to discover')

		// 3. Retag historical → the compose service's own `image:` ref (read from
		//    `compose config --images`, not guessed as `<name>:latest`).
		log.push('── resolve compose image ──')
		const imgs = await runCommand(server, `docker compose ${cf} ${ALL_PROFILES} config --images 2>/dev/null`, 20_000)
		composeImage = imgs.code === 0 ? pickComposeImage(imgs.stdout.split('\n'), deploy.imageTag) : null
		if (!composeImage) throw new Error(`could not determine the compose image for ${liveName} (config --images: ${imgs.stdout.trim() || imgs.stderr.trim() || `exit ${imgs.code}`})`)
		log.push(composeImage)
		// Retag AND recreate in ONE locked shell. The shared tag is what a
		// concurrent deploy's build / swap gate also moves: retagging outside the
		// per-app lock let it land between our retag and our up (and made a
		// failed up leave the wrong image on the tag). On a failed up the shell
		// puts the previously running image back itself, still under the lock.
		log.push(`── retag + recreate ${service} via compose (under the per-app lock) ──`)
		retagged = true
		const upCmd = composeUpCommand(composeFile, service, workingDir, { cf, tail: 20, lock: false, app: liveName, approval })
		const restoreTag = prevImageId ? `docker tag ${shq(prevImageId)} ${shq(composeImage)} >/dev/null 2>&1; ` : ''
		const locked =
			appLockShell(lock) +
			`echo ${shq(`retag → ${composeImage}`)} && docker tag ${shq(deploy.imageTag)} ${shq(composeImage)} 2>&1 && ` +
			`${upCmd} || { ${restoreTag}exit 1; }`
		// flock wait (90s) + the recreate
		await run(`bash -o pipefail -c ${shq(locked)}`, `recreate ${service} via compose`, 210_000)

		// 5. The rolled-back container must actually serve (same gate as a deploy)
		//    before the sibling goes away.
		log.push('── post-rollback health check ──')
		const gate = await runHealthGate({ server, serverId: repo.serverId, containerName: liveName })
		log.push(gate.output)
		if (gate.healthy === false) throw new Error('rolled back, but the rolled-back version is UNHEALTHY')
		succeeded = true
	} finally {
		if (retagged && !succeeded && prevImageId && composeImage) {
			// Under the lock too: a concurrent deploy may be mid-swap on this tag.
			await runCommand(
				server,
				`bash -o pipefail -c ${shq(`${appLockShell(lock)}docker tag ${shq(prevImageId)} ${shq(composeImage)}`)}`,
				120_000,
			).catch(() => {})
			log.push(`[rollback] failed: shared tag ${composeImage} restored to the previously running image`)
		}
		// Always drop the priority=200 sibling: left behind it would own the default
		// host with no DB network after any failure above.
		await runCommand(server, `docker rm -f ${shq(tempName)} >/dev/null 2>&1 || true`, 30_000).catch(() => {})
	}

	return { output: log.join('\n') }
}

// Called from the in-process scheduler tick. Tears down any snapshot whose
// expiry has passed.
export async function cleanupExpiredSnapshots(): Promise<void> {
	const now = new Date()
	const expired = await db
		.select()
		.from(deploys)
		.where(lte(deploys.snapshotExpiresAt, now))
	for (const d of expired) {
		if (!d.snapshotContainer) continue
		const server = await getServer(d.serverId)
		if (!server) continue
		try {
			await runCommand(server, `docker rm -f ${shq(d.snapshotContainer)} 2>/dev/null || true`, 15_000)
		} catch {
			// best-effort; row clears regardless
		}
		await db
			.update(deploys)
			.set({ snapshotContainer: null, snapshotUrl: null, snapshotExpiresAt: null })
			.where(eq(deploys.id, d.id))
	}
}

