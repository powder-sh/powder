// Pure helpers for powder-managed crons: schedule parsing, exec argv handling,
// the overlap guard's stale cutoff, and the host-crontab "Import" mapping.
// No db / ssh imports: used by the scheduler, the API routes and the browser.

import { CronExpressionParser } from 'cron-parser'
import { MASK, SECRET_NAME_RE } from './secret-text'

/** a query value that looks like a token: 20 or more characters of the
 *  base64url / hex alphabet (optional = padding). */
const TOKEN_VALUE_RE = /^[A-Za-z0-9_-]{20,}={0,2}$/
import { assertSafeName, shq } from './shell'

const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 3600
export const DEFAULT_TIMEOUT_SECONDS = 30
// A running_since older than timeout + this grace means the run's process died
// (worker restart mid-run). The next firing may then claim the job again.
export const STALE_RUN_GRACE_MS = 60_000
const MAX_ARGV_ITEMS = 64
const MAX_ARG_CHARS = 4096

const FIVE_FIELDS_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isValidTimezone(tz: string): boolean {
	if (!tz) return false
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz })
		return true
	} catch {
		return false
	}
}

/** Next firing strictly after `after`, or null if the schedule or zone is invalid. */
export function computeNextRun(schedule: string, after: Date, timezone = 'UTC'): Date | null {
	const s = schedule.trim()
	if (!FIVE_FIELDS_RE.test(s)) return null
	if (!isValidTimezone(timezone)) return null
	try {
		const it = CronExpressionParser.parse(s, { currentDate: after, tz: timezone })
		return it.next().toDate()
	} catch {
		return null
	}
}

/** Validation message for a schedule + zone pair, or null when both are fine. */
export function scheduleError(schedule: string, timezone: string): string | null {
	const s = schedule.trim()
	if (!FIVE_FIELDS_RE.test(s))
		return 'schedule must be a 5-field cron expression (e.g. "0 6 * * *")'
	if (!isValidTimezone(timezone)) return `unknown timezone "${timezone}"`
	if (computeNextRun(s, new Date(), timezone) === null) return `couldn't parse schedule "${s}"`
	return null
}

export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name)
}

export function clampTimeout(n: unknown): number {
	const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULT_TIMEOUT_SECONDS
	return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, v))
}

/** Overlap guard: a run that started before this instant is treated as dead. */
export function staleRunCutoff(now: Date, timeoutSeconds: number): Date {
	return new Date(now.getTime() - clampTimeout(timeoutSeconds) * 1000 - STALE_RUN_GRACE_MS)
}

/** True when a new run may start: nothing running, or the running mark is stale. */
export function canStartRun(runningSince: Date | null, now: Date, timeoutSeconds: number): boolean {
	if (!runningSince) return true
	return runningSince.getTime() <= staleRunCutoff(now, timeoutSeconds).getTime()
}

// ── argv ────────────────────────────────────────────────────────────────────

export type SplitResult =
	| { ok: true; argv: string[]; shellSyntax: boolean }
	| { ok: false; error: string }

const SHELL_OPS = new Set(['|', '&', ';', '<', '>', '(', ')', '`'])

/**
 * Split a command line into argv the way a POSIX shell tokenises words, WITHOUT
 * any expansion: single quotes are literal, double quotes allow \" \\ \$ \`,
 * a backslash outside quotes escapes the next char. `shellSyntax` reports an
 * unquoted operator (| & ; < > ( ) `) or a `$` outside single quotes, i.e. the
 * line only means what it says when a shell runs it. Powder never runs one.
 */
export function splitArgv(line: string): SplitResult {
	const argv: string[] = []
	let cur = ''
	let inWord = false
	let shellSyntax = false
	let i = 0
	const s = line
	while (i < s.length) {
		const c = s[i] ?? ''
		if (c === "'") {
			const end = s.indexOf("'", i + 1)
			if (end < 0) return { ok: false, error: 'unterminated single quote' }
			cur += s.slice(i + 1, end)
			inWord = true
			i = end + 1
			continue
		}
		if (c === '"') {
			i++
			let closed = false
			while (i < s.length) {
				const d = s[i] ?? ''
				if (d === '"') {
					closed = true
					i++
					break
				}
				if (d === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1] ?? '')) {
					cur += s[i + 1]
					i += 2
					continue
				}
				if (d === '$' || d === '`') shellSyntax = true
				cur += d
				i++
			}
			if (!closed) return { ok: false, error: 'unterminated double quote' }
			inWord = true
			continue
		}
		if (c === '\\') {
			if (i + 1 < s.length) cur += s[i + 1]
			inWord = true
			i += 2
			continue
		}
		if (/\s/.test(c)) {
			if (inWord) argv.push(cur)
			cur = ''
			inWord = false
			i++
			continue
		}
		if (SHELL_OPS.has(c) || c === '$') shellSyntax = true
		cur += c
		inWord = true
		i++
	}
	if (inWord) argv.push(cur)
	return { ok: true, argv, shellSyntax }
}

