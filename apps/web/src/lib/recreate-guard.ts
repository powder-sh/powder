// the compose guard for every recreate OUTSIDE a deploy (manual apply, domain
// apply, rollback, auto-rollback, snapshot rollback). The on-server link guards
// (onServerComposeGuardShell) alone are not enough: without the rules (composeViolations) a
// compose a deploy had refused (left on disk in the workdir layout, or with no base commit
// to reset to) would come up on the next apply, domain add or rollback.
//
// One authority: this runs the SAME decision as the deploy (checkComposeForDeploy, its
// probe, mode and exemptions), with "previous approved hash" = the compose_config_hash
// of the app's last successful deploy:
//   - enforce mode: any finding refuses the recreate (as it refuses a deploy);
//   - warn mode, structural hash equal to the approved one: warn lines only, recreate;
//   - warn mode, hash differs: the high-severity codes refuse the recreate;
//   - warn mode, no approved hash (no successful deploy recorded one yet): warn lines
//     only, exactly what the deploy does then.
// The result pins the full config hash the check saw; composeUpCommand refuses the `up`
// when the config moved between this check and the recreate.

import { and, appRepos, db, eq, previewDeploys } from './db'
import { ComposeGuardError, checkComposeForDeploy } from './deploy/compose-check'
import { type ComposeView, parseComposeView } from './deploy/compose-diff'
import { type RecreateApproval, composeFileArgs } from './deploy/fragments'
import type { ServerConfig } from './servers'

export type { RecreateApproval } from './deploy/fragments'

/** the preview_deploys row of a preview container on this server (joined to its
 *  parent app), or null. */
async function previewByName(
	serverId: string,
	containerName: string,
): Promise<{ id: string; url: string | null; containerName: string; appRepoId: string; parentName: string } | null> {
	const [row] = await db
		.select({
			id: previewDeploys.id,
			url: previewDeploys.url,
			containerName: previewDeploys.containerName,
			appRepoId: previewDeploys.appRepoId,
			parentName: appRepos.containerName,
		})
		.from(previewDeploys)
		.innerJoin(appRepos, eq(previewDeploys.appRepoId, appRepos.id))
		.where(and(eq(appRepos.serverId, serverId), eq(previewDeploys.containerName, containerName)))
		.limit(1)
	return row ?? null
}

/** The registered app a container belongs to: its own app_repos row, else the
 *  app whose compose project the container is in (a sidecar such as `<app>-worker`),
 *  else a preview: by its own name when the container's project is the preview's own
 *  (or unknown), else the preview whose compose project it is in. An old-style preview
 *  named `<parent>-worker` never claims the parent's real sidecar of that name: the
 *  container's compose project label decides first. null = no app. */
export async function owningAppFor(
	serverId: string,
	containerName: string,
	composeProject: string | null | undefined,
): Promise<string | null> {
	const rows = await db
		.select({ name: appRepos.containerName })
		.from(appRepos)
		.where(eq(appRepos.serverId, serverId))
	const names = rows.map((r) => r.name)
	if (names.includes(containerName)) return containerName
	const { composeProjectNameFor } = await import('./compose-safety')
	if (composeProject) {
		const app = names.find((n) => composeProjectNameFor(n) === composeProject)
		if (app) return app
	}
	const previews = await db
		.select({ name: previewDeploys.containerName })
		.from(previewDeploys)
		.innerJoin(appRepos, eq(previewDeploys.appRepoId, appRepos.id))
		.where(eq(appRepos.serverId, serverId))
	const pnames = previews.map((r) => r.name)
	if (pnames.includes(containerName) && (!composeProject || composeProject === composeProjectNameFor(containerName))) return containerName
	if (composeProject) {
		const pv = pnames.find((n) => composeProjectNameFor(n) === composeProject)
		if (pv) return pv
	}
	// a preview's name in a project no app or preview owns: checked as that preview
	return pnames.includes(containerName) ? containerName : null
}

/** Approval for a container that is not a registered app (no app_repos row, no app owns
 *  its compose project): powder never deploys it, so there is no deploy decision to
 *  repeat; the on-server link guards still run in composeUpCommand. */
export function unregisteredApproval(containerName: string): RecreateApproval {
	return {
		hash: '',
		app: null,
		log: `[compose-guard] ${containerName.replace(/[^A-Za-z0-9._-]/g, '_')} is not a registered powder app: recreating without the deploy check\n`,
	}
}

/**
 * Run the deploy's compose guard against the compose on disk before a recreate.
 * Throws an Error (no __POWDER_FAIL__ marker: callers fold it into their own output)
 * when the deploy would refuse this config right now. Call it AFTER anything that
 * changes the config (env snapshot restore, override write) and right before the `up`.
 */
