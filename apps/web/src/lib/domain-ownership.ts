import { and, appDomains, appRepos, db, eq, sql } from './db'

// the redirect writers emit Traefik routers (priority 300) and nginx
// server blocks for a hostname. Only hostnames that belong to THIS app (an
// app_domains row of the app's repo, verified or live) may be written.
const OWNED_DOMAIN_STATUSES = ['verified', 'live']

export function domainRowOwnedBy(
	row: { appRepoId: string; status: string } | null | undefined,
	repoId: string,
): boolean {
	return !!row && row.appRepoId === repoId && OWNED_DOMAIN_STATUSES.includes(row.status)
}

export async function hostnameOwnedByApp(
	serverId: string,
	containerName: string,
	hostname: string,
): Promise<boolean> {
	const [repo] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	if (!repo) return false
	const [row] = await db
		.select({ appRepoId: appDomains.appRepoId, status: appDomains.status })
		.from(appDomains)
		.where(sql`lower(${appDomains.hostname}) = ${hostname.trim().toLowerCase()}`)
		.limit(1)
	return domainRowOwnedBy(row, repo.id)
}

class HostnameNotOwnedError extends Error {
	constructor(hostname: string, why = 'does not belong to this app') {
		super(`hostname ${hostname} ${why}`)
	}
}

/** the www/apex sibling a redirect answers on (a router / server_name for
 *  www.X when the app's domain is X, or X for www.X) must be a verified/live domain of
 *  this app, or a hostname no other app has any app_domains row for. `rows` are all
 *  rows of that hostname. */
export function siblingHostAllowed(rows: Array<{ appRepoId: string; status: string }>, repoId: string): boolean {
	if (rows.some((r) => domainRowOwnedBy(r, repoId))) return true
	return !rows.some((r) => r.appRepoId !== repoId)
}

export async function siblingHostAllowedForApp(serverId: string, containerName: string, hostname: string): Promise<boolean> {
	const [repo] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	if (!repo) return false
	const rows = await db
		.select({ appRepoId: appDomains.appRepoId, status: appDomains.status })
		.from(appDomains)
		.where(sql`lower(${appDomains.hostname}) = ${hostname.trim().toLowerCase()}`)
	return siblingHostAllowed(rows, repo.id)
}

export const SIBLING_TAKEN = 'belongs to another app (a www/apex redirect may only answer on a domain of this app or one no other app uses)'

export async function assertSiblingHostsAllowed(
	owner: { serverId: string; containerName: string },
	hostnames: string[],
): Promise<void> {
	for (const h of hostnames) {
		if (!(await siblingHostAllowedForApp(owner.serverId, owner.containerName, h))) throw new HostnameNotOwnedError(h, SIBLING_TAKEN)
	}
}

export async function assertHostnamesOwned(
	owner: { serverId: string; containerName: string },
	hostnames: string[],
): Promise<void> {
	for (const h of hostnames) {
		if (!(await hostnameOwnedByApp(owner.serverId, owner.containerName, h))) {
			throw new HostnameNotOwnedError(h)
		}
	}
}
