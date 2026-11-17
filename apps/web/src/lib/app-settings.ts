// Validation for the app settings the Settings tab and PATCH /api/projects/[id]
// write: sync_deployment_md, uptime_enabled, health_url, previews_enabled, the
// Dockerfile and container port previews build and route to (dockerfile_path,
// container_port; the app's own deploys follow its compose file), auto_rollback
// (the per-app opt-out the automatic rollback preflight reads),
// deploy_settle_seconds (the app's settle window for push deploys, lib/deploy-settle.ts),
// and the database backups dump (has_postgres, backup_db_*; lib/backups.ts).
// Pure module (no db/ssh) so the route and the tests share one authority.
import { isIP } from 'node:net'
import { healthPathFor } from './app-hosts'
import { validateAppInputs } from './compose-guard'
import { DEPLOY_SETTLE_MAX_SECONDS } from './deploy-settle'
import { appTargetBlocked } from './notify-url-guard'

export interface AppSettingsPatch {
	syncDeploymentMd?: boolean
	uptimeEnabled?: boolean
	healthUrl?: string | null
	previewsEnabled?: boolean
	dockerfilePath?: string
	/** null: read the port from the app's compose / Traefik label. */
	containerPort?: number | null
	/** false: the automatic rollback preflight never allows rolling this app back. */
	autoRollback?: boolean
	/** Settle window for push deploys in whole seconds (0 = never wait);
	 *  null: the install-wide value. */
	deploySettleSeconds?: number | null
	/** true: the app has a postgres database to back up and restore. */
	hasPostgres?: boolean
	/** The database backups dump; null: the default (container <app>-db,
	 *  database app, user app). A host ("host" or "host:port") is reached over
	 *  TCP from the app server instead of a container and needs a password. */
	backupDbContainer?: string | null
	backupDbHost?: string | null
	backupDbName?: string | null
	backupDbUser?: string | null
	/** Plaintext from the request: the route stores it encrypted
	 *  (backup_db_password_encrypted) and never returns it. null or empty clears it. */
	backupDbPassword?: string | null
}

/** The fields that choose which database backups dump. Setting any of them needs an
 *  admin browser session (session-only action `backup_db`). */
export const BACKUP_DB_FIELDS = [
	'hasPostgres',
	'backupDbContainer',
	'backupDbHost',
	'backupDbName',
	'backupDbUser',
	'backupDbPassword',
] as const satisfies readonly (keyof AppSettingsPatch)[]

export type AppSettingsResult = { ok: true; value: AppSettingsPatch } | { ok: false; error: string }

const HEALTH_URL_MAX = 2048

// Characters healthPathFor refuses in a path (it falls back to '/').
const BAD_PATH_CHARS = /[\s`'"\\$]/

/**
 * health_url as uptime.ts, the deploy health gate and the Traefik health check
 * read it: a path starting with '/' (joined with the app's host), or an absolute
 * http(s) URL. Empty / null clears it. A path the Traefik check would not use
 * (healthPathFor falls back to '/') is refused here, so all three readers agree.
 * An absolute URL naming a loopback, link-local or private IP literal is refused
 * up front (the uptime probe would refuse it at connect time; appTargetBlocked).
 */
export function validateHealthUrl(
	raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
	if (raw === null || raw === undefined) return { ok: true, value: null }
	if (typeof raw !== 'string') return { ok: false, error: 'healthUrl must be a string' }
	const v = raw.trim()
	if (!v) return { ok: true, value: null }
	if (v.length > HEALTH_URL_MAX) return { ok: false, error: 'healthUrl is too long' }
	let path: string
	if (v.startsWith('/')) {
		if (v.startsWith('//')) return { ok: false, error: 'healthUrl path must not start with //' }
		path = v.split(/[?#]/)[0] ?? '/'
	} else {
		// uptime.ts treats only this shape as absolute (anything else is a path).
		if (!/^https?:\/\/[^/\s]/i.test(v)) {
			return { ok: false, error: 'healthUrl must be a path (/api/health) or an http(s) URL' }
		}
		let u: URL
		try {
			u = new URL(v)
		} catch {
			return { ok: false, error: 'healthUrl is not a valid URL' }
		}
		if (!u.hostname) return { ok: false, error: 'healthUrl needs a host' }
		if (u.username || u.password) return { ok: false, error: 'healthUrl must not carry credentials' }
		const host = u.hostname.replace(/^\[|\]$/g, '')
		if (isIP(host) && appTargetBlocked(host)) {
			return {
				ok: false,
				error: 'healthUrl names a loopback, link-local or private address; powder does not probe those',
			}
		}
		path = u.pathname
	}
	if (BAD_PATH_CHARS.test(v)) {
		return { ok: false, error: 'healthUrl must not contain spaces, quotes, backslashes or $' }
	}
	if (path !== '/' && healthPathFor(v) !== path) {
		return { ok: false, error: `healthUrl path ${path} is not usable as a health check path` }
	}
	return { ok: true, value: v }
}

const BOOLEAN_FIELDS = [
	'syncDeploymentMd',
	'uptimeEnabled',
	'previewsEnabled',
	'autoRollback',
	'hasPostgres',
] as const

// Docker container name.
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
// Hostname or IPv4 address, optional :port.
const DB_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::(\d{1,5}))?$/
// Postgres database or role name (at most 63 bytes).
const DB_IDENT = /^[A-Za-z0-9_][A-Za-z0-9_$.-]{0,62}$/
const DB_PASSWORD_MAX = 1024

type TextCheck = { ok: true; value: string | null } | { ok: false; error: string }

function optionalText(key: string, raw: unknown, check: (v: string) => string | null): TextCheck {
	if (raw === null || raw === undefined) return { ok: true, value: null }
	if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string or null` }
	const v = raw.trim()
	if (!v) return { ok: true, value: null }
	const problem = check(v)
	return problem ? { ok: false, error: `${key} ${problem}` } : { ok: true, value: v }
}