/** Validation message for a stored argv, or null. */
function argvError(argv: unknown): string | null {
	if (!Array.isArray(argv) || argv.length === 0) return 'command is empty'
	if (argv.length > MAX_ARGV_ITEMS) return `at most ${MAX_ARGV_ITEMS} arguments`
	for (const a of argv) {
		if (typeof a !== 'string') return 'every argument must be a string'
		if (a.length > MAX_ARG_CHARS) return `an argument is longer than ${MAX_ARG_CHARS} characters`
		if (a.includes('\0')) return 'arguments cannot contain NUL'
	}
	if ((argv[0] as string).length === 0) return 'the program name is empty'
	return null
}

/** Human display of argv: bare words as-is, anything else single-quoted. */
export function argvToDisplay(argv: string[]): string {
	return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : shq(a))).join(' ')
}

/**
 * The host command for an exec job. Every argv element is shq-quoted, so the
 * host shell only sees literal words: no expansion, no operators. coreutils
 * `timeout` on the host bounds the docker client; the SSH timeout is a backstop.
 */
export function buildExecHostCommand(
	container: string,
	argv: string[],
	timeoutSeconds: number,
): string {
	const name = assertSafeName(container)
	const err = argvError(argv)
	if (err) throw new Error(err)
	const secs = clampTimeout(timeoutSeconds)
	return `timeout --kill-after=5 ${secs} docker exec ${name} ${argv.map(shq).join(' ')}`
}

// ── host crontab import ─────────────────────────────────────────────────────

interface ImportDraft {
	schedule: string
	timezone: string
	kind: 'http' | 'exec'
	httpMethod: 'GET' | 'POST'
	urlPath: string | null
	bearerEnvVar: string | null
	execArgv: string[] | null
	description: string | null
	importedFrom: string
}

export type ImportResult =
	| { ok: true; draft: ImportDraft; warnings: string[] }
	| { ok: false; reason: string }

// docker exec flags that take a value (short and long forms).
const EXEC_VALUE_FLAGS = new Set([
	'-e',
	'--env',
	'-u',
	'--user',
	'-w',
	'--workdir',
	'--env-file',
	'--detach-keys',
])

// Trailing host-side output redirection: `>> /var/log/x.log 2>&1`, `> /dev/null`.
const TRAILING_REDIRECT_RE = /(\s+(?:\d?>>?|&>>?)\s*(?:&\d|\S+))+\s*$/

/**
 * Map one host crontab line (already split into schedule + command by
 * parseCrontab) to a managed-job draft for `containerName`. Never edits the
 * host crontab: the caller tells the user to remove the line after verifying.
 * The host cron daemon's zone is unknown here, so the draft says UTC and warns.
 */