export async function checkComposeForRecreate(
	server: ServerConfig,
	p: {
		app: string
		configFile: string
		composeFiles?: string[]
		workingDir: string
		/** what the recreate is, for the log line ('rollback', 'domain apply', ...) */
		what: string
	},
	env: Record<string, string | undefined> = process.env,
): Promise<RecreateApproval> {
	const [{ otherAppsOnServer }, { lastSuccessfulComposeHash, lastSuccessfulComposeView }, { routeHostsFor }, { defaultHostFor }, { isTraefikServer }, { envFileCandidatesFor }] =
		await Promise.all([
			import('./deploy-runner'),
			import('./deploys'),
			import('./app-domains'),
			import('./app-hosts'),
			import('./traefik-servers'),
			import('./ssh/files'),
		])
	const composeFiles = p.composeFiles && p.composeFiles.length > 0 ? p.composeFiles : [p.configFile]
	// a preview container gets exactly the preview deploy's context
	// (previewGuardContext: its URL host and preview domains, the parent's .preview.env;
	// no stored approval and no other-apps list, as the preview deploy).
	// a registered app is checked as that app, even when a preview row has its name.
	const [own] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, server.id), eq(appRepos.containerName, p.app)))
		.limit(1)
	const preview = own ? null : await previewByName(server.id, p.app)
	if (preview) {
		const { previewGuardContext } = await import('./preview-deploys')
		const pc = await previewGuardContext(server, preview)
		return runRecreateCheck(server, p, composeFiles, { ...pc, otherApps: undefined, envTarget: null, approvedHash: null }, env)
	}
	const approvedHash = await lastSuccessfulComposeHash(server.id, p.app).catch(() => null)
	const approvedView = parseComposeView(await lastSuccessfulComposeView(server.id, p.app, approvedHash).catch(() => null))
	const otherApps = await otherAppsOnServer(server.id, p.app)
	// the app's hosts; checked on a server marked traefik, and on any server where the
	// probe sees a Docker-provider proxy running (proxyRouteHosts).
	// A failed lookup refuses on a traefik server (as before); elsewhere no host is allowed
	// (it matters only when a proxy is seen, and then fails closed).
	const hostsOf = async () =>
		own ? await routeHostsFor(server, own.id, p.app) : [defaultHostFor(server, p.app)].filter((h): h is string => !!h)
	const routeHosts: string[] | null = (await isTraefikServer(server)) ? await hostsOf() : null
	const ownRouteHosts = routeHosts ?? (await hostsOf().catch((): string[] => []))
	// Where the deploy renders the env file; best effort (the default /opt/apps/<app>.env is
	// always protected).
	const envTarget = await envFileCandidatesFor(server, p.app)
		.then((c) => c[0] ?? null)
		.catch(() => null)
	return runRecreateCheck(server, p, composeFiles, { routeHosts, proxyRouteHosts: ownRouteHosts, otherApps, envTarget, approvedHash, approvedView }, env)
}

async function runRecreateCheck(
	server: ServerConfig,
	p: { app: string; configFile: string; workingDir: string; what: string },
	composeFiles: string[],
	c: {
		routeHosts: string[] | null
		proxyRouteHosts?: string[]
		otherApps: string[] | undefined
		envTarget: string | null
		approvedHash: string | null
		approvedView?: ComposeView | null
		extraEnvFiles?: string[]
	},
	env: Record<string, string | undefined>,
): Promise<RecreateApproval> {
	const approvedHash = c.approvedHash
	try {
		const r = await checkComposeForDeploy(
			server,
			composeFileArgs(p.configFile, composeFiles),
			{
				appName: p.app,
				workingDir: p.workingDir,
				composeFiles,
				routeHosts: c.routeHosts,
				...(c.proxyRouteHosts ? { proxyRouteHosts: c.proxyRouteHosts } : {}),
				...(c.otherApps !== undefined ? { otherApps: c.otherApps } : {}),
				...(c.extraEnvFiles ? { extraEnvFiles: c.extraEnvFiles } : {}),
				envTarget: c.envTarget,
				userCf: composeFileArgs(p.configFile, composeFiles, { override: false }),
				approvedHash,
				approvedView: c.approvedView ?? null,
			},
			env,
		)
		const base = approvedHash ? 'compared with the last successful deploy' : 'no approved compose hash recorded yet: warn only, as a deploy'
		const head = `[compose-guard] ${p.what}: the compose on disk was checked with the deploy's rules (${base})\n`
		if (!r.hash) console.error(`[compose-guard] ${server.id}/${p.app} ${p.what}: compose probe unreadable, recreating UNCHECKED (warn mode)`)
		return { hash: r.hash, app: p.app, log: `${head}${r.log.replace(/^── compose guard/, `── compose guard, ${p.what}`)}` }
	} catch (err) {
		if (err instanceof ComposeGuardError)
			throw new Error(
				`${p.what} refused: ${err.message.replace(/\n?__POWDER_FAIL__[^\n]*/g, '').trim()}\nThe container keeps running as it is. Fix the compose file and deploy.`,
			)
		throw err
	}
}
