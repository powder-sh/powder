// Shared .env parse/serialize pair used by every env editor in the dashboard.
// serializeEnv quotes only when needed and escapes \ " $ ` inside double quotes,
// and encodes CR/LF as \r / \n (same reading as docker compose's dotenv);
// parseRawEnv reverses exactly that, so values round-trip unchanged. A key that
// contains a newline or "=" cannot be encoded and makes serializeEnv throw (L-4).

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** /new input check (L-4): returns an error message or null. */
export function envVarInputError(e: unknown): string | null {
	const x = e as { key?: unknown; value?: unknown } | null
	if (typeof x?.key !== 'string' || typeof x?.value !== 'string') return 'env var needs string key and value'
	if (!ENV_KEY_RE.test(x.key) || x.key.length > 200)
		return `invalid env key ${JSON.stringify(x.key.slice(0, 60))}: must match [A-Za-z_][A-Za-z0-9_]*`
	if (/[\r\n]/.test(x.value)) return `env value for ${x.key} must not contain a newline`
	return null
}

export interface EnvEntry {
	key: string
	value: string
}

export function parseRawEnv(text: string): EnvEntry[] {
	const out: EnvEntry[] = []
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim()
		if (!line || line.startsWith('#')) continue
		if (/^export\s+/.test(line)) line = line.replace(/^export\s+/, '')
		const eq = line.indexOf('=')
		if (eq === -1) continue
		const key = line.slice(0, eq).trim()
		if (!key) continue
		const rest = line.slice(eq + 1).trim()
		let value = rest
		if (rest.startsWith('"')) {
			// find the closing unescaped quote
			let i = 1
			let buf = ''
			let closed = false
			while (i < rest.length) {
				const c = rest[i] as string
				if (c === '\\' && i + 1 < rest.length) {
					const n = rest[i + 1] as string
					if (n === '"' || n === '\\' || n === '$' || n === '`') {
						buf += n
						i += 2
						continue
					}
					if (n === 'n' || n === 'r') {
						buf += n === 'n' ? '\n' : '\r'
						i += 2
						continue
					}
					buf += c
					i++
					continue
				}
				if (c === '"') {
					closed = true
					break
				}
				buf += c
				i++
			}
			value = closed ? buf : rest
		} else if (rest.startsWith("'")) {
			const end = rest.indexOf("'", 1)
			value = end === -1 ? rest : rest.slice(1, end)
		} else {
			// unquoted: strip trailing inline comment (" #...")
			const hash = rest.search(/\s#/)
			if (hash >= 0) value = rest.slice(0, hash).trimEnd()
		}
		out.push({ key, value })
	}
	return out
}

/** The ONE env value encoder (render, /new, env-file editor all use it).
 *  Bare when the value is plain; otherwise double-quoted with \ " $ ` escaped
 *  and CR/LF written as \r / \n, which parseRawEnv (and docker compose's
 *  dotenv) read back exactly. */
export function encodeEnvValue(value: string): string {
	if (value === '') return ''
	if (/^[A-Za-z0-9_./:@+,=-]+$/.test(value)) return value
	const escaped = value
		.replace(/(["\\$`])/g, '\\$1')
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n')
	return `"${escaped}"`
}

export function serializeEnv(entries: EnvEntry[]): string {
	const lines = entries
		.filter((e) => e.key)
		.map((e) => {
			if (/[\r\n=]/.test(e.key)) throw new Error(`invalid env key (newline or "=" not allowed): ${JSON.stringify(e.key.slice(0, 60))}`)
			const v = encodeEnvValue(e.value)
			return `${e.key}=${v}`
		})
	return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * Keys that never live in the DB: powder injects them at deploy time or Docker
 * / Node sets them as runtime defaults. The deploy-time drift guard
 * (env-vars-db.ts) and the env-file write-through (env-file route) both skip
 * them.
 */
export const RENDER_NOISE_KEYS = new Set([
	// Powder injects these at deploy time, not stored in DB by design
	'HQ_INGEST_TOKEN',
	'HQ_PROJECT',
	// Docker / Node runtime defaults - not app config, never the user's intent
	'HOSTNAME',
	'PORT',
	'NODE_ENV',
	'NODE_VERSION',
	'YARN_VERSION',
	'NEXT_TELEMETRY_DISABLED',
])