const BACKUP_DB_TEXT: Record<
	'backupDbContainer' | 'backupDbHost' | 'backupDbName' | 'backupDbUser',
	(v: string) => string | null
> = {
	backupDbContainer: (v) =>
		CONTAINER_NAME.test(v) ? null : 'must be a container name (letters, digits and . _ -, at most 128)',
	backupDbHost: (v) => {
		const m = v.match(DB_HOST)
		if (!m) return 'must be a host name or IPv4 address, optionally with :port'
		if (m[1] !== undefined && (Number(m[1]) < 1 || Number(m[1]) > 65535)) return 'port must be from 1 to 65535'
		return null
	},
	backupDbName: (v) =>
		DB_IDENT.test(v) ? null : 'must be letters, digits and _ $ . - (at most 63 characters)',
	backupDbUser: (v) =>
		DB_IDENT.test(v) ? null : 'must be letters, digits and _ $ . - (at most 63 characters)',
}

/**
 * The stored backup database settings after a patch, checked as a whole: a
 * container and a host exclude each other (the host wins in lib/backups.ts, so
 * both set would hide the container), and a host needs a password (pg_dump
 * connects over TCP; runBackupForApp refuses a host without one).
 */
export function backupDbProblem(row: {
	container: string | null
	host: string | null
	passwordSet: boolean
}): string | null {
	if (row.container && row.host) return 'set backupDbContainer or backupDbHost, not both'
	if (row.host && !row.passwordSet) return 'backupDbHost needs backupDbPassword (pg_dump connects over TCP)'
	return null
}

/** PATCH body -> patch of the provided fields only. Unknown keys are ignored. */
export function validateAppSettings(body: unknown): AppSettingsResult {
	if (!body || typeof body !== 'object') return { ok: false, error: 'invalid body' }
	const b = body as Record<string, unknown>
	const out: AppSettingsPatch = {}
	for (const k of BOOLEAN_FIELDS) {
		if (!(k in b)) continue
		if (typeof b[k] !== 'boolean') return { ok: false, error: `${k} must be a boolean` }
		out[k] = b[k] as boolean
	}
	if ('healthUrl' in b) {
		const r = validateHealthUrl(b.healthUrl)
		if (!r.ok) return r
		out.healthUrl = r.value
	}
	// Same rules as /new (validateAppInputs): the values land in a preview compose.
	if ('dockerfilePath' in b) {
		const raw = typeof b.dockerfilePath === 'string' ? b.dockerfilePath.trim() : b.dockerfilePath
		const r = validateAppInputs({ dockerfilePath: raw })
		if (!r.ok) return r
		out.dockerfilePath = r.dockerfilePath
	}
	if ('containerPort' in b) {
		if (b.containerPort === null) out.containerPort = null
		else {
			const r = validateAppInputs({ containerPort: b.containerPort })
			if (!r.ok) return r
			out.containerPort = r.containerPort
		}
	}
	if ('deploySettleSeconds' in b) {
		const v = b.deploySettleSeconds
		if (v === null) out.deploySettleSeconds = null
		else if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > DEPLOY_SETTLE_MAX_SECONDS) {
			return {
				ok: false,
				error: `deploySettleSeconds must be a whole number of seconds from 0 to ${DEPLOY_SETTLE_MAX_SECONDS}, or null`,
			}
		} else out.deploySettleSeconds = v
	}
	for (const k of Object.keys(BACKUP_DB_TEXT) as (keyof typeof BACKUP_DB_TEXT)[]) {
		if (!(k in b)) continue
		const r = optionalText(k, b[k], BACKUP_DB_TEXT[k])
		if (!r.ok) return r
		out[k] = r.value
	}
	if ('backupDbPassword' in b) {
		// Not trimmed: a password may start or end with a space.
		const v = b.backupDbPassword
		if (v === null || v === '') out.backupDbPassword = null
		else if (typeof v !== 'string') return { ok: false, error: 'backupDbPassword must be a string or null' }
		else if (v.length > DB_PASSWORD_MAX)
			return { ok: false, error: `backupDbPassword must be at most ${DB_PASSWORD_MAX} characters` }
		// The backup writes it as one PGPASSWORD= line of a docker env file.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
		else if (/[\u0000-\u001f\u007f]/.test(v))
			return { ok: false, error: 'backupDbPassword must not contain line breaks or control characters' }
		else out.backupDbPassword = v
	}
	if (Object.keys(out).length === 0) {
		return {
			ok: false,
			error:
				'nothing to update (syncDeploymentMd, uptimeEnabled, healthUrl, previewsEnabled, dockerfilePath, containerPort, autoRollback, deploySettleSeconds, hasPostgres, backupDbContainer, backupDbHost, backupDbName, backupDbUser, backupDbPassword)',
		}
	}
	return { ok: true, value: out }
}
