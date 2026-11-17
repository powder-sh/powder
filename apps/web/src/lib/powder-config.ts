// powder.json — code-defined deploy config in the user's repo.
// On every deploy, Powder reads <workingDir>/powder.json (if present) and
// translates the spec into Traefik middleware labels on the app's compose
// file. Vercel parity for "config in code, not dashboards."
//
// Supports `redirects`, `rewrites` (internal path rewrites) and `headers`
// (response headers on every response).
//
// Schema:
//   {
//     "redirects": [
//       { "from": "/old", "to": "/new", "permanent": true },
//       { "from": "/blog/(.*)", "to": "https://blog.x.com/$1", "permanent": true }
//     ],
//     "rewrites": [{ "source": "/docs/(.*)", "destination": "/help/$1" }],
//     "headers": { "X-Frame-Options": "DENY" }
//   }
//
// `from` is matched as an nginx-style regex against the request URI.
// `to` is the destination (path or absolute URL). `permanent` → 301 (default
// true). `false` → 302.

import { runCommand } from './ssh'
import type { ServerConfig } from './servers'
import { shq } from './shell'

interface PowderRedirect {
	from: string
	to: string
	permanent?: boolean
}

// Internal path rewrite: same backend, different path. The destination is
// passed to Traefik replacepathregex; capture refs use $1, $2, …
// External rewrites (proxy to a different host) are not supported.
interface PowderRewrite {
	source: string
	destination: string
}

export interface PowderConfig {
	redirects: PowderRedirect[]
	rewrites: PowderRewrite[]
	// Flat key/value map of headers added to ALL responses. App-wide: there
	// is no per-source filter.
	headers: Record<string, string>
}

const empty = (): PowderConfig => ({ redirects: [], rewrites: [], headers: {} })

export function parsePowderConfig(text: string): PowderConfig {
	let data: unknown
	try {
		data = JSON.parse(text)
	} catch {
		return empty()
	}
	if (typeof data !== 'object' || data === null) return empty()
	const obj = data as { redirects?: unknown; rewrites?: unknown; headers?: unknown }

	const redirects: PowderRedirect[] = []
	if (Array.isArray(obj.redirects)) {
		for (const raw of obj.redirects) {
			if (typeof raw !== 'object' || raw === null) continue
			const r = raw as Partial<PowderRedirect>
			if (typeof r.from !== 'string' || typeof r.to !== 'string') continue
			redirects.push({
				from: r.from,
				to: r.to,
				permanent: typeof r.permanent === 'boolean' ? r.permanent : true,
			})
		}
	}

	const rewrites: PowderRewrite[] = []
	if (Array.isArray(obj.rewrites)) {
		for (const raw of obj.rewrites) {
			if (typeof raw !== 'object' || raw === null) continue
			const r = raw as Partial<PowderRewrite>
			if (typeof r.source !== 'string' || typeof r.destination !== 'string') continue
			rewrites.push({ source: r.source, destination: r.destination })
		}
	}

	const headers: Record<string, string> = {}
	if (typeof obj.headers === 'object' && obj.headers !== null) {
		for (const [key, value] of Object.entries(obj.headers as Record<string, unknown>)) {
			if (typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(key)) {
				headers[key] = value
			}
		}
	}

	return { redirects, rewrites, headers }
}

/** Shell that prints powder.json: the checkout's own (<workingDir>/src/powder.json, the
 *  standard layout, where the repo's committed file lives) first, then the app-dir root
 *  (workdir layout). Regular files only, never a link. */
export function readPowderJsonShell(workingDir: string): string {
	const src = shq(`${workingDir}/src/powder.json`)
	const root = shq(`${workingDir}/powder.json`)
	return `if [ -f ${src} ] && [ ! -L ${src} ]; then cat ${src}; elif [ -f ${root} ] && [ ! -L ${root} ]; then cat ${root}; fi 2>/dev/null || true`
}

// Reads powder.json from the server (src/ first, then the app dir). Empty config if missing/invalid.
export async function readPowderConfig(
	server: ServerConfig,
	workingDir: string,
): Promise<PowderConfig> {
	const { stdout, code } = await runCommand(
		server,
		readPowderJsonShell(workingDir),
		5_000,
	)
	if (code !== 0 || !stdout.trim()) return empty()
	return parsePowderConfig(stdout)
}

