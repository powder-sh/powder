// Boot-time configuration guard: powder
// refuses to start with placeholder secrets copied from an example file or a
// missing/invalid encryption key, instead of running with a publicly known
// session secret. NODE_ENV=production only; `next build` and dev are unaffected.

import { encryptionKeyIsValid } from './crypto'
import { authUrlOrigin } from './hosts'

/** floors. Shannon estimate (estimatedEntropyBits): `openssl rand -hex 32`
 *  scores about 240, `openssl rand -base64 32` about 220. */
const AUTH_SECRET_MIN_LENGTH = 32
const AUTH_SECRET_MIN_BITS = 100
export const ENCRYPTION_KEY_MIN_BITS = 128

/** printed by src/check-config.ts when the config would stop the new
 *  containers; the self-deploy preflights refuse to recreate on it. */
export const CONFIG_BAD_MARKER = '__POWDER_CONFIG_BAD__'

/** A known placeholder auth secret from example env files. */
const EXAMPLE_AUTH_SECRET = 'change-me-to-a-random-secret'
const PLACEHOLDER_RE = /change[-_ ]?me/i

export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.NODE_ENV !== 'production') return []
	const problems: string[] = []

	const auth = env.BETTER_AUTH_SECRET
	if (!auth) {
		problems.push('BETTER_AUTH_SECRET is not set (generate one with: openssl rand -hex 32)')
	} else if (auth === EXAMPLE_AUTH_SECRET || PLACEHOLDER_RE.test(auth)) {
		problems.push('BETTER_AUTH_SECRET is still a placeholder from an example file (generate one with: openssl rand -hex 32)')
	} else {
		// a short or guessable session secret lets anyone forge sessions.
		const len = [...auth].length
		const bits = Math.round(estimatedEntropyBits(auth))
		if (len < AUTH_SECRET_MIN_LENGTH) {
			problems.push(`BETTER_AUTH_SECRET is only ${len} characters, under ${AUTH_SECRET_MIN_LENGTH} (generate one with: openssl rand -hex 32; every session is signed out)`)
		} else if (bits < AUTH_SECRET_MIN_BITS) {
			problems.push(`BETTER_AUTH_SECRET looks low-entropy (about ${bits} bits, want ${AUTH_SECRET_MIN_BITS}+; generate one with: openssl rand -hex 32; every session is signed out)`)
		}
	}

	// Webhook URLs, notification links, GitHub deployment log links and the MCP
	// origin are built from this origin; without it they would point at a host
	// the install does not own (lib/hosts.ts dashboardUrl).
	const authUrl = (env.BETTER_AUTH_URL ?? '').trim()
	if (!authUrl) {
		problems.push('BETTER_AUTH_URL is not set (set it to the dashboard origin, e.g. https://deploy.example.com)')
	} else if (!authUrlOrigin(env)) {
		problems.push(`BETTER_AUTH_URL is not a valid http(s) URL (${JSON.stringify(authUrl.slice(0, 80))}; e.g. https://deploy.example.com)`)
	}

	if (!encryptionKeyIsValid()) {
		problems.push('POWDER_ENCRYPTION_KEY is missing or not a 64-char hex string (generate one with: openssl rand -hex 32)')
	} else {
		// 64 hex chars always: a repeated or patterned key (0000..., abab...) passes the format check.
		const bits = Math.round(estimatedEntropyBits(env.POWDER_ENCRYPTION_KEY ?? process.env.POWDER_ENCRYPTION_KEY ?? ''))
		if (bits < ENCRYPTION_KEY_MIN_BITS) {
			problems.push(`POWDER_ENCRYPTION_KEY looks low-entropy (about ${bits} bits, want ${ENCRYPTION_KEY_MIN_BITS}+). A new key cannot read the secrets the old one encrypted: re-enter them after switching (generate one with: openssl rand -hex 32)`)
		}
	}

	if (env.POWDER_DB_PASSWORD && PLACEHOLDER_RE.test(env.POWDER_DB_PASSWORD)) {
		problems.push(`POWDER_DB_PASSWORD is still CHANGE_ME (set a real password in ${env.POWDER_ENV_FILE || '/opt/apps/powder.env'})`)
	}
	if (env.DATABASE_URL && PLACEHOLDER_RE.test(env.DATABASE_URL)) {
		problems.push('DATABASE_URL still contains a CHANGE_ME placeholder (set the real database password)')
	}
	return problems
}

