// Stop and delete an app from the dashboard (settings, danger zone).
//
// Stop: `docker stop` of the app container only. Its other services (a bundled
// database, a worker) keep running, and the next push or redeploy starts the app
// again. Starting it from the dashboard is the apply route (compose guard, then
// `compose up` of the app service): never `docker start`, which brings a stopped
// container back with the mounts it was created with, outside powder's checks
// (see restartCommand in lib/ssh/logs.ts).
//
// Delete: remove the app's containers, then its rows (api route
// app/api/servers/[id]/containers/[name]/route.ts). Containers are found by name
// and by compose project label, never through `docker compose down`: compose
// would parse the app's checkout, whose tracked `.env` can set
// COMPOSE_PROJECT_NAME or `-f` files and point `down` at another project (the
// same reason previewTeardownShell in lib/preview-deploys.ts avoids it).
// Volumes, the app directory and bind-mounted data are never removed: no `-v`,
// no `docker volume rm`, no `rm -rf`.

import { composeProjectNameFor } from './compose-safety'
import { appLockShell } from './deploy/fragments'
import { appLockPath } from './deploy-supersede'
import { redactSecrets } from './secret-text'
import type { ServerConfig } from './servers'
import { SAFE_NAME, assertSafeName, shq } from './shell'
import { runCommand } from './ssh/connection'

const STOP_TIMEOUT_SEC = 30

const REMOVE_DONE = '__POWDER_APP_REMOVED__'

/** Shell: stop the running container `name`. A container that is not running is a
 *  no-op (exit 0, "already stopped"); a missing one exits 1. Pure. */
export function stopCommand(name: string): string {
	assertSafeName(name)
	const inner =
		`S=$(docker inspect --format '{{.State.Running}}' -- ${name} 2>/dev/null) || { echo "stop refused: no container named ${name} on this server"; exit 1; }; ` +
		`if [ "$S" != true ]; then echo "already stopped: ${name} is not running"; exit 0; fi; ` +
		`docker stop -t ${STOP_TIMEOUT_SEC} -- ${name}`
	return `bash -o pipefail -c ${shq(inner)}`
}

export async function stopContainer(server: ServerConfig, name: string): Promise<string> {
	const { code, stdout, stderr } = await runCommand(server, stopCommand(name), (STOP_TIMEOUT_SEC + 30) * 1000)
	const out = redactSecrets((stdout.trim() || stderr.trim()).slice(0, 4000))
	if (code !== 0) throw new Error(out || `docker stop failed for ${name}`)
	return out
}

export interface RemovePlan {
	/** the app (app_repos container_name) */
	app: string
	/** the compose project of the app container; null when the container is gone */
	project: string | null
	/** compose working dir and service: the per-app deploy lock derives from them */
	workingDir: string
	service: string
	/** names that are never removed: every other app and preview on the server,
	 *  powder's own. Also the names the project-name collision check reads. */
	protectedNames: readonly string[]
}

/** True when the app's compose project is its own (named after the app), so every
 *  container and network carrying that project label is the app's. Some setups
 *  share one project between several apps: then only the app container goes. */
export function projectIsAppsOwn(app: string, project: string | null): boolean {
	return project === null || project === composeProjectNameFor(app)
}

/** Other names in the plan (apps, previews) whose compose project name is the same
 *  as the app's: `web.app` and `webapp` both map to `webapp`. Pure. */
export function projectNameSharedWith(app: string, names: readonly string[]): string[] {
	const project = composeProjectNameFor(app)
	return [...new Set(names.filter((n) => n !== app && composeProjectNameFor(n) === project))]
}

/** How the delete finds the app's containers. `sweep`: also every container of the
 *  app's compose project (label) whose compose working dir is the app's. Without
 *  the sweep only the container named after the app is removed. Pure. */
export function removeScope(plan: RemovePlan): { sweep: boolean; note: string | null } {
	if (!projectIsAppsOwn(plan.app, plan.project)) {
		return { sweep: false, note: `kept the compose project ${plan.project}: other apps share it, only ${plan.app} was removed` }
	}
	const shared = projectNameSharedWith(plan.app, plan.protectedNames)
	if (shared.length) {
		return {
			sweep: false,
			note: `kept the other containers of the compose project ${composeProjectNameFor(plan.app)}: ${shared.join(', ')} uses the same project name, only ${plan.app} was removed`,
		}
	}
	return { sweep: true, note: null }
}

