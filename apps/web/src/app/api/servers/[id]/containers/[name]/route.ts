import { requireContainerAccess } from '@/lib/access'
import { keptOnServer, removeAppContainers } from '@/lib/app-lifecycle'
import { selfDeployNames } from '@/lib/compose-safety'
import {
	and,
	appDomains,
	appEnvVarVersions,
	appEnvVars,
	appRepos,
	appUptimeChecks,
	cronJobs,
	db,
	deploys,
	domainRedirects,
	eq,
	previewDeploys,
} from '@/lib/db'
import { archiveAppEnvFiles } from '@/lib/deleted-env'
import { finishDeploy, inlineProgress, tryStartDeploy } from '@/lib/deploys'
import { removeAppRedirects } from '@/lib/domain-redirects'
import { removeGithubObjects } from '@/lib/github-disconnect'
import { tearDownPreview } from '@/lib/preview-deploys'
import { appNamesOnServer, getRepoFor } from '@/lib/repos'
import { redactSecrets } from '@/lib/secret-text'
import { sessionOnlyActionDenied } from '@/lib/session-only'
import { deleteRemoteFile, inspectContainer } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Delete an app, in an order that keeps it retryable: nothing irreversible happens
// before its containers are gone. Under the 'delete' deploys row (the app's deploy
// lock: startDeploy and the webhook refuse new deploys and previews meanwhile):
//   1. inspect the app container; any failure other than "no such container" stops
//      here, nothing touched (no guessed compose project or working dir);
//   2. remove its containers on the server (lib/app-lifecycle.ts, by name and, when
//      no other app or preview shares the compose project name, by project label,
//      under the per-app flock). A failure stops here with every row and preview kept;
//   3. tear down its previews, then remove its domain redirects from the proxy (the
//      Traefik file redirects-<app>.yml, or the nginx redirect file per hostname):
//      left behind, Traefik keeps redirecting the old hostnames at priority 300,
//      above a later app given the same host. A failure stops here with every row
//      kept, so the delete never reports success while a redirect is still live;
//   4. what the repo disconnect does (DELETE .../repo: the deploy key file,
//      powder's GitHub deploy key and webhook);
//   5. one transaction: the rows below, and every queued deploy of the app is failed
//      (a push that slipped in before step 1);
//   6. archive the env files.
// Steps 2 to 4 are idempotent, so a delete that fails in 3 to 5 can be run again.
// The row heartbeat and output are written at every step (inlineProgress), so the
// watchdog never reads a long delete as silent and releases the app's lock early.
//
// Per-app state, what the delete does with it:
//   dropped (step 5): app_repos (notification_targets cascade), cron_jobs,
//     app_domains, domain_redirects (keyed by server + name: a later app with the
//     same name must not inherit them), app_uptime_checks, app_env_vars and
//     app_env_var_versions (the rendered env files are archived in step 6);
//   torn down (step 2, 3): preview containers and preview_deploys rows, the proxy
//     redirect files; the custom-domain routers are labels on the removed containers;
//   kept as history: deploys (this delete's row included), cron_runs, traffic stats,
//     app_env_var_audit (no values), app_backups and their restores (the backup
//     files stay restorable; an app added later under the same name lists them).
// Kept on the server: the app directory, volumes and bind-mounted data (keptOnServer).
//
// Admin browser session only: SESSION_ONLY in lib/session-only.ts (the proxy and
// access.ts refuse every bearer token) and the check below. The body must repeat the
// app name ({ confirm: "<name>" }), the typed confirmation of the UI.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server, user } = access
	const denied = sessionOnlyActionDenied('app_delete', user)
	if (denied) return denied

	let body: { confirm?: unknown }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return Response.json({ error: 'invalid body' }, { status: 400 })
	}
	if (!body || typeof body !== 'object' || body.confirm !== name) {
		return Response.json({ error: 'confirm must be the app name' }, { status: 400 })
	}

	// Only a registered app (a preview has its own delete: DELETE .../previews/[id]).
	const repo = await getRepoFor(id, name)
	if (!repo) return Response.json({ error: 'not an app (previews are deleted on the app page)' }, { status: 404 })

	const deployOrResp = await tryStartDeploy({
		serverId: id,
		containerName: name,
		kind: 'delete',
		triggeredBy: `manual:${user.email ?? user.id}`,
		inline: true,
	})
	if (deployOrResp instanceof Response) return deployOrResp
	const deploy = deployOrResp
	const progress = inlineProgress(deploy.id)

	try {
		await progress.step(`deleting ${name}: inspecting the container`)
		// A container that is already gone is fine: the rows still go. Any other inspect
		// failure (SSH, daemon) fails the delete: the project and working dir would be guesses.
		let detail: Awaited<ReturnType<typeof inspectContainer>> | null
		try {
			detail = await inspectContainer(server, name)
		} catch (err) {
			const msg = clientErrorMessage(err, String(err), 'servers/:id/containers/:name')
			if (!/no such (object|container)/i.test(msg)) throw new Error(`could not inspect ${name}, nothing removed: ${msg}`)
			detail = null
		}
		const workingDir = detail?.compose.workingDir || `/opt/apps/${name}`
		const service = detail?.compose.service || name

		const previews = await db
			.select({ id: previewDeploys.id, containerName: previewDeploys.containerName })
			.from(previewDeploys)
			.where(eq(previewDeploys.appRepoId, repo.id))
		const others = (await appNamesOnServer(id)).filter((n) => n !== name)
		const otherPreviews = await db
			.select({ n: previewDeploys.containerName })
			.from(previewDeploys)
			.innerJoin(appRepos, eq(previewDeploys.appRepoId, appRepos.id))
			.where(eq(appRepos.serverId, id))
		const self = selfDeployNames().container
		const removed = await removeAppContainers(server, {
			app: name,
			project: detail?.compose.project || null,
			workingDir,
			service,
			protectedNames: [
				...others,
				...otherPreviews.map((r) => r.n),
				'powder',
				'powder-worker',
				'powder-postgres',
				self,
				`${self}-worker`,
			],
		})
		await progress.step(removed.output || 'containers: none left')

		for (const p of previews) {
			await tearDownPreview(p.id)
			await progress.step(`preview ${p.containerName}: torn down`)
		}
		const redirects = await db
			.select({ hostname: domainRedirects.hostname, appliedAt: domainRedirects.appliedAt })
			.from(domainRedirects)
			.where(and(eq(domainRedirects.serverId, id), eq(domainRedirects.containerName, name)))
		const redirectNote = await removeAppRedirects(
			server,
			name,
			redirects.filter((r) => r.appliedAt !== null).map((r) => r.hostname),
		)
		if (redirectNote) await progress.step(redirectNote)
		await deleteRemoteFile(server, `${workingDir}/.deploy-key`).catch(() => {})
		const github = await removeGithubObjects(repo, user.id)
		await progress.step(`GitHub: deploy key ${github.deployKey}, webhook ${github.hook}`)
		const cancelled = await db.transaction(async (tx) => {
			await tx.delete(cronJobs).where(and(eq(cronJobs.serverId, id), eq(cronJobs.containerName, name)))
			await tx.delete(appDomains).where(eq(appDomains.appRepoId, repo.id))
			await tx
				.delete(domainRedirects)
				.where(and(eq(domainRedirects.serverId, id), eq(domainRedirects.containerName, name)))
			await tx.delete(appUptimeChecks).where(eq(appUptimeChecks.appRepoId, repo.id))
			await tx.delete(appEnvVars).where(eq(appEnvVars.appRepoId, repo.id))
			await tx.delete(appEnvVarVersions).where(eq(appEnvVarVersions.appRepoId, repo.id))
			await tx.delete(appRepos).where(eq(appRepos.id, repo.id))
			return tx
				.update(deploys)
				.set({ status: 'failed', error: 'app deleted', errorSummary: 'app deleted before this deploy ran', finishedAt: new Date() })
				.where(and(eq(deploys.serverId, id), eq(deploys.containerName, name), eq(deploys.status, 'queued')))
				.returning({ id: deploys.id })
		})
		await progress.step('rows: app, crons, domains, redirects, uptime check and env vars dropped')
		if (cancelled.length) await progress.step(`queued deploys cancelled: ${cancelled.map((c) => c.id).join(', ')}`)
		const envArchive = await archiveAppEnvFiles(server, name, others)
		await progress.step(`env files: ${envArchive.detail}`)

		const kept = keptOnServer(name, workingDir)
		await progress.step(`kept on the server: ${kept.join('; ')}`)
		await finishDeploy(deploy.id, { status: 'success', output: progress.lines.join('\n') })
		return Response.json({
			ok: true,
			deployId: deploy.id,
			removed: removed.removed,
			keptContainers: removed.kept,
			projectNote: removed.projectNote,
			previews: previews.length,
			github,
			envArchive,
			keptOnServer: kept,
		})
	} catch (err) {
		// The rows stay when a step before the transaction failed: the app is still
		// listed and the delete can be tried again (see the order above).
		const message = redactSecrets(clientErrorMessage(err, 'unknown error', 'servers/:id/containers/:name'))
		await finishDeploy(deploy.id, { status: 'failed', error: message, errorSummary: message, output: progress.lines.join('\n') })
		return Response.json({ error: message, deployId: deploy.id }, { status: 500 })
	} finally {
		progress.stop()
	}
}
