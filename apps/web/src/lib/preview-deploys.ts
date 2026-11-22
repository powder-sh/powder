// Preview-deploy lifecycle: spin a new container per non-default branch on
// apps on a Traefik server. URL: pv-<container>-<branchSlug>.<server base_domain>.
//
// Sharing model:
// - Env: a preview reads only the preview env file (/opt/apps/<parent>.preview.env),
//   never the parent's production env. It reaches a database only if the preview
//   env names one (e.g. a DATABASE_URL set there).
// - Networks: the server's Traefik network (`web` unless its Traefik is declared
//   to route over another, traefik-network.ts routingNetwork) plus the preview's own
//   project network, never the shared `internal`: branch code must not reach
//   other apps' containers and databases. A parent DB reachable only over
//   `internal` is therefore NOT reachable from its previews.
// - Volumes: NONE per-preview (so destructive migrations CAN trash the prod db
//   if the user runs them — warned in the UI)
// - Cleanup: manual via UI; no auto on branch-delete in v1.

import type { TestGate } from '@powder/db/schema'
import { NO_BASE_DOMAIN_MESSAGE, branchSlug, readableBranchSlug, healthPathFor, hostForLabel, previewContainerName, traefikRetryLabels } from './app-hosts'
import { drainActiveFor } from './drain-mode'
import type { HostServer } from './app-hosts'
import { isTraefikServer } from './traefik-servers'
import { DEFAULT_TRAEFIK_NETWORK, assertDockerNetworkName } from './traefik-network'
import { resolveRoutingNetwork } from './traefik-network-run'
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
import { CloneError, cloneNonce, nonceReadShell } from './ssh/git'
import { cloneMarkerMatchShell, cloneMarkerMatchVarShell, clonePurposeSlug, cloneTargetOk, cloneTmpMarkerMatchVarShell } from './clone-marker'
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

/** The clone purpose of a preview row (lib/clone-marker.ts). */
export function previewClonePurpose(previewId: string): string {
	return `preview:${previewId}`
}

/** Shell (never fails): remove a preview's working dir only when its marker
 *  (`.git/powder-clone-target`) names this preview row, checked right before the
 *  removal. Never by name alone: an unmarked dir, or one marked for another owner,
 *  is left, and so are the containers of the preview's compose project: they are torn
 *  down (by label, previewTeardownShell) only together with the proven dir. With
 *  `siblings`, also this row's copies next to it, each only with the exact name shape
 *  and the marker naming this row: kept copies `<dir>.before-powder.<digits>` (clone
 *  marker) and dead temp clones `<dir>.clone.preview-<row id>.<digits>` (temp marker).
 *  Then it counts the containers of the project that are still there.
 *  Reports through the clone scripts' channel: the nonce comes on stdin, everything
 *  runs with stdout moved to stderr and fd 3 closed, and fd 3 (the real stdout) gets
 *  only `__PV_<nonce>__ dir=<removed|left|absent> containers=<n|unknown>`
 *  (parsePreviewDirStatus). A path that is not one plain segment below the apps root
 *  is never touched. */
export function previewDirRemoveShell(
	/** the preview's compose project: its containers go only together with its proven dir */
	name: string,
	workingDir: string,
	previewId: string,
	opts: { siblings?: boolean; appsRoot?: string } = {},
): string {
	const purpose = previewClonePurpose(previewId)
	const wd = shq(workingDir)
	const exact = (prefix: string, test: string) =>
		`for __d in ${shq(prefix)}*; do __r=\${__d##*.}; case "$__r" in ''|*[!0-9]*) continue ;; esac; ` +
		`[ "$__d" = ${shq(prefix)}"$__r" ] || continue; if ${test}; then rm -rf -- "$__d"; fi; done; `
	const act = cloneTargetOk(workingDir, opts.appsRoot)
		? (opts.siblings
				? exact(`${workingDir}.before-powder.`, cloneMarkerMatchVarShell('__d', purpose)) +
					exact(`${workingDir}.clone.${clonePurposeSlug(purpose)}.`, cloneTmpMarkerMatchVarShell('__d', purpose))
				: '') +
			`if ${cloneMarkerMatchShell(workingDir, purpose)}; then ${previewTeardownShell(name)}; rm -rf -- ${wd}; __PV_D=removed; ` +
			`elif [ -e ${wd} ] || [ -L ${wd} ]; then __PV_D=left; else __PV_D=absent; fi; `
		: `__PV_D=left; `
	return (
		`exec 3>&1 1>&2; ` +
		// refused before any action unless this call's nonce came on stdin
		nonceReadShell('__PV_N', 'preview removal') +
		`__PV_D=left; __PV_C=unknown; ` +
		`{ ${act}} 3>&-; ` +
		`if __PV_O=$(docker ps -aq --filter ${shq(`label=com.docker.compose.project=${name}`)} 2>/dev/null 3>&-); then __PV_C=$(printf '%s' "$__PV_O" | grep -c . || true); fi; ` +
		`printf '__PV_%s__ dir=%s containers=%s\\n' "$__PV_N" "$__PV_D" "$__PV_C" >&3; true`
	)
}

