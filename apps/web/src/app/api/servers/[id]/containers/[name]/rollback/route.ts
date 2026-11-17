import { requireContainerAccess } from '@/lib/access'
import { isTraefikServer } from '@/lib/traefik-servers'
import { and, appRepos, db, deploys, eq } from '@/lib/db'
import { chunkPublisher, publishTerminal } from '@/lib/deploy-bus'
import { atomicRollback } from '@/lib/deploy-snapshots'
import { cancelHeldDeploys, finishDeploy, runHealthGate, tryStartDeploy } from '@/lib/deploys'
import {
	notifyDeploymentFinished,
	notifyDeploymentStarted,
} from '@/lib/github-deployments'
import { redactSecrets } from '@/lib/secret-text'
import { envFileCandidatesFor, inspectContainer, restoreEnvSnapshot, rollbackToImage } from '@/lib/ssh'
import { checkComposeForRecreate, owningAppFor, unregisteredApproval } from '@/lib/recreate-guard'
import { isAdminSession } from '@/lib/env-key-policy'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	// never powder's own containers (POWDER_SELF_CONTAINER).
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access
	// the env snapshot restore writes env values outside the token env rule (an older
	// snapshot can carry keys and values an admin has since removed), so only an admin
	// browser session restores it; a token rollback restores the image only.
	const restoreEnv = isAdminSession(access.user)
	if (server.kind !== 'compose') {
		return Response.json({ error: 'rollback needs a compose-style server' }, { status: 400 })
	}

	// a body that is not JSON was a 500, a non-string targetDeployId reached the query
	let body: { targetDeployId?: unknown }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return Response.json({ error: 'invalid body' }, { status: 400 })
	}
	if (!body || typeof body !== 'object' || typeof body.targetDeployId !== 'string' || !body.targetDeployId) {
		return Response.json({ error: 'targetDeployId required (string)' }, { status: 400 })
	}
	const targetDeployId = body.targetDeployId

	const [target] = await db.select().from(deploys).where(eq(deploys.id, targetDeployId))
	if (!target) return Response.json({ error: 'target deploy not found' }, { status: 404 })
	// Scope the target to THIS (server, container). Without this check a tenant
	// owning app A could roll it back to a different app's image tag — same
	// server, same access check passes, but powder would deploy the other
	// tenant's image into app A's compose slot. Return 404 to avoid revealing
	// that the deploy exists on a sibling container.
	if (target.serverId !== id || target.containerName !== name) {
		return Response.json({ error: 'target deploy not found' }, { status: 404 })
	}
	if (!target.imageTag) {
		return Response.json(
			{
				error:
					'target deploy has no tagged image — only deploys made after image tagging shipped can be rolled back to',
			},
			{ status: 400 },
		)
	}
	const imageTag = target.imageTag

	const detail = await inspectContainer(server, name)
	const { configFile, service, configFiles, workingDir } = detail.compose
	if (!configFile || !service) {
		return Response.json(
			{ error: 'container has no compose config or service labels' },
			{ status: 400 },
		)
	}

	// inline: this route runs the rollback itself. Without it (worker mode) the
	// worker claimed the 'queued' row and ran a full HEAD rebuild concurrently —
	// which UNDID the rollback it was racing.
	const deployOrResp = await tryStartDeploy({
		serverId: id,
		containerName: name,
		kind: 'rollback',
		inline: true,
	})
	if (deployOrResp instanceof Response) return deployOrResp
	const deploy = deployOrResp

	// A push held on the settle window (lib/deploy-settle.ts) would deploy the code being
	// rolled back away from right after this rollback, without a human. Cancel it now that
	// this rollback's running row holds the app (the worker cannot claim it meanwhile).
	const cancelled = await cancelHeldDeploys(id, name, { id: deploy.id, kind: 'rollback' }).catch((err) => {
		console.error(`[rollback] ${name}: could not cancel held deploys:`, err)
		return [] as string[]
	})
	const cancelNote = cancelled.length
		? `[settle] cancelled the held push deploy ${cancelled.join(', ')} so it does not redeploy over this rollback; push again or redeploy to ship it\n`
		: ''

	// Pre-fetch app_repo for GH deploy status. A rollback is a deployment
	// of a previous SHA — surface it as such on the commit.
	const [repoForGh] = await db
		.select()
		.from(appRepos)
		.where(and(eq(appRepos.serverId, id), eq(appRepos.containerName, name)))
	if (repoForGh) {
		await notifyDeploymentStarted(repoForGh, deploy, target.gitSha ?? repoForGh.branch)
	}

	void (async () => {
		// Every streamed line and stored text is masked (lib/secret-text.ts).
		const stream = chunkPublisher(deploy.id)
		if (cancelNote) stream.chunk(cancelNote)
		try {
			let output: string
			if (await isTraefikServer(id)) {
				// Atomic path — bridges the recreate gap with a priority=200 sibling
				// so traffic stays continuous (~5s overlap, no downtime).
				const [repoForRollback] = await db
					.select()
					.from(appRepos)
					.where(and(eq(appRepos.serverId, id), eq(appRepos.containerName, name)))
				if (!repoForRollback) throw new Error('no app_repos row')
				stream.chunk('── atomic rollback (Traefik server) ──\n')
				const result = await atomicRollback(target, repoForRollback, { configFile, service, composeFiles: configFiles, workingDir: workingDir || undefined })
				output = result.output
				stream.chunk(output)
			} else {
				const chunk = (data: string) => {
					stream.chunk(data)
				}
				// Restore the env this image last ran with (when the target deploy
				// snapshotted one) — otherwise the old code starts on the NEW env,
				// and an env-caused breakage "rolls back" into the same breakage.
				let envOut = ''
				try {
					if (!restoreEnv)
						envOut =
							'[env] not restoring the env snapshot: a token rollback restores the image only and keeps the current env file (an admin session restores the env this image last ran with)\n'
					else {
						const envPath = (await envFileCandidatesFor(server, name))[0]
						if (envPath) envOut = (await restoreEnvSnapshot(server, envPath, target.id)).output
					}
				} catch (err) {
					envOut = `[env] could not restore the env snapshot (${clientErrorMessage(err, String(err), 'servers/:id/containers/:name/rollback')}), rolling back with the current env\n`
				}
				if (envOut) chunk(envOut)
				const rbWorkingDir = workingDir || configFile.replace(/\/[^/]*$/, "")
				// the deploy's compose guard on the compose on disk, after the env restore.
				const owner = await owningAppFor(id, name, detail.compose.project)
				const approval = owner
					? await checkComposeForRecreate(server, { app: owner, configFile, composeFiles: configFiles, workingDir: rbWorkingDir, what: 'rollback' })
					: unregisteredApproval(name)
				const result = await rollbackToImage(server, configFile, service, imageTag, detail.image, chunk, {
					composeFiles: configFiles,
					// the project-name check needs the app name; only an app_repos row gives it.
					...(owner ? { app: owner } : {}),
					workingDir: rbWorkingDir,
					approval,
				})
				output = envOut + result.output
				// A rollback is done when the old version actually SERVES: the same
				// gate as a deploy. A recreate alone says nothing about whether the
				// app answers, so success is reported only after the health gate.
				chunk('\n── post-rollback health check ──\n')
				const gate = await runHealthGate({ server, serverId: id, containerName: name, onChunk: chunk })
				output += `\n── post-rollback health check ──\n${gate.output}`
				if (gate.healthy === false) {
					throw Object.assign(new Error('rolled back, but the rolled-back version is UNHEALTHY — the app needs a manual fix'), {
						rollbackOutput: output,
					})
				}
			}
			stream.flush()
			await finishDeploy(deploy.id, { status: 'success', output: cancelNote + output })
			await db
				.update(deploys)
				.set({
					imageTag: target.imageTag,
					gitSha: target.gitSha,
					gitBranch: target.gitBranch,
					rolledBackFromId: target.id,
				})
				.where(eq(deploys.id, deploy.id))
			publishTerminal(deploy.id, 'end', 'success')
			if (repoForGh) {
				await notifyDeploymentFinished(
					repoForGh,
					deploy.id,
					'success',
					redactSecrets(target.gitSha ? `rolled back to ${target.gitSha.slice(0, 7)}` : 'rolled back'),
				)
			}
		} catch (err) {
			const message = redactSecrets(clientErrorMessage(err, 'unknown error', 'servers/:id/containers/:name/rollback'))
			const partial = (err as { rollbackOutput?: string } | null)?.rollbackOutput
			stream.flush()
			await finishDeploy(deploy.id, {
				status: 'failed',
				error: message,
				errorSummary: message,
				output: cancelNote ? cancelNote + (partial ?? '') : partial,
			})
			publishTerminal(deploy.id, 'error', message)
			if (repoForGh) {
				await notifyDeploymentFinished(repoForGh, deploy.id, 'failure', message)
			}
		}
	})()

	return Response.json(
		{ deployId: deploy.id, rolledBackFrom: target.id, ...(cancelled.length ? { cancelledHeldDeploys: cancelled } : {}) },
		{ status: 202 },
	)
}
