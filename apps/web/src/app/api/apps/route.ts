import type { NextRequest } from 'next/server'
import { requireServerForUser, requireUser } from '@/lib/access'
import { envKeyWriteDenied, isAdminSession } from '@/lib/env-key-policy'
import { NO_BASE_DOMAIN_MESSAGE, defaultHostFor } from '@/lib/app-hosts'
import { isTraefikServer } from '@/lib/traefik-servers'
import { runInWeb } from '@/lib/deploy-runner'
import { DeployInFlightError, deployWorkerEnabled, startDeploy } from '@/lib/deploys'
import { notifyDeploymentStarted } from '@/lib/github-deployments'
import {
	commitFile,
	createDeployKey,
	createWebhook,
	getRepoFile,
	getRepoInfo,
	repoHasDockerfile,
} from '@/lib/github'
import { detectFromPackageJson, detectPackageManager, dockerfileFor } from '@/lib/framework-detect'
import { getGithubIntegration } from '@/lib/integrations'
import { generateDeployKey } from '@/lib/keygen'
import { checkComposeSafe, validateAppInputs } from '@/lib/compose-guard'
import { renderComposeYaml } from '@/lib/compose-render'
import { createNetworkCommand } from '@/lib/server-bootstrap'
import { resolveRoutingNetwork } from '@/lib/traefik-network-run'
import { reservedAppNameError } from '@/lib/app-names'
import { envVarInputError, serializeEnv } from '@/lib/env-parse'
import { writeRuntimeFilesShell } from '@/lib/app-runtime-files'
import { randomTempPath } from '@/lib/temp-path'
import { cloneMarkerMatchShell } from '@/lib/clone-marker'
import { CloneError } from '@/lib/ssh/git'
import { ServerGoneError, createRepo, previewNameProblem, projectNameProblem, setRepoGithubIds } from '@/lib/repos'
import {
	gitCloneRepo,
	listContainers,
	runCommand,
	writeEnvFile,
	writeFileSecret,
	writeFileViaSftp,
} from '@/lib/ssh'
import { shq } from '@/lib/shell'
import { dashboardUrl, webhookConfigError, webhookUrl as buildWebhookUrl } from '@/lib/hosts'
import { AGENTS_MD_COMMIT_MESSAGE, AGENTS_MD_PATH, renderAgentsMd } from '@/lib/agents-md'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// `pv-` is reserved for preview deploys.
const NAME_RE = /^(?!pv-)[a-z][a-z0-9-]{1,30}$/

interface Body {
	serverId?: string
	repoFullName?: string
	branch?: string
	name?: string
	dockerfilePath?: string
	containerPort?: number
	envVars?: { key: string; value: string }[]
	addPostgres?: boolean
	addKv?: boolean
	/** Opt-in: also join the server's shared `internal` network (renderComposeYaml sharedInternal). */
	sharedInternal?: boolean
	/** Opt-in: commit an AGENTS.md describing the deploy when the repo has none. */
	addAgentsMd?: boolean
}