/** Shell: under the per-app deploy lock, stop and remove the app container (by exact
 *  name) and, when removeScope allows the sweep, every container of the app's compose
 *  project that was created from the app's working dir, and the project's networks.
 *  Names in `protectedNames` and project containers of another working dir are kept
 *  and reported. Prints `removed <name>` / `kept <name> ...` lines and ends with
 *  __POWDER_APP_REMOVED__. Exits 2 when docker cannot list containers (nothing
 *  removed), 1 when stop / rm fails. Never removes a volume, a directory or a file. Pure. */
export function removeAppShell(plan: RemovePlan): string {
	assertSafeName(plan.app)
	if (!plan.workingDir.startsWith('/') || plan.workingDir.includes('\n')) throw new Error('unsafe working dir')
	const scope = removeScope(plan)
	const project = composeProjectNameFor(plan.app)
	const byName = `name=^/?${plan.app.replace(/\./g, '\\.')}$`
	const byLabel = `label=com.docker.compose.project=${project}`
	const keep = [...new Set(plan.protectedNames.filter((n) => SAFE_NAME.test(n) && n !== plan.app))]
	const keepCase = keep.length
		? `case "$N" in ${keep.map(shq).join('|')}) echo "kept $N (another app or powder itself)"; continue;; esac; `
		: ''
	const listFail = `{ echo "could not list containers (docker ps failed), nothing removed"; exit 2; }`
	const inner =
		appLockShell(appLockPath(plan.workingDir, plan.service)) +
		`RM=''; ` +
		`IDS=$(docker ps -aq --no-trunc --filter ${shq(byName)}) || ${listFail}; ` +
		`for I in $IDS; do RM="$RM $I"; done; ` +
		(scope.sweep
			? `IDS=$(docker ps -aq --no-trunc --filter ${shq(byLabel)}) || ${listFail}; ` +
				`for I in $IDS; do case " $RM " in *" $I "*) continue;; esac; ` +
				`W=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$I" 2>/dev/null) || continue; ` +
				`if [ "$W" != ${shq(plan.workingDir)} ]; then N=$(docker inspect --format '{{.Name}}' "$I" 2>/dev/null); echo "kept \${N#/} (compose project ${project} from another working dir: $W)"; continue; fi; ` +
				`RM="$RM $I"; done; `
			: '') +
		`GO=''; ` +
		`for I in $RM; do N=$(docker inspect --format '{{.Name}}' "$I" 2>/dev/null) || continue; N=\${N#/}; [ -n "$N" ] || continue; ` +
		keepCase +
		`GO="$GO $I"; echo "removed $N"; done; ` +
		`if [ -n "$GO" ]; then docker stop -t ${STOP_TIMEOUT_SEC} $GO >/dev/null && docker rm -f $GO >/dev/null || { echo "docker stop / rm failed"; exit 1; }; fi; ` +
		(scope.sweep
			? `for W in $(docker network ls -q --filter ${shq(byLabel)} 2>/dev/null); do docker network rm "$W" >/dev/null 2>&1 || true; done; `
			: `echo ${shq(scope.note ?? '')}; `) +
		`echo ${REMOVE_DONE}`
	return `bash -o pipefail -c ${shq(inner)}`
}

export interface RemoveResult {
	removed: string[]
	kept: string[]
	output: string
}

/** Pure: read removeAppShell's output. Throws when the shell failed or did not finish. */
export function parseRemoveOutput(stdout: string, code: number): RemoveResult {
	const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
	const output = redactSecrets(lines.filter((l) => l !== REMOVE_DONE).join('\n'))
	if (code !== 0 || !lines.includes(REMOVE_DONE)) throw new Error(output || `container removal failed (exit ${code})`)
	return {
		removed: lines.filter((l) => l.startsWith('removed ')).map((l) => l.slice(8)),
		kept: lines.filter((l) => l.startsWith('kept ')).map((l) => l.slice(5)),
		output,
	}
}

export async function removeAppContainers(
	server: ServerConfig,
	plan: RemovePlan,
): Promise<RemoveResult & { projectNote: string | null }> {
	// flock wait (90s) + stop timeout + rm
	const r = await runCommand(server, removeAppShell(plan), 180_000)
	return { ...parseRemoveOutput(`${r.stdout}\n${r.stderr}`, r.code), projectNote: removeScope(plan).note }
}

/** What delete leaves on the server, for the UI and the API answer. Pure. */
export function keptOnServer(app: string, workingDir: string): string[] {
	return [
		`the app directory ${workingDir} (compose file, checkout, bind-mounted data such as pgdata/)`,
		'named Docker volumes (docker volume ls)',
		`the env file: moved to /var/lib/powder/deleted-env/${app}-<time>/ when no container of the app is left, else left in /opt/apps`,
	]
}
