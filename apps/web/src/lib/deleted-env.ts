// when an app is disconnected (its app_repos row deleted), its rendered env
// files stay in /opt/apps, where a later app named after it, or any process that can
// read /opt/apps, would find its secrets. They move to a root-only archive instead:
// /var/lib/powder/deleted-env/<app>-<ts>/ (0700), but ONLY when no container of the app
// is left on the server (its compose project, a container named after it, or one of its
// previews `pv-<app>-*`, in any state): a container that still exists is recreated
// from those files (a reconnect, a hand-run `compose up`), so then the files stay and
// the result says so. Best effort: a failure is logged and the disconnect stands.
import { composeProjectNameFor } from './compose-safety'
import type { ServerConfig } from './servers'
import { shq } from './shell'
import { runCommand } from './ssh/connection'

const DELETED_ENV_DIR = '/var/lib/powder/deleted-env'

/** The env files powder renders for an app (production, preview, DB) that are this
 *  app's: `<app>.preview.env` / `<app>.db.env` are left out when an app named
 *  `<app>.preview` / `<app>.db` is registered on the server (that file is its `.env`). */
export function appEnvFiles(app: string, otherApps: readonly string[] = [], appsBase = '/opt/apps'): string[] {
	const files = [`${appsBase}/${app}.env`]
	for (const x of ['preview', 'db']) if (!otherApps.includes(`${app}.${x}`)) files.push(`${appsBase}/${app}.${x}.env`)
	return files
}

/** 4: the registered app that owns `<app>.env` when it is not this app: an app
 *  `shop.db`'s env file is also app `shop`'s DB env file. undefined when none. */
export function envFileOwnedByOther(app: string, otherApps: readonly string[]): string | undefined {
	return otherApps.find((o) => o !== app && app.startsWith(`${o}.`))
}

const ARCHIVED = '__POWDER_ENV_ARCHIVED__'
const KEPT = '__POWDER_ENV_KEPT__'
const UNCHECKED = '__POWDER_ENV_UNCHECKED__'

/** Shell: when no container of the app exists, move its env files (a regular file or a
 *  link, never what a link points to) into a new 0700 dir under the archive and print
 *  `__POWDER_ENV_ARCHIVED__ <dir>` plus one `moved <path>` line per file; otherwise print
 *  `__POWDER_ENV_KEPT__ <container>` and move nothing. When a `docker ps` fails (daemon
 *  down, no docker CLI) print `__POWDER_ENV_UNCHECKED__ <why>`, move nothing and exit 2.
 *  Exits 1 when the archive dir is a
 *  link or cannot be made. null for an app name that is not a plain container name. */
export function archiveEnvFilesShell(
	app: string,
	stamp: string,
	opts: { appsBase?: string; archiveDir?: string; otherApps?: readonly string[] } = {},
): string | null {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(app) || app.includes('..')) return null
	if (!/^[0-9A-Za-z-]+$/.test(stamp)) return null
	const root = opts.archiveDir ?? DELETED_ENV_DIR
	const dest = `${root}/${app}-${stamp}`
	const files = appEnvFiles(app, opts.otherApps ?? [], opts.appsBase).map(shq).join(' ')
	const project = composeProjectNameFor(app)
	const pvRe = `^/?pv-${app.replace(/\./g, '\\.')}-`
	return [
		`umask 077; DE_ROOT=${shq(root)}; DE_DIR=${shq(dest)}; DE_MADE=0; `,
		// any container of the app, any state: its project, its own name, its previews
		// each `docker ps` on its own, its exit status checked: a failing daemon or a
		// missing docker CLI must never read as "no containers" (eval r13b)
		`for DE_FL in ${[`label=com.docker.compose.project=${project}`, `name=^/?${app.replace(/\./g, '\\.')}$`, `name=${pvRe}`].map(shq).join(' ')}; do `,
		`DE_C=$(docker ps -aq --filter "$DE_FL" 2>/dev/null) || { echo "${UNCHECKED} docker ps failed (exit $?)"; exit 2; }; `,
		`DE_C=$(printf '%s\\n' "$DE_C" | sed -n 1p); `,
		`if [ -n "$DE_C" ]; then echo "${KEPT} $DE_C"; exit 0; fi; done; `,
		`for DE_F in ${files}; do `,
		`if [ ! -e "$DE_F" ] && [ ! -L "$DE_F" ]; then continue; fi; `,
		`if [ "$DE_MADE" = 0 ]; then `,
		`if [ -L "$DE_ROOT" ]; then echo "archive dir $DE_ROOT is a link, env files left in place"; exit 1; fi; `,
		`mkdir -p -- "$DE_ROOT" && chmod 0700 "$DE_ROOT" && mkdir -m 0700 -- "$DE_DIR" || { echo "cannot create $DE_DIR, env files left in place"; exit 1; }; DE_MADE=1; echo "${ARCHIVED} $DE_DIR"; fi; `,
		`mv -f -- "$DE_F" "$DE_DIR/" && echo "moved $DE_F"; done; exit 0`,
	].join('')
}

