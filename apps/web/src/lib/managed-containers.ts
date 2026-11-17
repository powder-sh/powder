import { appRepos, db, eq, previewDeploys } from './db'

/** container names of the powder apps registered on a server (app_repos), for
 *  getNginxRoutes: discovery never runs `nginx -T` inside an app-controlled container.
 *  also the preview containers of those apps (preview_deploys), whatever their
 *  status: a torn-down row costs nothing and a stale container may still run. */
export async function managedContainerNames(serverId: string): Promise<string[]> {
	const rows = await db
		.select({ containerName: appRepos.containerName })
		.from(appRepos)
		.where(eq(appRepos.serverId, serverId))
	const previews = await db
		.select({ containerName: previewDeploys.containerName })
		.from(previewDeploys)
		.innerJoin(appRepos, eq(previewDeploys.appRepoId, appRepos.id))
		.where(eq(appRepos.serverId, serverId))
	return [...new Set([...rows, ...previews].map((r) => r.containerName))]
}