export interface PreviewDirStatus {
	dir: 'removed' | 'left' | 'absent'
	/** containers of the preview's compose project still there afterwards; null = unknown */
	containers: number | null
}

/** The outcome of previewDirRemoveShell run with `nonce`: stdout must be exactly that
 *  one line, else null: the removal did not run or did not answer, so nothing is known
 *  about the dir. Pure. */
export function parsePreviewDirStatus(stdout: string, nonce: string): PreviewDirStatus | null {
	const only = stdout.replace(/\n$/, '')
	const m =
		/^[0-9a-f]{32}$/.test(nonce) && !only.includes('\n')
			? only.match(new RegExp(`^__PV_${nonce}__ dir=(removed|left|absent) containers=(\\d{1,5}|unknown)$`))
			: null
	if (!m) return null
	return { dir: m[1] as PreviewDirStatus['dir'], containers: m[2] === 'unknown' ? null : Number(m[2]) }
}

/** What the page says after a preview's removal; null when nothing is left. Pure. */
export function previewRemovalNote(name: string, workingDir: string, st: PreviewDirStatus | null): string | null {
	if (!st) return previewRemovalUnknownNote(workingDir)
	const list = `docker ps -a --filter label=com.docker.compose.project=${name}`
	const n = st.containers
	const ctr = n === 1 ? '1 container' : `${n} containers`
	const uncounted = `powder could not count the containers of project ${name}; check by hand: ${list}`
	if (st.dir === 'removed') {
		if (n === 0) return null
		if (n === null) return uncounted
		return `${ctr} of project ${name} ${n === 1 ? 'is' : 'are'} still there after the teardown: remove ${n === 1 ? 'it' : 'them'} by hand (${list})`
	}
	if (st.dir === 'absent') {
		if (n === 0) return null
		if (n === null) return `no directory at ${workingDir}; ${uncounted}`
		return `no directory at ${workingDir}; ${ctr} of project ${name} ${n === 1 ? 'was' : 'were'} left: powder cannot prove ${n === 1 ? 'it is' : 'they are'} this preview's, so remove ${n === 1 ? 'it' : 'them'} by hand if not needed (${list})`
	}
	const left = previewDirLeftNote(workingDir)
	if (n === 0) return left
	if (n === null) return `${left}. ${uncounted}`
	return `${left}. ${ctr} of project ${name} ${n === 1 ? 'was' : 'were'} left too and may still serve the preview's address: stop and remove ${n === 1 ? 'it' : 'them'} by hand if not needed (${list})`
}

/** What the page says when the removal did not run or did not answer. */
export function previewRemovalUnknownNote(workingDir: string): string {
	return `the removal did not run or did not answer: nothing is known about ${workingDir} or the preview's containers; check the server`
}

/** What the page says about a preview dir powder left in place. */
export function previewDirLeftNote(workingDir: string): string {
	return `left ${workingDir} in place: powder cannot prove it created it; remove it by hand if it is not needed`
}

/** Run the preview's removal script; the note for the page (null when nothing is
 *  left). */
async function removePreviewDir(
	server: ServerConfig,
	name: string,
	workingDir: string,
	previewId: string,
	siblings: boolean,
	/** also /opt/apps/<name>.env, only once the dir was proven this preview's and removed */
	envFile = false,
): Promise<string | null> {
	const nonce = cloneNonce()
	const r = await runCommand(server, previewDirRemoveShell(name, workingDir, previewId, { siblings }), 60_000, undefined, {
		stdin: `${nonce}\n`,
	})
	const st = parsePreviewDirStatus(r.stdout, nonce)
	if (st?.dir === 'removed' && envFile) await runCommand(server, `rm -f ${shq(`/opt/apps/${name}.env`)}`, 10_000).catch(() => {})
	return previewRemovalNote(name, workingDir, st)
}