export function mapHostCron(
	schedule: string,
	command: string,
	containerName: string,
	comment: string | null = null,
): ImportResult {
	if (!FIVE_FIELDS_RE.test(schedule.trim())) {
		return { ok: false, reason: 'only 5-field schedules can be imported' }
	}
	const importedFrom = `${schedule.trim()} ${command.trim()}`
	const warnings: string[] = [
		'the host cron daemon uses the server timezone; check the timezone below (default UTC)',
	]
	let cmd = command.trim()
	if (TRAILING_REDIRECT_RE.test(cmd)) {
		cmd = cmd.replace(TRAILING_REDIRECT_RE, '').trim()
		warnings.push('output redirection dropped: powder records the output of every run')
	}
	const split = splitArgv(cmd)
	if (!split.ok) return { ok: false, reason: `could not read the command: ${split.error}` }
	const words = split.argv
	const base = {
		schedule: schedule.trim(),
		timezone: 'UTC',
		description: comment,
		importedFrom,
	}

	// HTTP: curl / wget against a URL on the app.
	if (words[0] === 'curl' || words[0] === 'wget' || /\/(curl|wget)$/.test(words[0] ?? '')) {
		return mapHttp(words, base, warnings, split.shellSyntax)
	}

	// docker exec [flags] <container> <argv...>
	if (words[0] === 'docker' && words[1] === 'exec') {
		let i = 2
		const dropped: string[] = []
		while (i < words.length && (words[i] ?? '').startsWith('-')) {
			const f = words[i] ?? ''
			const flagName = f.includes('=') ? f.slice(0, f.indexOf('=')) : f
			if (EXEC_VALUE_FLAGS.has(flagName) && !f.includes('=')) {
				dropped.push(`${f} ${words[i + 1] ?? ''}`.trim())
				i += 2
			} else {
				if (!/^-(i|t|it|ti)$|^--(interactive|tty)$/.test(f)) dropped.push(f)
				i++
			}
		}
		const target = words[i]
		if (!target) return { ok: false, reason: 'docker exec line has no container' }
		if (target !== containerName) {
			return { ok: false, reason: `the line runs in container "${target}", not ${containerName}` }
		}
		const argv = words.slice(i + 1)
		if (argv.length === 0) return { ok: false, reason: 'docker exec line has no command' }
		if (split.shellSyntax) {
			return {
				ok: false,
				reason:
					'the line uses host shell syntax (pipes, &&, $VARS) around docker exec; recreate it by hand, e.g. as sh -c inside the container',
			}
		}
		if (dropped.length > 0) {
			warnings.push(`docker exec flags not carried over: ${dropped.join(', ')}`)
		}
		const err = argvError(argv)
		if (err) return { ok: false, reason: err }
		return {
			ok: true,
			warnings,
			draft: {
				...base,
				kind: 'exec',
				httpMethod: 'POST',
				urlPath: null,
				bearerEnvVar: null,
				execArgv: argv,
			},
		}
	}

	return {
		ok: false,
		reason:
			'the line runs on the host, not inside the app container or over HTTP; powder only runs http and docker exec jobs',
	}
}

function mapHttp(
	words: string[],
	base: { schedule: string; timezone: string; description: string | null; importedFrom: string },
	warnings: string[],
	shellSyntax: boolean,
): ImportResult {
	const isWget = /wget$/.test(words[0] ?? '')
	let method: 'GET' | 'POST' = 'GET'
	let url: string | null = null
	let bearerEnvVar: string | null = null
	for (let i = 1; i < words.length; i++) {
		const w = words[i] ?? ''
		const next = words[i + 1]
		if (!isWget && (w === '-X' || w === '--request') && next) {
			method = next.toUpperCase() === 'GET' ? 'GET' : 'POST'
			if (!['GET', 'POST'].includes(next.toUpperCase())) {
				warnings.push(`method ${next} mapped to POST (powder sends GET or POST)`)
			}
			i++
			continue
		}
		if (!isWget && /^-X[A-Z]+$/.test(w)) {
			method = w.slice(2) === 'GET' ? 'GET' : 'POST'
			continue
		}
		if (!isWget && /^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form)$/.test(w)) {
			method = 'POST'
			warnings.push('request body not carried over: powder sends an empty body')
			i++
			continue
		}
		if (isWget && /^--post-(data|file)(=|$)/.test(w)) {
			method = 'POST'
			warnings.push('request body not carried over: powder sends an empty body')
			if (!w.includes('=')) i++
			continue
		}
		if ((w === '-H' || w === '--header') && next) {
			const m = next.match(/^authorization:\s*bearer\s+(.+)$/i)
			if (m) {
				const v = (m[1] ?? '').trim()
				const ref = v.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
				if (ref) bearerEnvVar = ref[1] ?? ''
				else
					warnings.push(
						'the line sends a literal bearer token: store it as an app env var and enter its name below',
					)
			}
			i++
			continue
		}
		if (isWget && /^--header=/.test(w)) {
			const m = w.slice('--header='.length).match(/^authorization:\s*bearer\s+(.+)$/i)
			if (m) {
				const ref = (m[1] ?? '').trim().match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
				if (ref) bearerEnvVar = ref[1] ?? ''
			}
			continue
		}
		if (/^https?:\/\//i.test(w) && !url) url = w
	}
	if (!url) return { ok: false, reason: 'no http(s) URL found in the line' }
	let path: string
	try {
		const u = new URL(url)
		// urlPath is stored and shown as is (a PATCH sends it back, so it is never
		// masked on read). A query parameter whose name marks a secret (`?token=...`) is
		// dropped here, with a note: the value belongs in an app env var sent as the bearer
		// header (bearerEnvVar).
		const kept: string[] = []
		const dropped: string[] = []
		for (const part of u.search.replace(/^\?/, '').split('&')) {
			if (part === '') continue
			const rawName = part.split('=')[0] ?? ''
			let name = rawName
			try {
				name = decodeURIComponent(rawName.replace(/\+/g, ' '))
			} catch {
				// keep the raw name
			}
			// also a value that looks like a token (20+ chars of base64url / hex),
			// whatever its parameter is called (`?k=3f9a...`).
			const rawValue = part.includes('=') ? part.slice(part.indexOf('=') + 1) : ''
			let value = rawValue
			try {
				value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
			} catch {
				// keep the raw value
			}
			if (SECRET_NAME_RE.test(name) || TOKEN_VALUE_RE.test(value)) dropped.push(name)
			else kept.push(part)
		}
		path = `${u.pathname || '/'}${kept.length ? `?${kept.join('&')}` : ''}`
		if (dropped.length)
			warnings.push(
				`query parameter(s) ${[...new Set(dropped)].join(', ')} dropped: powder stores and shows the URL path in plain text. Put the value in an app env var, make the endpoint accept it as a bearer token and enter the env var name below`,
			)
		warnings.push(
			`powder calls the app's own host (live custom domain or default host), not ${u.host}`,
		)
	} catch {
		return { ok: false, reason: `could not parse URL ${url}` }
	}
	if (shellSyntax && !bearerEnvVar) {
		warnings.push(
			'the line uses shell syntax; only the URL, method and bearer header were carried over',
		)
	}
	return {
		ok: true,
		warnings,
		draft: {
			...base,
			kind: 'http',
			httpMethod: method,
			urlPath: path,
			bearerEnvVar,
			execArgv: null,
		},
	}
}