/** Env vars that powder ignores. Logged once at boot. */
export function ignoredEnvNotes(env: NodeJS.ProcessEnv = process.env): string[] {
	const notes: string[] = []
	if (env.POWDER_SINGLE_TENANT !== undefined) {
		notes.push('POWDER_SINGLE_TENANT is ignored: powder is always single-tenant (only POWDER_ADMIN_USER_IDS may use it)')
	}
	return notes
}

// ── Backup passphrase strength (warning only) ───────────────────────────────
// POWDER_BACKUP_KEY is the openssl passphrase for every app's backups
// (AES-256-CBC, PBKDF2 with openssl's default 10k iterations). A short or
// human-chosen value can be guessed offline by anyone who gets one encrypted
// dump. A weak key only WARNS: refusing to boot would stop backups, and old
// backups must stay restorable with the key they were made with.
const BACKUP_KEY_MIN_LENGTH = 32
// Shannon estimate (bits per char x length). `openssl rand -hex 32` scores
// about 240, `openssl rand -base64 32` about 220; a repeated or tiny alphabet
// scores far below.
const BACKUP_KEY_MIN_BITS = 100

export function estimatedEntropyBits(value: string): number {
	if (!value) return 0
	const counts = new Map<string, number>()
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
	const n = [...value].length
	let perChar = 0
	for (const c of counts.values()) {
		const p = c / n
		perChar -= p * Math.log2(p)
	}
	return perChar * n
}

export function backupKeyWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
	const key = env.POWDER_BACKUP_KEY
	if (!key) return []
	const fix = 'generate one with: openssl rand -hex 32. Keep the old key: backups made with it still need it to restore'
	if (PLACEHOLDER_RE.test(key)) {
		return [`POWDER_BACKUP_KEY is still a placeholder (${fix})`]
	}
	const len = [...key].length
	if (len < BACKUP_KEY_MIN_LENGTH) {
		return [`POWDER_BACKUP_KEY is only ${len} characters, under ${BACKUP_KEY_MIN_LENGTH}: backups can be brute-forced offline (${fix})`]
	}
	const bits = Math.round(estimatedEntropyBits(key))
	if (bits < BACKUP_KEY_MIN_BITS) {
		return [`POWDER_BACKUP_KEY looks low-entropy (about ${bits} bits, want ${BACKUP_KEY_MIN_BITS}+): backups can be brute-forced offline (${fix})`]
	}
	return []
}

/** BETTER_AUTH_URL should be https (session cookies and OAuth callbacks
 *  travel over it). http://localhost / 127.0.0.1 / [::1] are fine for a local install.
 *  Warning only. */
export function authUrlWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = (env.BETTER_AUTH_URL ?? '').trim()
	if (!raw || env.NODE_ENV !== 'production') return []
	// An invalid value is a boot problem (productionConfigProblems), not a warning.
	if (!authUrlOrigin(env)) return []
	const u = new URL(raw)
	if (u.protocol === 'https:') return []
	if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return []
	return [`BETTER_AUTH_URL is ${u.protocol}//${u.host}, not https: session cookies and the GitHub login travel in clear text. Put powder behind TLS (Traefik with a cert resolver) and set an https:// origin`]
}

/** Every boot-time warning (logged, never fatal). */
export function startupWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
	return [...backupKeyWarnings(env), ...authUrlWarnings(env)]
}

/** Throws (so the process exits and compose shows the reason) on any problem. */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
	const problems = productionConfigProblems(env)
	if (problems.length === 0) return
	throw new Error(`refusing to start, unsafe configuration:\n - ${problems.join('\n - ')}`)
}

/** Boot-time entry: log the problems and exit(1). A thrown error in
 *  instrumentation register() leaves `next start` running and answering 500s,
 *  so the process must exit for compose to show the reason and restart it. */
export function exitOnBadProductionConfig(
	env: NodeJS.ProcessEnv = process.env,
	exit: (code: number) => void = (c) => process.exit(c),
): void {
	const problems = productionConfigProblems(env)
	if (problems.length === 0) return
	console.error(`refusing to start, unsafe configuration:\n - ${problems.join('\n - ')}`)
	exit(1)
}