/** An existing preview row about to be cloned again: the same name checks as a new
 *  row (no app of that name on the server, no other preview row), and its directory
 *  is either absent or this row's own marked clone. Throws PreviewNameCollisionError. */
async function assertFirstSpinFree(
	server: ServerConfig,
	serverId: string,
	previewId: string,
	name: string,
	workingDir: string,
): Promise<void> {
	const apps = await db.select({ containerName: appRepos.containerName }).from(appRepos).where(eq(appRepos.serverId, serverId))
	const previews = await db.select({ id: previewDeploys.id, containerName: previewDeploys.containerName }).from(previewDeploys)
	if (apps.some((a) => a.containerName === name))
		throw new PreviewNameCollisionError(
			`preview name "${name}" is now an app's name; the preview was not set up again and nothing on the server was touched. Delete this preview in powder: its teardown leaves ${workingDir} (the app's) in place, nothing else to do.`,
		)
	if (previews.some((p) => p.id !== previewId && p.containerName === name))
		throw new PreviewNameCollisionError(`preview name "${name}" collides with another preview`)
	const r = await runCommand(
		server,
		`if { [ -e ${shq(workingDir)} ] || [ -L ${shq(workingDir)} ]; } && ! ${cloneMarkerMatchShell(workingDir, previewClonePurpose(previewId))}; then echo foreign; else echo ok; fi`,
		5_000,
	)
	if (r.stdout.trim() !== 'ok')
		throw new PreviewNameCollisionError(
			`${workingDir} exists on the server and is not this preview's own clone; the preview was not set up again and ${workingDir} was not touched. If nothing needs ${workingDir}, move it away by hand on the server and push the branch again; if something else uses it, delete this preview in powder (its teardown leaves ${workingDir} in place).`,
		)
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
	/** the commit the spin built (nonced marker), null when unknown */
	builtSha: string | null
	/** the test gate's outcome from the nonced mark (as deploys.test_gate) */
	testGate: TestGate | null
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
	// true once THIS spin's clone is in place at workingDir: the only case in which a
	// failed first spin removes anything (a refused or failed clone never placed it)
	let placedByThisSpin = false
	try {
		if (!isFirstSpin) {
			const have = await runCommand(server, `[ -f ${shq(composeFilePath)} ] && echo ok || echo missing`, 5_000)
			isFirstSpin = have.stdout.trim() !== 'ok'
		}
		if (isFirstSpin) {
			// An existing row treated as new (a failed first spin, a missing compose):
			// the name and directory checks run again, as for a new row. An app may have
			// taken the name since; the row's own directory passes only with its marker.
			if (existing) await assertFirstSpinFree(server, repo.serverId, previewId, name, workingDir)
			// 1) Plant the parent's deploy key in /tmp, clone the branch, then move
			//    key into the working dir for future pulls. The clone replaces an existing
			//    dir only when its marker says powder cloned it for this preview row.
			keyPlanted = true
			await writeFileSecret(server, tmpKey, decryptDeployKey(repo))
			try {
				await gitCloneRepo(server, workingDir, repo.repoUrl, branch, tmpKey, previewClonePurpose(previewId))
			} catch (err) {
				if (err instanceof CloneError && err.placed) placedByThisSpin = true
				throw err
			}
			placedByThisSpin = true
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
			traefikNetwork: await resolveRoutingNetwork(server),
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
		const { output, sha: builtSha, testGate } = await rebuildDeploy(
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

		return { previewId, containerName: name, url, deployOutput: output, builtSha, testGate: testGate ?? null }
	} catch (err) {
		// already cleaned up above
		if (err instanceof PreviewParentGoneError) throw err
		const msg = err instanceof Error ? err.message : 'unknown error'
		await db
			.update(previewDeploys)
			.set({ status: 'failed', lastError: msg })
			.where(eq(previewDeploys.id, previewId))
		// a failed FIRST spin leaves no checkout behind, but it removes only what THIS
		// spin created: nothing at all when its clone was refused, failed or never ran
		// (the directory there, and any containers of that name, are not this spin's).
		// Then the dir only by its marker (no pre-marker rule here), and never when the
		// name is a registered app's.
		if (isFirstSpin && placedByThisSpin) {
			const aliased = (
				await db
					.select({ n: appRepos.containerName })
					.from(appRepos)
					.where(eq(appRepos.serverId, repo.serverId))
					.catch(() => [{ n: name }])
			).some((r) => r.n === name)
			if (!aliased)
				await removePreviewDir(server, name, workingDir, previewId, false).catch(() => null)
		}
		throw err
	} finally {
		// The planted key copy never outlives the spin (clone failure, install
		// failure or success: after a success it was already moved, rm -f is a no-op).
		await runCommand(server, `rm -f ${shq(composeTmp)}${keyPlanted ? ` ${shq(tmpKey)}` : ''}`, 5_000).catch(() => {})
	}
}

/** A preview whose app is gone: its containers and checkout (never when the name is
 *  a registered app's, like tearDownPreview; the dir only by its marker) and its row.
 *  The parent row may be gone, so the server comes from the caller, not from
 *  tearDownPreview's lookup through the app. */
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
	if (!aliased) await removePreviewDir(server, name, workingDir, previewId, true).catch(() => null)
	await db.delete(previewDeploys).where(eq(previewDeploys.id, previewId))
}

/** Tear a preview down: its containers, its dir and this row's marked copies next to
 *  it (only by marker), and its row. `note` says when the dir was left in place
 *  (unmarked, or marked for another owner): the page shows it. */
export async function tearDownPreview(previewId: string): Promise<{ note: string | null }> {
	const [preview] = await db
		.select()
		.from(previewDeploys)
		.where(eq(previewDeploys.id, previewId))
	if (!preview) return { note: null }

	// Find the parent app_repo to resolve which server it lives on.
	const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, preview.appRepoId))
	if (!repo) {
		await db.delete(previewDeploys).where(eq(previewDeploys.id, previewId))
		return { note: null }
	}
	const server = await getServer(repo.serverId)
	// Never touch a directory that belongs to a registered app (a preview
	// row named `<parent>-<slug>` could alias another app).
	const aliased = (
		await db
			.select({ n: appRepos.containerName })
			.from(appRepos)
			.where(eq(appRepos.serverId, repo.serverId))
	).some((r) => r.n === preview.containerName)
	let note: string | null = aliased ? `left ${preview.workingDir} in place: it is the app ${preview.containerName}'s directory` : null
	if (server && !aliased) {
		note = await removePreviewDir(server, preview.containerName, preview.workingDir, preview.id, true, true).catch(
			() => previewRemovalUnknownNote(preview.workingDir),
		)
	}
	await db.delete(previewDeploys).where(eq(previewDeploys.id, previewId))
	return { note }
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
	/** The network powder routes over on the server (resolveRoutingNetwork). Absent or
	 *  `web`: the compose is exactly what it always was. Another network: the preview
	 *  joins it instead of `web`, with traefik.docker.network, since a preview is on
	 *  two networks (that one and its own default) and Traefik must pick the right one. */
	traefikNetwork?: string
}): string {
	const envFileBlock = opts.envFiles.map((p) => `      - ${p}`).join('\n')
	const net = assertDockerNetworkName(opts.traefikNetwork ?? DEFAULT_TRAEFIK_NETWORK)
	// branch code never joins the shared `internal` network (see the header)
	if (net === 'internal') throw new Error('previews refused: this server\'s Traefik routes over the shared internal network, which a preview must not join')
	const netLabel = net !== DEFAULT_TRAEFIK_NETWORK ? `      - traefik.docker.network=${net}\n` : ''
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
${netLabel}      - traefik.http.routers.${opts.name}.rule=Host(\`${opts.host}\`)
      - traefik.http.routers.${opts.name}.entrypoints=websecure
      - ${traefikRouterTlsLabel(opts.name, opts.tlsMode)}
      - traefik.http.services.${opts.name}.loadbalancer.server.port=${opts.containerPort}
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.path=${healthPathFor(opts.healthUrl)}
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.interval=10s
      - traefik.http.services.${opts.name}.loadbalancer.healthcheck.timeout=3s
      - traefik.http.middlewares.${opts.name}-diag.headers.customresponseheaders.X-Powder-App=${opts.name}
      - traefik.http.middlewares.${opts.name}-diag.headers.customresponseheaders.X-Powder-Preview=true
${drainActiveFor(opts.name) ? traefikRetryLabels(opts.name).labels.map((l) => `      - ${l}\n`).join('') : ''}      - traefik.http.routers.${opts.name}.middlewares=${opts.name}-diag${drainActiveFor(opts.name) ? `,${traefikRetryLabels(opts.name).middleware}` : ''}
    networks:
      - ${net}
      - default

networks:
  ${net}:
    external: true
`
}

