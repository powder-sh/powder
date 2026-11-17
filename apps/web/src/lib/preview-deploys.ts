// Preview-deploy lifecycle: spin a new container per non-default branch on
// apps on a Traefik server. URL: pv-<container>-<branchSlug>.<server base_domain>.
//
// Sharing model:
// - Env: a preview reads only the preview env file (/opt/apps/<parent>.preview.env),
//   never the parent's production env. It reaches a database only if the preview
//   env names one (e.g. a DATABASE_URL set there).
// - Networks: `web` (Traefik routing) plus the preview's own
//   project network, never the shared `internal`: branch code must not reach
//   other apps' containers and databases. A parent DB reachable only over
//   `internal` is therefore NOT reachable from its previews.
// - Volumes: NONE per-preview (so destructive migrations CAN trash the prod db
//   if the user runs them — warned in the UI)
// - Cleanup: manual via UI; no auto on branch-delete in v1.

import { NO_BASE_DOMAIN_MESSAGE, branchSlug, readableBranchSlug, healthPathFor, hostForLabel, previewContainerName } from './app-hosts'
import type { HostServer } from './app-hosts'
import { isTraefikServer } from './traefik-servers'
import { readAppContainerPort, routeHostsFor } from './app-domains'
import { writeRuntimeFilesShell } from './app-runtime-files'
import { randomTempPath } from './temp-path'
import { appRepos, createId, db, eq, prefixes, previewDeploys } from './db'
import { appDeleteInFlight } from './deploys'
import type { AppRepo } from './db'
import { decryptDeployKey } from './repos'
import { getServer } from './servers'
import type { ServerConfig } from './servers'
import {
	gitCloneRepo,
	rebuildDeploy,
	runCommand,
	writeFileSecret,
	writeFileViaSftp,
} from './ssh'
import { shq } from './shell'
import { traefikRouterTlsLabel } from './traefik-tls'

// Previews need (a) a Traefik server and (b) a base domain on that server
// (servers.base_domain): preview URLs are <name>.<base_domain>. Without one the
// webhook answers `ignored` with this reason.
export function previewBlockReason(opts: {
	traefik: boolean
	serverId: string
	baseDomain: string | null
}): string | null {
	if (!opts.traefik) return 'previews need a Traefik server (servers.proxy = traefik)'
	if (!opts.baseDomain) {
		return `previews are not available on ${opts.serverId}: ${NO_BASE_DOMAIN_MESSAGE.replace(', add a custom domain', '')} (servers.base_domain, see docs/SELF-HOSTING.md)`
	}
	return null
}

export async function previewSkipReason(repo: AppRepo): Promise<string | null> {
	if (!repo.previewsEnabled) {
		return 'previews are off for this app (turn on "deploy previews of other branches" on its Settings tab, or PATCH /api/projects/<id> with {"previewsEnabled": true})'
	}
	const server = await getServer(repo.serverId)
	return previewBlockReason({
		traefik: !!server && (await isTraefikServer(server)),
		serverId: repo.serverId,
		baseDomain: server?.baseDomain ?? null,
	})
}

/** The commit this branch's preview last deployed successfully (null if none/unknown), for
 *  the webhook replay guard. */
export async function previewLastSha(repo: AppRepo, branch: string): Promise<string | null> {
	const slug = branchSlug(branch)
	const readableSlug = readableBranchSlug(branch)
	const rows = await db.select().from(previewDeploys).where(eq(previewDeploys.appRepoId, repo.id))
	const row = rows.find((r) => r.branchSlug === slug || (r.branchSlug === readableSlug && r.branch === branch))
	return row?.status === 'running' ? (row.lastSha ?? null) : null
}

export { branchSlug, previewContainerName }

/** The parent app was deleted, or its delete runs: no preview may be registered or kept. */
export class PreviewParentGoneError extends Error {}

/** Why no preview of `repo` may be registered or kept right now: its app row is
 *  gone, or a delete of the app runs (the guard startDeploy applies to deploys,
 *  appDeleteInFlight). null while the app is there. */