export interface EnvArchiveResult {
	/** archived: files moved to `dir`; kept: a container of the app still exists;
	 *  none: no env files; skipped: name refused; failed: see detail. */
	status: 'archived' | 'kept' | 'none' | 'skipped' | 'failed'
	dir?: string
	moved?: string[]
	detail: string
}

/** Pure: read the shell's output. */
export function parseArchiveOutput(stdout: string, code: number): EnvArchiveResult {
	const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
	const kept = lines.find((l) => l.startsWith(`${KEPT} `))
	if (code === 0 && kept)
		return {
			status: 'kept',
			detail: `env files left in /opt/apps: a container of this app still exists (${kept.slice(KEPT.length + 1)}); remove its containers and the files by hand when the app is gone`,
		}
	const unchecked = lines.find((l) => l.startsWith(`${UNCHECKED} `))
	if (unchecked)
		return {
			status: 'kept',
			detail: `env files left in /opt/apps: could not list this app's containers (${unchecked.slice(UNCHECKED.length + 1)}), so nothing was moved`,
		}
	const arch = lines.find((l) => l.startsWith(`${ARCHIVED} `))
	const moved = lines.filter((l) => l.startsWith('moved ')).map((l) => l.slice(6))
	if (code !== 0) return { status: 'failed', detail: lines.join('; ') || `exit ${code}` }
	if (!arch) return { status: 'none', detail: 'no env files' }
	const dir = arch.slice(ARCHIVED.length + 1)
	return {
		status: 'archived',
		dir,
		moved,
		detail: `env files moved to ${dir} (restore: mv ${dir}/* /opt/apps/)`,
	}
}

/** Move the app's env files into the archive on its server when no container of the app
 *  is left. Never throws. */
export async function archiveAppEnvFiles(
	server: ServerConfig,
	app: string,
	otherApps: readonly string[] = [],
): Promise<EnvArchiveResult> {
	const owner = envFileOwnedByOther(app, otherApps)
	if (owner) return { status: 'skipped', detail: `env files left in /opt/apps: /opt/apps/${app}.env also belongs to the app ${owner}` }
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const cmd = archiveEnvFilesShell(app, stamp, { otherApps })
	if (!cmd) return { status: 'skipped', detail: 'not a plain app name' }
	try {
		const r = await runCommand(server, cmd, 20_000)
		const res = parseArchiveOutput(`${r.stdout}\n${r.stderr}`, r.code)
		const log = `[deleted-env] ${server.id}/${app}: ${res.status}: ${res.detail}${res.moved?.length ? ` (${res.moved.join(', ')})` : ''}`
		if (res.status === 'failed') console.warn(log)
		else console.log(log)
		return res
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		console.warn(`[deleted-env] ${server.id}/${app}: archive failed: ${msg}`)
		return { status: 'failed', detail: msg }
	}
}