// ── create / edit input ─────────────────────────────────────────────────────

export interface JobInput {
	schedule: string
	timezone: string
	kind: 'http' | 'exec'
	httpMethod: 'GET' | 'POST'
	urlPath: string | null
	bearerEnvVar: string | null
	execArgv: string[] | null
	timeoutSeconds: number
	description: string | null
	enabled: boolean
	importedFrom: string | null
}

/** Validate a create/edit body from the Crons tab. One authority for both routes. */
export function parseJobInput(
	body: unknown,
): { ok: true; job: JobInput } | { ok: false; error: string } {
	if (!body || typeof body !== 'object') return { ok: false, error: 'expected a JSON object' }
	const b = body as Record<string, unknown>
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
	const schedule = str(b.schedule)
	const timezone = str(b.timezone) || 'UTC'
	const sErr = scheduleError(schedule, timezone)
	if (sErr) return { ok: false, error: sErr }
	const kind =
		b.kind === 'exec' ? 'exec' : b.kind === 'http' || b.kind === undefined ? 'http' : null
	if (!kind) return { ok: false, error: 'kind must be "http" or "exec"' }
	const httpMethod = str(b.httpMethod).toUpperCase() === 'GET' ? 'GET' : 'POST'
	let urlPath: string | null = null
	let bearerEnvVar: string | null = null
	let execArgv: string[] | null = null
	if (kind === 'http') {
		urlPath = normalizeCronPath(str(b.urlPath))
		if (!urlPath)
			return { ok: false, error: 'path must be a path on the app, e.g. /api/cron/digest' }
		// Host cron lines are shown masked; a path carried over from one would store the mask.
		if (urlPath.includes(MASK))
			return {
				ok: false,
				error: `the path still contains ${MASK}: type the real value in its place`,
			}
		const bearer = str(b.bearerEnvVar)
		if (bearer && !isValidEnvName(bearer)) {
			return { ok: false, error: 'bearer env var must be an env var name, e.g. CRON_SECRET' }
		}
		bearerEnvVar = bearer || null
	} else {
		const err = argvError(b.execArgv)
		if (err) return { ok: false, error: err }
		// Host cron commands are shown masked; importing one as-is would store the mask.
		if ((b.execArgv as string[]).some((a) => a.includes(MASK))) {
			return {
				ok: false,
				error: `the command still contains ${MASK}: type the real value in its place`,
			}
		}
		execArgv = (b.execArgv as string[]).slice()
	}
	const description = str(b.description).slice(0, 200) || null
	const importedFrom = str(b.importedFrom).slice(0, 2000) || null
	return {
		ok: true,
		job: {
			schedule,
			timezone,
			kind,
			httpMethod,
			urlPath,
			bearerEnvVar,
			execArgv,
			timeoutSeconds: clampTimeout(b.timeoutSeconds),
			description,
			enabled: b.enabled === undefined ? true : b.enabled === true,
			importedFrom,
		},
	}
}

/** Normalise a user-entered http path; null when it is not a plain path. */
export function normalizeCronPath(raw: string | null | undefined): string | null {
	const p = (raw ?? '').trim()
	if (!p) return null
	// An absolute URL or protocol-relative path would let a job call any host.
	if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//') || p.includes('\\')) return null
	if (/\s/.test(p)) return null
	return p.startsWith('/') ? p : `/${p}`
}