// Returns Traefik label LINES (without the leading `      - ` indent) for
// the full powder.json config. Order in the chain: rewrites → redirects →
// headers (rewrite the path first, then check redirects, then add headers
// to the response).
export function buildTraefikLabels(
	containerName: string,
	cfg: PowderConfig,
): { middlewareLabels: string[]; middlewareChain: string } {
	const middlewareLabels: string[] = []
	const middlewareNames: string[] = []

	// an entry with a control char (newline etc.) in any value would
	// inject YAML into the compose file. Drop the whole entry and warn.
	const rewritesOk = cfg.rewrites.filter((r) => labelValuesSafe('rewrite', r.source, r.destination))
	const redirectsOk = cfg.redirects.filter((r) => labelValuesSafe('redirect', r.from, r.to))
	const headerKeys = Object.keys(cfg.headers).filter((k) =>
		labelValuesSafe('header', k, cfg.headers[k] ?? ''),
	)

	// 1) rewrites — replacepathregex middlewares
	rewritesOk.forEach((r, i) => {
		const mw = `${containerName}-rewrite-${i}`
		middlewareNames.push(mw)
		middlewareLabels.push(
			`traefik.http.middlewares.${mw}.replacepathregex.regex=${escapeForLabel(r.source)}`,
			`traefik.http.middlewares.${mw}.replacepathregex.replacement=${escapeForLabel(r.destination)}`,
		)
	})

	// 2) redirects — redirectregex middlewares
	redirectsOk.forEach((r, i) => {
		const mw = `${containerName}-redir-${i}`
		middlewareNames.push(mw)
		middlewareLabels.push(
			`traefik.http.middlewares.${mw}.redirectregex.regex=${escapeForLabel(r.from)}`,
			`traefik.http.middlewares.${mw}.redirectregex.replacement=${escapeForLabel(r.to)}`,
			`traefik.http.middlewares.${mw}.redirectregex.permanent=${r.permanent !== false}`,
		)
	})

	// 3) headers — single customresponseheaders middleware (one per header key)
	if (headerKeys.length > 0) {
		const mw = `${containerName}-headers`
		middlewareNames.push(mw)
		for (const key of headerKeys) {
			middlewareLabels.push(
				`traefik.http.middlewares.${mw}.headers.customresponseheaders.${key}=${escapeForLabel(cfg.headers[key] ?? '')}`,
			)
		}
	}

	return { middlewareLabels, middlewareChain: middlewareNames.join(',') }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS_RE = /[\r\n\u0000-\u001f\u007f\u2028\u2029]/

// the deploy's raw compose check refuses any compose file (powder's override
// included) holding these words or YAML escapes, so a label value carrying them would
// stop every deploy of the app. Dropped here instead, with a warning.
const COMPOSE_GUARD_WORDS_RE = /extends|include/i
const COMPOSE_GUARD_ESCAPES_RE = /\\[xuUN_LP]/

function labelValuesSafe(kind: string, ...values: string[]): boolean {
	if (values.some((v) => CONTROL_CHARS_RE.test(v))) {
		console.warn(`[powder.json] dropped ${kind} entry: control characters are not allowed`)
		return false
	}
	if (values.some((v) => COMPOSE_GUARD_WORDS_RE.test(v) || COMPOSE_GUARD_ESCAPES_RE.test(v))) {
		console.warn(
			`[powder.json] dropped ${kind} entry: the words "extends" / "include" (any case, e.g. includeSubDomains) and the escapes \\x \\u \\U \\N \\_ \\L \\P are not allowed in a compose label (the deploy's compose check refuses them); set that header in the app instead`,
		)
		return false
	}
	return true
}

function escapeForLabel(s: string): string {
	if (CONTROL_CHARS_RE.test(s)) throw new Error('control characters are not allowed in a label')
	// Traefik labels are key=value lines in compose YAML, and Traefik rules
	// quote values in backticks, so backticks are stripped from the value.
	return s.replace(/[`]/g, '')
}