export async function POST(req: NextRequest) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const user = userOrResp

	// Refuse before touching GitHub: a webhook needs this install's own base URL.
	const hookConfig = webhookConfigError()
	if (hookConfig) return Response.json({ error: hookConfig }, { status: 503 })

	const gh = await getGithubIntegration(user.id)
	if (!gh) {
		return Response.json({ error: 'github not connected — visit /integrations' }, { status: 400 })
	}

	const body = (await req.json()) as Body
	if (!body.serverId) return Response.json({ error: 'serverId required' }, { status: 400 })
	if (!body.repoFullName) return Response.json({ error: 'repoFullName required' }, { status: 400 })
	if (!body.name || !NAME_RE.test(body.name)) {
		return Response.json(
			{ error: 'invalid name: lowercase, digits, hyphens, 2–31 chars, must start with a letter' },
			{ status: 400 },
		)
	}
	const reserved = reservedAppNameError(body.name)
	if (reserved) return Response.json({ error: reserved }, { status: 400 })
	const [owner, repoName] = body.repoFullName.split('/')
	if (!owner || !repoName) {
		return Response.json({ error: 'expected owner/repo format' }, { status: 400 })
	}

	const serverCheck = await requireServerForUser(body.serverId)
	if (serverCheck instanceof Response) return serverCheck
	const server = serverCheck
	// no compose project name another app on the server (or powder) has.
	const clash = (await projectNameProblem(body.serverId, body.name)) ?? (await previewNameProblem(body.name))
	if (clash) return Response.json({ error: clash }, { status: 400 })
	if (server.kind !== 'compose') {
		return Response.json({ error: 'only compose servers supported in v1' }, { status: 400 })
	}

	const name = body.name
	const branch = body.branch ?? 'main'
	const inputs = validateAppInputs({
		dockerfilePath: body.dockerfilePath,
		containerPort: body.containerPort,
	})
	if (!inputs.ok) return Response.json({ error: inputs.error }, { status: 400 })
	const { dockerfilePath, containerPort } = inputs
	// L-4: keys and values land in a server-side env file, so a newline in either
	// would add lines to it. Same key rule as the DB writes (KEY_RE, 200 chars).
	if (!Array.isArray(body.envVars ?? [])) {
		return Response.json({ error: 'envVars must be a list' }, { status: 400 })
	}
	const envVars = [...(body.envVars ?? [])]
	for (const e of envVars) {
		const err = envVarInputError(e)
		if (err) return Response.json({ error: err }, { status: 400 })
		// same loader-key policy as every other env write.
		const denied = envKeyWriteDenied(e.key, e.value, isAdminSession(user), user.viaToken === true ? 'token' : 'session')
		if (denied) return Response.json({ error: denied }, { status: 403 })
	}
	const addPostgres = body.addPostgres === true
	const workingDir = `/opt/apps/${name}`
	const envFilePath = `/opt/apps/${name}.env`
	const composeFilePath = `${workingDir}/docker-compose.yml`

	const addKv = body.addKv === true
	const sharedInternal = body.sharedInternal === true
	const addAgentsMd = body.addAgentsMd === true
	let dbPassword: string | null = null
	if (addPostgres) {
		dbPassword = randomPassword(24)
		// inject DATABASE_URL so the app can read it without extra wiring.
		// `db` resolves on the per-app docker network created in the compose file.
		envVars.push({
			key: 'DATABASE_URL',
			value: `postgres://app:${dbPassword}@db:5432/app`,
		})
	}
	if (addKv) {
		// per-app redis sibling, no auth — accessible only on the per-app docker
		// network. Same pattern as postgres.
		envVars.push({ key: 'REDIS_URL', value: 'redis://kv:6379' })
	}

	const containers = await listContainers(server)
	if (containers.some((c) => c.name === name)) {
		return Response.json({ error: `container "${name}" already exists` }, { status: 400 })
	}
	// the env file too. An existing /opt/apps/<name>.env belongs to
	// something else (an infra stack, an app removed by hand) and would be
	// overwritten by this app's env.
	const dirCheck = await runCommand(
		server,
		`if [ -e ${shq(workingDir)} ]; then echo exists; elif [ -e ${shq(envFilePath)} ]; then echo env-exists; else echo ok; fi`,
		5_000,
	)
	if (dirCheck.stdout.trim() === 'exists') {
		return Response.json({ error: `${workingDir} already exists on the server` }, { status: 400 })
	}
	if (dirCheck.stdout.trim() === 'env-exists') {
		return Response.json(
			{ error: `${envFilePath} already exists on the server; pick another name` },
			{ status: 400 },
		)
	}

	// host port only needed on nginx servers (host nginx terminates TLS).
	// Traefik servers route via labels, no host port binding.
	const onTraefik = await isTraefikServer(body.serverId)
	const hostPort = onTraefik ? null : await pickFreeHostPort(server)
	if (!onTraefik && !hostPort) {
		return Response.json({ error: 'no free host port in 3100–3299' }, { status: 500 })
	}
	// Traefik server: default host from servers.base_domain; none = no labels, the
	// user attaches a custom domain (response carries a note).
	const publicHost = onTraefik ? defaultHostFor(server, name) : null
	const publicUrl = publicHost ? `https://${publicHost}` : null
	// The network the app joins for Traefik: on a Traefik server the one its Traefik is
	// declared to route over (flag or config, traefik-network.ts), else `web`.
	const traefikNetwork = onTraefik ? await resolveRoutingNetwork(server) : 'web'

	// Render + parse-check BEFORE any side effect (deploy key, clone).
	const unsafe = checkComposeSafe(
		renderComposeYaml({
			name,
			dockerfilePath,
			hostPort,
			containerPort,
			envFilePath,
			publicHost,
			tlsMode: server.tlsMode,
			traefik: onTraefik,
			postgres: dbPassword ? { password: dbPassword, dataDir: `${workingDir}/pgdata` } : null,
			kv: addKv ? { dataDir: `${workingDir}/kvdata` } : null,
			sharedInternal,
			traefikNetwork,
		}),
		name,
		// the template's own Traefik network counts as shared on this server only
		traefikNetwork !== 'web' ? { traefikNetwork } : {},
	)
	if (unsafe) return Response.json({ error: `unsafe compose: ${unsafe}` }, { status: 400 })

	// The compose joins the Traefik network (`web` unless the server's Traefik routes
	// over another) and `internal` on opt-in as external networks, and compose refuses
	// to start without them. Create a missing one now, before any other side effect,
	// with the server bootstrap's own command (createNetworkCommand), so a server that
	// only had adopted apps needs no setup step for its first new app.
	for (const net of [...new Set([traefikNetwork, ...(sharedInternal ? ['internal'] : [])])]) {
		const made = await runCommand(server, createNetworkCommand(net), 20_000)
		if (made.code !== 0) {
			return Response.json(
				{
					error: `could not create the docker network ${net} on the server: ${(made.stderr || made.stdout).trim().slice(0, 300) || `exit ${made.code}`}`,
				},
				{ status: 500 },
			)
		}
	}

	const { pub, priv } = await generateDeployKey()
	let ghKeyId: number | null = null
	try {
		ghKeyId = (await createDeployKey(gh.token, owner, repoName, `powder · ${name}`, pub, true)).id
	} catch (err) {
		return Response.json(
			{ error: `github deploy key failed: ${clientErrorMessage(err, String(err), 'apps')}` },
			{ status: 502 },
		)
	}

	const tmpKey = randomTempPath('/tmp/powder-deploy')
	try {
		await writeFileSecret(server, tmpKey, priv)
	} catch (err) {
		return Response.json(
			{ error: `couldn't plant deploy key on server: ${clientErrorMessage(err, String(err), 'apps')}` },
			{ status: 500 },
		)
	}

	// Opt-in (the /new checkbox, default off): commit an AGENTS.md that says how
	// this app deploys (lib/agents-md.ts). Only when the repo has none; never
	// overwrites one. Before the webhook exists, so the commit starts no deploy.
	if (addAgentsMd) {
		try {
			const existingAgents = await getRepoFile(gh.token, owner, repoName, AGENTS_MD_PATH, branch).catch(() => null)
			if (!existingAgents) {
				await commitFile(
					gh.token, owner, repoName, AGENTS_MD_PATH,
					renderAgentsMd({ branch, dashboardUrl: dashboardUrl() }),
					AGENTS_MD_COMMIT_MESSAGE,
					branch,
				)
			}
		} catch (err) {
			console.warn('[apps/POST] AGENTS.md commit skipped:', err)
		}
	}

	// /new does not commit a GitHub Actions build workflow: apps build on the
	// server, triggered by the native push webhook, so a deploy never depends on
	// CI or Actions minutes.

	// Auto-commit a Dockerfile to the user's repo if missing — without it the
	// first deploy fails with "open Dockerfile: no such file or directory" and
	// the project ends up in a zombie state (app_repo row, no container).
	// We do this BEFORE clone so the clone picks up the committed file.
	try {
		const hasDockerfile = await repoHasDockerfile(gh.token, owner, repoName, dockerfilePath, branch)
		if (!hasDockerfile) {
			const pkgText = await getRepoFile(gh.token, owner, repoName, 'package.json', branch).catch(() => null)
			if (pkgText) {
				const framework = detectFromPackageJson(pkgText)
				if (framework.id !== 'unknown') {
					const lockNames = ['bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'] as const
					const lockResults = await Promise.all(
						lockNames.map((n) => repoHasDockerfile(gh.token, owner, repoName, n, branch).catch(() => false)),
					)
					const lockfiles: Record<string, boolean> = {}
					lockNames.forEach((n, i) => { lockfiles[n] = lockResults[i] === true })
					const pm = detectPackageManager(lockfiles)
					const content = dockerfileFor(framework, pm, name)
					await commitFile(
						gh.token, owner, repoName, dockerfilePath, content,
						`chore: add Dockerfile (powder-generated for ${framework.displayName})`,
						branch,
					)
				}
			}
		}
	} catch (err) {
		// Don't block app creation on this — log and continue. If the Dockerfile
		// commit fails, the deploy will fail with a clear "no such file" error
		// which is at least an actionable user-facing message.
		console.warn('[apps/POST] Dockerfile auto-commit skipped:', err)
	}

	try {
		const repoUrl = `git@github.com:${owner}/${repoName}.git`
		await gitCloneRepo(server, workingDir, repoUrl, branch, tmpKey, `app:${name}`)
	} catch (err) {
		// this request's clone was placed and then refused (the status line says so):
		// remove exactly that clone (its marker names app:<name>), so the name can be
		// retried; anything else at the path is not this request's and stays
		const placed = err instanceof CloneError && err.placed
		await runCommand(
			server,
			`rm -f ${shq(tmpKey)}${placed ? `; if ${cloneMarkerMatchShell(workingDir, `app:${name}`)}; then rm -rf -- ${shq(workingDir)}; fi` : ''}`,
			10_000,
		).catch(() => {})
		return Response.json(
			{ error: `clone failed: ${clientErrorMessage(err, String(err), 'apps')}` },
			{ status: 500 },
		)
	}

	if (envVars.length > 0) {
		await writeEnvFile(server, envFilePath, serializeEnv(envVars))
	} else {
		await runCommand(server, `touch ${shq(envFilePath)}`, 5_000)
	}

	const composeYaml = renderComposeYaml({
		name,
		dockerfilePath,
		hostPort,
		containerPort,
		envFilePath,
		publicHost,
		tlsMode: server.tlsMode,
		traefik: onTraefik,
		postgres: dbPassword ? { password: dbPassword, dataDir: `${workingDir}/pgdata` } : null,
		kv: addKv ? { dataDir: `${workingDir}/kvdata` } : null,
		sharedInternal,
		traefikNetwork,
	})
	// the compose carries POSTGRES_PASSWORD: ship it over SFTP (0600), not argv.
	const composeTmp = `${randomTempPath('/tmp/powder-compose')}.yml`
	await writeFileViaSftp(server, composeTmp, composeYaml, 0o600, 30_000, true, true)
	// key + compose + .dockerignore in one guarded step (symlink
	// refusal, tmp + mv -f). The repo is cloned into the workdir itself (workdir
	// layout), so repo-controlled symlinks must never be written through.
	const installed = await runCommand(
		server,
		writeRuntimeFilesShell({ workdir: workingDir, composeTmp, keyTmp: tmpKey, dockerfile: dockerfilePath }),
		20_000,
	)
	if (installed.code !== 0) {
		await runCommand(server, `if ${cloneMarkerMatchShell(workingDir, `app:${name}`)}; then rm -rf -- ${shq(workingDir)}; fi; rm -f ${shq(tmpKey)} ${shq(composeTmp)} ${shq(envFilePath)}`, 20_000).catch(() => {})
		return Response.json(
			{ error: `refused to set up the app directory: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}` },
			{ status: 400 },
		)
	}

	const repoUrl = `git@github.com:${owner}/${repoName}.git`
	// The server row is share-locked while the app row goes in (lib/repos.ts): a server
	// deleted meanwhile answers 404 and leaves no app pointing at it.
	let created: Awaited<ReturnType<typeof createRepo>>
	try {
		created = await createRepo({
			serverId: body.serverId,
			containerName: name,
			repoUrl,
			branch,
			pub,
			priv,
			hasPostgres: addPostgres,
			hasKv: addKv,
			ownerUserId: user.id,
			// /new scaffolds a compose with a build: key; declare the mode so the
			// deploy preflight enforces it instead of inferring.
			buildMode: 'build',
			// previews build and route like the app (lib/preview-deploys.ts previewBuildInputs)
			dockerfilePath,
			containerPort,
		})
	} catch (err) {
		if (err instanceof ServerGoneError) return Response.json({ error: err.message }, { status: 404 })
		throw err
	}
	const { row, webhookSecret } = created

	const webhookUrl = publicWebhookUrl(req, row.webhookToken)
	let webhookOk = true
	let hookId: number | null = null
	try {
		hookId = (await createWebhook(gh.token, owner, repoName, webhookUrl, webhookSecret)).id
	} catch {
		webhookOk = false
	}
	// remember what was installed so disconnect can remove it.
	// and the repository id every push must keep naming.
	const repoId = await getRepoInfo(gh.token, owner, repoName).then((r) => r.id).catch(() => null)
	await setRepoGithubIds(row.id, { deployKeyId: ghKeyId, hookId, repoId })

	// NOTE: Actions secrets are not provisioned: there is no
	// committed workflow to read them (build-on-server via the native push
	// webhook installed above, no CI in the deploy path).
	const secretsOk = true

	// First deploy goes through the same execution authority as every other
	// deploy (executeDeploy: heartbeat, output flush, per-server lock, budget).
	// Worker mode: insert 'queued', the worker runs it. In-web mode: run it here.
	void (async () => {
		let deploy: Awaited<ReturnType<typeof startDeploy>>
		try {
			deploy = await startDeploy({
				serverId: server.id,
				containerName: name,
				kind: 'git_deploy',
				triggeredBy: `wizard:${user.email ?? user.id}`,
			})
		} catch (err) {
			// Race against a webhook firing the moment the app is created — should
			// be vanishingly rare but log instead of throwing into the IIFE void.
			if (err instanceof DeployInFlightError) {
				console.warn('[apps] first deploy skipped - already in flight:', name)
			} else {
				console.error('[apps] first deploy startDeploy failed:', err)
			}
			return
		}
		await notifyDeploymentStarted(row, deploy, branch)
		if (!deployWorkerEnabled()) runInWeb(deploy)
	})()

	return Response.json({
		ok: true,
		serverId: body.serverId,
		containerName: name,
		workingDir,
		composeFilePath,
		envFilePath,
		hostPort,
		publicUrl,
		...(onTraefik && !publicUrl ? { note: NO_BASE_DOMAIN_MESSAGE } : {}),
		webhookOk,
		secretsOk,
	})
}

// Split: always the public-site host, so new hooks match the installed ones (lib/hosts.ts).
function publicWebhookUrl(req: NextRequest, token: string): string {
	return buildWebhookUrl(token, req.headers)
}

function randomPassword(len: number): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	const bytes = new Uint8Array(len)
	crypto.getRandomValues(bytes)
	let out = ''
	for (let i = 0; i < len; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length]
	return out
}

async function pickFreeHostPort(
	server: {
		host: string
		user: string
		port: number
		id: string
		name: string
		kind: 'compose' | 'raw-docker'
	} | undefined,
): Promise<number | null> {
	if (!server) return null
	const { stdout } = await runCommand(
		server,
		`ss -tln 2>/dev/null | awk 'NR>1 {print $4}' | grep -oE '[0-9]+$' | sort -un`,
		5_000,
	)
	const used = new Set(stdout.split('\n').filter(Boolean).map(Number))
	for (let p = 3100; p < 3300; p++) {
		if (!used.has(p)) return p
	}
	return null
}

