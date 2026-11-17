// the default backup / restore DB container is `<app>-db`. That name may be
// another app's container (an app registered as `<app>-db`, or a `<app>-db` that some
// other compose project runs). Two guards:
//   - /new, repo connect and import refuse a name `<other>-db` for a registered `<other>`,
//     and a name `<name>` when `<name>-db` is a registered app (appNameDbClash);
//   - the backup and restore of an app WITHOUT backup_db_container accept `<app>-db` only
//     when it is not in another compose project (its com.docker.compose.project label is
//     empty or the app's own project). A registered app's own `<app>-db` normally is
//     in its own app's project, so the guard does not refuse the common case.

import { composeProjectNameFor } from './compose-safety'
import { shq } from './shell'

/** The DB container a backup / restore of the app uses, and whether it is the default. */
export function backupDbContainerFor(repo: { containerName: string; backupDbContainer?: string | null }): {
	container: string
	isDefault: boolean
} {
	if (repo.backupDbContainer) return { container: repo.backupDbContainer, isDefault: false }
	return { container: `${repo.containerName}-db`, isDefault: true }
}

/** Pure: why a new app name clashes with the `<app>-db` convention of the registered apps
 *  on its server, or null. Case-insensitive. */
export function appNameDbClash(name: string, registered: readonly string[]): string | null {
	const n = name.toLowerCase()
	const regs = registered.map((r) => r.toLowerCase()).filter((r) => r !== n)
	const parent = regs.find((r) => n === `${r}-db`)
	if (parent)
		return `"${name}" is the default database container name of the app "${parent}" on this server (<app>-db): its backups and restores would reach this app. Pick another name.`
	if (regs.includes(`${n}-db`))
		return `an app "${name}-db" is registered on this server, which is the default database container name of "${name}" (<app>-db): its backups and restores would reach that app. Pick another name.`
	return null
}

/** Shell (one line, for scripts under `set -e`): the compose project label of the DB
 *  container. Exit status 0 = the container may be used (no label, the app's own project,
 *  or no such container: the dump itself then fails as before); 1 = another project's,
 *  with the reason on stdout. */
export function dbContainerOwnShell(container: string, app: string): string {
	const own = composeProjectNameFor(app)
	return (
		`{ __dbp=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ${shq(container)} 2>/dev/null || true); ` +
		`if [ -n "$__dbp" ] && [ "$__dbp" != ${shq(own)} ]; then echo "db container ${container.replace(/[^A-Za-z0-9._-]/g, '_')} belongs to the compose project $__dbp, not ${own}: refusing (if this really is the app's database, set it as the container in the database form on the app's backups tab)"; false; else true; fi; }`
	)
}