export async function previewParentGone(repo: Pick<AppRepo, 'id' | 'serverId' | 'containerName'>): Promise<string | null> {
	const [row] = await db.select({ id: appRepos.id }).from(appRepos).where(eq(appRepos.id, repo.id))
	if (!row) return `app ${repo.containerName} was deleted`
	if (await appDeleteInFlight(repo.serverId, repo.containerName)) return `app ${repo.containerName} is being deleted`
	return null
}

export class PreviewNameCollisionError extends Error {}

// Refuses (throws) when `name` is an app's container_name on this server, a
// different app's preview, or an existing /opt/apps/<name> directory. Run
// before ANY filesystem or compose action for a new preview.
export async function assertPreviewNameFree(deps: {
	name: string
	appContainerNames: string[]
	otherPreviewNames: string[]
	dirExists: (path: string) => Promise<boolean>
}): Promise<void> {
	const { name } = deps
	if (deps.appContainerNames.includes(name)) {
		throw new PreviewNameCollisionError(`preview name "${name}" collides with an existing app`)
	}
	if (deps.otherPreviewNames.includes(name)) {
		throw new PreviewNameCollisionError(`preview name "${name}" collides with another preview`)
	}
	if (await deps.dirExists(previewWorkingDir(name))) {
		throw new PreviewNameCollisionError(`/opt/apps/${name} already exists on the server`)
	}
}

export function previewWorkingDir(name: string): string {
	return `/opt/apps/${name}`
}

/** THE compose-guard context of a preview, shared by the preview deploy and
 *  every recreate of a preview container (lib/recreate-guard.ts): its URL host plus its
 *  live preview domains may be routed, and it reads the parent's preview env file. */
