// names /new must not give an app. An app owns
// /opt/apps/<name>/ and /opt/apps/<name>.env on its server, so a name that matches
// powder's own stack or a server-level file (an ops agent's env file, .mem-cap) would let the
// new app's env file or directory land on infra. POWDER_RESERVED_APP_NAMES adds the
// operator's own names (see reservedAppNames). Existing apps are not checked.
import { RESERVED_CONTAINER_NAMES, composeProjectNameFor, selfDeployNames } from './compose-safety'
import { isPowderSelfContainer } from './secret-mask'

export const RESERVED_APP_NAMES: readonly string[] = [
	...new Set([
		...RESERVED_CONTAINER_NAMES,
		'powder',
		'powder-worker',
		'powder-postgres',
		'powder-db',
		'powder-testgate',
		'traefik',
		'postgres',
		'redis',
		'nginx',
		'mem-cap',
		'apps',
		'backups',
	]),
]

/** Shape of a name in POWDER_RESERVED_APP_NAMES: the /new app-name shape. */
const EXTRA_RESERVED_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/
/** At most this many names are read from POWDER_RESERVED_APP_NAMES. */
export const MAX_EXTRA_RESERVED_APP_NAMES = 64

/** The built-in reserved names plus POWDER_RESERVED_APP_NAMES: an optional
 *  comma-separated list of extra names /new and the adopt flows refuse, for the
 *  operator's own services that keep /opt/apps/<name>/ or /opt/apps/<name>.env on a
 *  server (e.g. an ops agent next to powder). Entries are trimmed and lowercased; one
 *  that is not an app-name shape is ignored, and only the first
 *  MAX_EXTRA_RESERVED_APP_NAMES are read. */
export function reservedAppNames(env: Record<string, string | undefined> = process.env): readonly string[] {
	const extra = (env.POWDER_RESERVED_APP_NAMES ?? '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter((s) => EXTRA_RESERVED_NAME_RE.test(s))
		.slice(0, MAX_EXTRA_RESERVED_APP_NAMES)
	return extra.length ? [...new Set([...RESERVED_APP_NAMES, ...extra])] : RESERVED_APP_NAMES
}

/** `<p>` and `<p>-...` are never a new app's name. */
const RESERVED_APP_NAME_PREFIXES: readonly string[] = ['pv', 'dep']

/** Null when `name` may be used for a new app, else the reason. */
export function reservedAppNameError(
	name: string,
	env: Record<string, string | undefined> = process.env,
): string | null {
	if (reservedAppNames(env).includes(name)) return `"${name}" is reserved for powder or the server itself; pick another name`
	// previews are named `pv-<parent>-<slug>` and powder's per-deploy containers
	// `dep-...`: an app in those namespaces could claim a preview's names (its env file,
	// container, Traefik objects) or collide with one.
	if (RESERVED_APP_NAME_PREFIXES.some((p) => name === p || name.startsWith(`${p}-`)))
		return `"${name}" is in a namespace powder reserves for previews and deploy containers (pv-, dep-); pick another name`
	// the deploy's raw compose check refuses any compose file holding these words,
	// and the app name lands in its compose file (container_name, labels).
	if (/extends|include/i.test(name)) return `"${name}" contains "extends" or "include", which powder's compose check refuses in a compose file; pick another name`
	return null
}

/** compose writes the project name of an app in lowercase with only
 *  [a-z0-9_-] (composeProjectNameFor), so `Shop.com` and `shopcom` would be ONE compose
 *  project on a server: one app's deploy would treat the other's containers, volumes and
 *  networks as its own. Null when `name` normalises to a project name no other app on the
 *  server (`others`, the app_repos container names there) and no powder container name
 *  has, else the reason. */
export function projectNameCollisionError(name: string, others: readonly string[]): string | null {
	const p = composeProjectNameFor(name)
	if (!p) return `"${name}" has no characters compose keeps in a project name; pick another name`
	const reserved = RESERVED_CONTAINER_NAMES.find((r) => composeProjectNameFor(r) === p)
	if (reserved) return `"${name}" becomes the compose project "${p}", which is powder's (${reserved}); pick another name`
	const other = others.find((o) => o !== name && composeProjectNameFor(o) === p)
	if (other) return `"${name}" becomes the compose project "${p}", the same as the app ${other} on this server; pick another name`
	return null
}

/** the adopt flows (repo connect, repo import) take over a container that already
 *  runs on the server. Refused: a reserved app name (reservedAppNameError), powder's own
 *  containers (isPowderSelfContainer) and any container of powder's own compose project
 *  (`powder`, or the project of POWDER_SELF_CONTAINER). Null when the container may be
 *  adopted. */
export function adoptContainerProblem(
	name: string,
	composeProject: string | null | undefined,
	env: Record<string, string | undefined> = process.env,
): string | null {
	const reserved = reservedAppNameError(name, env)
	if (reserved) return reserved
	if (isPowderSelfContainer(name, env)) return `"${name}" is powder's own container`
	const own = new Set(['powder', composeProjectNameFor(selfDeployNames(env).container)])
	if (composeProject && own.has(composeProject.trim().toLowerCase()))
		return `the container "${name}" belongs to powder's own compose project "${composeProject}"`
	return null
}

/** The adopt flows (repo connect, repo import) refuse a container whose compose
 *  working dir is in powder's preview namespace (`/opt/apps/pv-...`, also anything
 *  below it): names starting with `pv-` are reserved for previews (/new refuses them
 *  too), and an app there would block the preview of that name, whose clone is
 *  refused because the directory is not its own. The container name alone does not
 *  show where it runs from. Null when the working dir may be adopted. */
export function adoptWorkingDirProblem(workingDir: string | null | undefined): string | null {
	if (!workingDir) return null
	const segs = workingDir.split('/').filter((x) => x && x !== '.')
	if (segs.includes('..'))
		return `the container's compose directory ${workingDir} is not a plain path (it holds ..); start the app from a plain directory, then connect it`
	if (segs[0] === 'opt' && segs[1] === 'apps' && /^pv-/i.test(segs[2] ?? ''))
		return `the container's compose directory ${workingDir} is in powder's preview namespace: names under /opt/apps/pv-* are reserved for previews, and a preview of that name would be refused because the directory is not its own. Move the app to a directory with another name, start it from there, then connect it again`
	return null
}
