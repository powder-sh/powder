// where powder may write an app's rendered env file.
//
// The render target comes from the app's compose (`env_file:` of the app's OWN
// service only, composeServiceEnvFilePaths in ssh/files.ts), and in the
// workdir layout that compose is the repo's. Powder writes the file as root BEFORE
// the compose guard runs, so a repo could otherwise point the write at any path on
// the server. One rule, used by the deploy render and the dashboard env-file write:
//
//   - /opt/apps/<app>.env (powder's convention), or
//   - a file inside the app's own dir /opt/apps/<app>/ that is not the deploy key,
//     a compose file or under .git, with no symlink on the way (checked on the server,
//     noSymlinkBelowShell in repo-symlinks.ts), or
//   - the target this app already rendered to BEFORE the upgrade (pinned in powder_meta
//     `env_render_target:<server>:<app>`), so existing apps whose env file lives
//     elsewhere (a stack's own env dir, or a second env file next to the app's)
//     keep working.
//     A pin is only created from evidence that predates repo control: powder's own
//     env snapshot of that path on the server (deploy-<id> in the env state dir, or an
//     in-place <path>.deploy-<id> whose mtime is before the cutoff) from a SUCCESSFUL
//     deploy of this app that started before the `env_target_cutoff` powder_meta row
//     (migration 0057). A new app never gets a pin; the dashboard env-file write never
//     creates one; anything else is pinned by hand (bin/self-deploy.sh --pin-report).
//
// Never allowed, pinned or not: powder's own env file (POWDER_ENV_FILE,
// /opt/apps/powder*.env, /opt/apps/powder/), another app's /opt/apps/<other>.env or
// /opt/apps/<other>/..., a path another app has pinned, the deploy key, a compose
// file or anything under .git.
//
// Pure: no I/O.

import { posix } from 'node:path'
import { isDeniedEnvPath } from './ssh/files'

export const ENV_TARGET_META_PREFIX = 'env_render_target:'
/** powder_meta key written once by migration 0057: renders before it predate the rule. */
export const ENV_TARGET_CUTOFF_KEY = 'env_target_cutoff'

export function envTargetMetaKey(serverId: string, appName: string): string {
	return `${ENV_TARGET_META_PREFIX}${serverId}:${appName}`
}

/** The canonical absolute path, or null when it is relative or walks up (`..`). */
function canonical(path: string): string | null {
	if (!path.startsWith('/') || path.split('/').includes('..')) return null
	return posix.normalize(path)
}

/** True when the path is inside the app's own dir (the one a deploy may write to). */
export function envTargetInAppDir(path: string, appName: string): boolean {
	const p = canonical(path)
	return !!p && p.startsWith(`/opt/apps/${appName}/`)
}

export interface EnvTargetCtx {
	appName: string
	/** The target pinned for this app (powder_meta), or null. */
	pinned: string | null
	/** The other powder apps on this server (app_repos container names). */
	otherApps?: readonly string[]
	/** Targets other apps on this server have pinned. */
	otherPins?: readonly string[]
	/** powder's own env file (POWDER_ENV_FILE), when set. */
	powderEnvFile?: string | null
}

/** Refusals that hold even for a pinned target, and that stop a pin from being made. */
export function envTargetHardRefusal(path: string, c: EnvTargetCtx): string | null {
	const abs = canonical(path)
	if (!abs) return `env file "${path}" is not an absolute path without ".."`
	if (isDeniedEnvPath(abs)) return `env file "${abs}" is in a system directory`
	const ownConv = abs === `/opt/apps/${c.appName}.env`
	const ownDir = envTargetInAppDir(abs, c.appName)
	if (ownDir) {
		const segs = abs.slice(`/opt/apps/${c.appName}/`.length).split('/')
		const base = segs[segs.length - 1] ?? ''
		if (segs.includes('.git')) return `env file "${abs}" is inside a .git directory`
		if (base === '.deploy-key') return `env file "${abs}" is the deploy key`
		if (/^(docker-)?compose[^/]*\.ya?ml$/i.test(base)) return `env file "${abs}" is a compose file`
	}
	// Before the own-path early return: a custom POWDER_ENV_FILE can be any path,
	// including an app's own /opt/apps/<app>.env or a file under /opt/apps/<app>/.
	const powderEnv = c.powderEnvFile ? canonical(c.powderEnvFile) : null
	const own = `env file "${abs}" is powder's own env file`
	if (c.appName !== 'powder' && abs === powderEnv) return own
	if (ownConv || ownDir) return null
	// the default locations; an app named powder<x> keeps its own /opt/apps/powder<x>.env
	if (c.appName !== 'powder' && (/^\/opt\/apps\/powder[^/]*\.env$/.test(abs) || abs.startsWith('/opt/apps/powder/')))
		return own
	for (const o of c.otherApps ?? []) {
		if (o === c.appName) continue
		if (abs === `/opt/apps/${o}.env` || abs.startsWith(`/opt/apps/${o}/`))
			return `env file "${abs}" belongs to the app ${o}`
	}
	if ((c.otherPins ?? []).some((p) => canonical(p) === abs))
		return `env file "${abs}" is another app's recorded env target`
	return null
}

/** Why powder must not write the rendered env to `path`, or null when it may. */
export function envRenderTargetRefusal(path: string, c: EnvTargetCtx): string | null {
	const hard = envTargetHardRefusal(path, c)
	if (hard) return hard
	const abs = canonical(path) as string
	if (abs === `/opt/apps/${c.appName}.env` || envTargetInAppDir(abs, c.appName)) return null
	if (c.pinned && abs === canonical(c.pinned)) return null
	return `env file "${abs}" is outside this app (allowed: /opt/apps/${c.appName}.env, a file under /opt/apps/${c.appName}/${c.pinned ? `, or the recorded target ${c.pinned}` : ''})`
}

/** Deploy ids named by powder's env snapshots (envSnapshotListShell output), with and
 *  without the `dep_` prefix: every state-dir `deploy-<id>`, and an in-place
 *  `inplace-<id> <mtime>` only when its mtime is before the cutoff (a checkout writes
 *  files with the current time, so a repo-planted `<path>.deploy-<id>` is newer). */
export function renderRecordDeployIds(listing: string, cutoff: Date): string[] {
	const out = new Set<string>()
	for (const line of listing.split('\n')) {
		const t = line.trim()
		const d = t.match(/^deploy-([A-Za-z0-9_-]+)$/)
		const l = t.match(/^inplace-([A-Za-z0-9_-]+) (\d+)$/)
		const id = d?.[1] ?? (l && Number(l[2]) * 1000 < cutoff.getTime() ? l[1] : undefined)
		if (!id) continue
		out.add(id)
		out.add(`dep_${id}`)
	}
	return [...out]
}

/** The SQL an operator runs (in powder's DB) to pin `path` for an app by hand. */
export function pinSql(serverId: string, appName: string, path: string): string {
	const q = (v: string) => `'${v.replace(/'/g, "''")}'`
	return `INSERT INTO powder_meta (key, value) VALUES (${q(envTargetMetaKey(serverId, appName))}, ${q(path)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`
}