export async function previewGuardContext(
	server: ServerConfig,
	p: { id: string; url: string | null; containerName: string; appRepoId: string; parentName: string },
): Promise<{ routeHosts: string[]; extraEnvFiles: string[] }> {
	return {
		routeHosts: [
			...(p.url ? [p.url.replace(/^https?:\/\//, '')] : []),
			...(await routeHostsFor(server, p.appRepoId, p.containerName, p.id)),
		],
		extraEnvFiles: [`/opt/apps/${p.parentName}.preview.env`],
	}
}

export function previewUrl(server: HostServer, name: string): string | null {
	const host = hostForLabel(server, name)
	return host ? `https://${host}` : null
}

export interface SpinResult {
	previewId: string
	containerName: string
	url: string
	deployOutput: string
}

// Idempotent: if a preview row already exists for (repo, branchSlug), reuses
// the existing working dir + container and just pulls + rebuilds.
// Serialized per (parent app, branch slug): two pushes to one branch would
// otherwise race assertPreviewNameFree + the row insert and share the workdir. The row
// lookup happens INSIDE the lock, so the second push sees the first one's row.
const previewChains = new Map<string, Promise<unknown>>()

/**
 * The Dockerfile and container port a preview of this app builds and routes
 * to: the app's own (app_repos.dockerfile_path / container_port, stored at
 * create). An app created before container_port existed (null) gets the port
 * from the parent's compose / Traefik label (readAppContainerPort), else 3000.
 */
export async function previewBuildInputs(
	repo: Pick<AppRepo, 'serverId' | 'containerName' | 'dockerfilePath' | 'containerPort'>,
): Promise<{ dockerfilePath: string; containerPort: number }> {
	const dockerfilePath = repo.dockerfilePath || './Dockerfile'
	if (repo.containerPort != null) return { dockerfilePath, containerPort: repo.containerPort }
	const server = await getServer(repo.serverId)
	const containerPort = server ? await readAppContainerPort(server, repo.containerName) : 3000
	return { dockerfilePath, containerPort }
}

export async function spinOrRedeployPreview(
	repo: AppRepo,
	branch: string,
	containerPort = 3000,
	dockerfilePath = './Dockerfile',
	/** The pushed commit, recorded as the preview's last sha on success (replay guard). */
	sha: string | null = null,
): Promise<SpinResult> {
	const key = `${repo.id}:${branchSlug(branch)}`
	const prev = previewChains.get(key) ?? Promise.resolve()
	const run = prev.catch(() => {}).then(() => spinPreviewLocked(repo, branch, containerPort, dockerfilePath, sha))
	previewChains.set(key, run)
	try {
		return await run
	} finally {
		if (previewChains.get(key) === run) previewChains.delete(key)
	}
}

async function spinPreviewLocked(
	repo: AppRepo,
	branch: string,
	containerPort: number,
	dockerfilePath: string,
	sha: string | null,
): Promise<SpinResult> {
	const slug = branchSlug(branch)
	const readableSlug = readableBranchSlug(branch)
	const previewOverridesFile = `/opt/apps/${repo.containerName}.preview.env`

	const server = await getServer(repo.serverId)
	if (!server) throw new Error(`unknown server ${repo.serverId}`)
	// The webhook checked before it answered; the spin may start much later (queued
	// behind another spin of the branch).
	const goneAtStart = await previewParentGone(repo)
	if (goneAtStart) throw new PreviewParentGoneError(`preview refused: ${goneAtStart}`)

	// Look up or create preview row.
	const existing = await db
		.select()
		.from(previewDeploys)
		.where(eq(previewDeploys.appRepoId, repo.id))
		.then((rows) =>
			// Rows created before slugs were hashed carry the un-hashed slug: keep using them, but only
			// when they really are this branch (feat/x must not adopt feat-x's preview).
			rows.find((r) => r.branchSlug === slug || (r.branchSlug === readableSlug && r.branch === branch)),
		)

	// Existing rows keep the name they were created with (a preview row may
	// carry a `<parent>-<slug>` name); NEW previews get the `pv-` namespace.
	const name = existing?.containerName ?? previewContainerName(repo.containerName, slug)
	const workingDir = existing?.workingDir ?? previewWorkingDir(name)
	const composeFilePath = `${workingDir}/docker-compose.yml`
	// Existing rows keep their stored URL; new ones need a base domain.
	const url = existing?.url ?? previewUrl(server, name)
	if (!url) throw new Error(`previews not available on ${repo.serverId}: ${NO_BASE_DOMAIN_MESSAGE}`)

	let previewId = existing?.id
	if (!previewId) {
		// Collision check before the row, the clone or any compose action.
		const apps = await db
			.select({ containerName: appRepos.containerName })
			.from(appRepos)
			.where(eq(appRepos.serverId, repo.serverId))
		const previews = await db
			.select({ containerName: previewDeploys.containerName })
			.from(previewDeploys)
		await assertPreviewNameFree({
			name,
			appContainerNames: apps.map((a) => a.containerName),
			otherPreviewNames: previews.map((p) => p.containerName),
			dirExists: async (path) => {
				const r = await runCommand(
					server,
					`if [ -e ${shq(path)} ]; then echo exists; else echo ok; fi`,
					5_000,
				)
				return r.stdout.trim() === 'exists'
			},
		})
		// Registered only while the app is there: a delete that started meanwhile
		// would not see this row in its preview teardown.
		const goneAtRegister = await previewParentGone(repo)
		if (goneAtRegister) throw new PreviewParentGoneError(`preview refused: ${goneAtRegister}`)
		previewId = createId(prefixes.previewDeploy)
		await db.insert(previewDeploys).values({
			id: previewId,
			appRepoId: repo.id,
			branch,
			branchSlug: slug,
			containerName: name,
			workingDir,
			url,
			status: 'pending',
		})
	}

	const tmpKey = randomTempPath('/tmp/powder-preview')
	const composeTmp = `${tmpKey}.compose.yml`
	let keyPlanted = false
	// A failed first spin (row left 'failed', clone or compose never completed)
	// or a missing compose file is a FIRST spin: the preview was never set up.
	let isFirstSpin = !existing || existing.status === 'failed'
	try {
		if (!isFirstSpin) {
			const have = await runCommand(server, `[ -f ${shq(composeFilePath)} ] && echo ok || echo missing`, 5_000)
			isFirstSpin = have.stdout.trim() !== 'ok'
		}
		if (isFirstSpin) {
			// 1) Plant the parent's deploy key in /tmp, clone the branch, then move
			//    key into the working dir for future pulls.
			keyPlanted = true
			await writeFileSecret(server, tmpKey, decryptDeployKey(repo))
			await gitCloneRepo(server, workingDir, repo.repoUrl, branch, tmpKey)
		}

		// 2) The preview runs with the preview env file ONLY: it never reads the
		//    production env (a preview must not hold production secrets). The file
		//    is created empty if the user hasn't set any preview vars yet (compose
		//    env_file: errors if missing).
		await runCommand(server, `touch ${shq(previewOverridesFile)}`, 5_000)

		// 3) (Re)write the preview compose on every spin, so an existing preview
		//    never keeps a production env_file from an earlier compose.
		const composeYaml = renderPreviewCompose({
			name,
			dockerfilePath,
			containerPort,
			envFiles: [previewOverridesFile],
			host: url.replace(/^https?:\/\//, ''),
			healthUrl: repo.healthUrl,
			tlsMode: server.tlsMode,
		})
		// SFTP at 0600, not base64 in argv.
		await writeFileViaSftp(server, composeTmp, composeYaml, 0o600, 30_000, true, true)
		// symlink refusal, key + compose via tmp + mv -f, and a
		// .dockerignore. The preview workdir is the clone itself.
		const installed = await runCommand(
			server,
			writeRuntimeFilesShell({ workdir: workingDir, composeTmp, keyTmp: keyPlanted ? tmpKey : undefined, dockerfile: dockerfilePath }),
			20_000,
		)
		if (installed.code !== 0) {
			throw new Error(`refused to set up the preview directory: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}`)
		}

		// 4) Build + recreate (same code path as a real deploy, gives us
		//    rollback-tagging + the streaming output handler).
		const { output } = await rebuildDeploy(
			server,
			workingDir,
			composeFilePath,
			name,
			previewId,
			undefined,
			// Build THIS branch: without it the sync falls back to origin/HEAD, then
			// main, on the single-branch --depth 1 preview clone.
			{
				branch,
				swapOrdinal: Date.now(),
				skipMigrate: true,
				// the preview builds in its own BuildKit cache namespace.
				cacheNamespace: await (await import('./build-cache')).loadCacheNamespace(server.id, name),
				composeGuard: await previewGuardContext(server, {
					id: previewId,
					url,
					containerName: name,
					appRepoId: repo.id,
					parentName: repo.containerName,
				}),
			},
		)

		// The build takes minutes: a delete of the app that started meanwhile may have
		// torn the previews down already (or not seen this one), and this build then
		// created the container after it. Checked after the container exists: a
		// delete that starts later finds this row and tears the preview down itself.
		const goneAtEnd = await previewParentGone(repo)
		if (goneAtEnd) {
			await removeOrphanPreview(server, repo.serverId, previewId, name, workingDir)
			throw new PreviewParentGoneError(`preview ${name} removed: ${goneAtEnd}`)
		}

		await db
			.update(previewDeploys)
			.set({ status: 'running', lastDeployedAt: new Date(), lastError: null, branch, lastSha: sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null })
			.where(eq(previewDeploys.id, previewId))

		return { previewId, containerName: name, url, deployOutput: output }
	} catch (err) {
		// already cleaned up above
		if (err instanceof PreviewParentGoneError) throw err
		const msg = err instanceof Error ? err.message : 'unknown error'
		await db
			.update(previewDeploys)
			.set({ status: 'failed', lastError: msg })
			.where(eq(previewDeploys.id, previewId))
		// a failed FIRST spin leaves no checkout behind (a refused clone would
		// otherwise stay on the server until a teardown). Its containers go by label; the dir
		// only when it is no registered app's dir (a `<parent>-<slug>` preview name can alias one).
		if (isFirstSpin) {
			const aliased = (
				await db
					.select({ n: appRepos.containerName })
					.from(appRepos)
					.where(eq(appRepos.serverId, repo.serverId))
					.catch(() => [{ n: name }])
			).some((r) => r.n === name)
			if (!aliased)
				await runCommand(server, `${previewTeardownShell(name)}; rm -rf ${shq(workingDir)}`, 60_000).catch(() => {})
		}
		throw err
	} finally {
		// The planted key copy never outlives the spin (clone failure, install
		// failure or success: after a success it was already moved, rm -f is a no-op).
		await runCommand(server, `rm -f ${shq(composeTmp)}${keyPlanted ? ` ${shq(tmpKey)}` : ''}`, 5_000).catch(() => {})
	}
}

/** A preview whose app is gone: its containers and checkout (never when the name is
 *  a registered app's, like tearDownPreview) and its row. The parent row may be gone, so the server
 *  comes from the caller, not from tearDownPreview's lookup through the app. */
async function removeOrphanPreview(
	server: ServerConfig,
	serverId: string,
	previewId: string,
	name: string,
	workingDir: string,
): Promise<void> {
	const aliased = (
		await db
			.select({ n: appRepos.containerName })
			.from(appRepos)
			.where(eq(appRepos.serverId, serverId))
			.catch(() => [{ n: name }])
	).some((r) => r.n === name)
	if (!aliased) await runCommand(server, `${previewTeardownShell(name)}; rm -rf ${shq(workingDir)}`, 60_000).catch(() => {})
	await db.delete(previewDeploys).where(eq(previewDeploys.id, previewId))
}

export async function tearDownPreview(previewId: string): Promise<void> {
	const [preview] = await db
		.select()
		.from(previewDeploys)
		.where(eq(previewDeploys.id, previewId))
	if (!preview) return

	// Find the parent app_repo to resolve which server it lives on.
	const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, preview.appRepoId))
	if (!repo) {
		await db.delete(previewDeploys).where(eq(previewDeploys.id, previewId))
		return
	}
	const server = await getServer(repo.serverId)
	// Never rm -rf a directory that belongs to a registered app (a preview
	// row named `<parent>-<slug>` could alias another app).
	const aliased = (
		await db
			.select({ n: appRepos.containerName })
			.from(appRepos)
			.where(eq(appRepos.serverId, repo.serverId))
	).some((r) => r.n === preview.containerName)
	if (server && !aliased) {
		await runCommand(
			server,
			`${previewTeardownShell(preview.containerName)}; rm -rf ${shq(preview.workingDir)} ${shq(`/opt/apps/${preview.containerName}.env`)}`,
			60_000,
		).catch(() => {
			// best-effort cleanup; row is removed regardless
		})
	}
	await db.delete(previewDeploys).where(eq(previewDeploys.id, previewId))
}

/** remove a preview's containers and its default network by the compose project
 *  label and the network name, never through `docker compose down`: compose parses the
 *  preview checkout, whose tracked `.env` could set COMPOSE_PROJECT_NAME (or `-f` files)
 *  and make `down --remove-orphans` remove another project's containers. The preview
 *  compose is rendered with `name: <preview name>`, so its project and default network
 *  follow from the name. Best effort, always exits 0. */
export function previewTeardownShell(name: string): string {
	const label = shq(`label=com.docker.compose.project=${name}`)
	return (
		`__ids=$(docker ps -aq --filter ${label} 2>/dev/null); ` +
		`if [ -n "$__ids" ]; then docker rm -f $__ids >/dev/null 2>&1 || true; fi; ` +
		`docker network rm ${shq(`${name}_default`)} >/dev/null 2>&1 || true`
	)
}

export function renderPreviewCompose(opts: {
	name: string
	dockerfilePath: string
	containerPort: number
	envFiles: string[]
	host: string
	healthUrl?: string | null
	/** servers.tls_mode of the server: origin-cert routers serve the default-store cert. */
	tlsMode?: 'acme' | 'origin-cert'
}): string {
	const envFileBlock = opts.envFiles.map((p) => `      - ${p}`).join('\n')
	return `name: ${opts.name}

services:
  ${opts.name}:
    image: ${opts.name}:latest
    build:
      context: .
      dockerfile: ${opts.dockerfilePath}
    container_name: ${opts.name}
    restart: unless-stopped
    env_file:
${envFileBlock}
    labels:
      - traefik.enable=true
      - traefik.http.routers.${opts.name}.rule=Host(\`${opts.host}\`)
      - traefik.http.routers.${opts.name}.entrypoints=websecure
      - ${traefikRouterTlsLabel(opts.name, opts.tlsMode)}
      - traefik.http.services.${opts.name}.loadbalancer.server.port=${opts.containerPort}
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.path=${healthPathFor(opts.healthUrl)}
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.interval=10s
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.timeout=3s
      - traefik.http.middlewares.${opts.name}-diag.headers.customresponseheaders.X-Powder-App=${opts.name}
      - traefik.http.middlewares.${opts.name}-diag.headers.customresponseheaders.X-Powder-Preview=true
      - traefik.http.routers.${opts.name}.middlewares=${opts.name}-diag
    networks:
      - web
      - default

networks:
  web:
    external: true
`
}

