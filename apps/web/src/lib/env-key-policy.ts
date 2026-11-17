// tokenEnvWriteRefusal is the one rule: an env var is code execution when the key is one a runtime,
// loader or shell reads at start (NODE_OPTIONS=--require, LD_PRELOAD, BASH_ENV,
// PYTHONSTARTUP, ...) or one that steers docker/compose/git/ssh. Writing one is
// therefore refused on every env write path unless the caller is an admin
// browser session (never a bearer token, scoped or not). On top of these
// deny rules a token may only write or delete credential-shaped keys
// (isCredentialShapedEnvKey) or keys the operator allows (POWDER_TOKEN_ENV_ALLOW);
// NODE_OPTIONS allowed that way keeps a small allow-list of value flags.
//
// Only writes are checked. Deploys render whatever the DB already holds, so an
// app that already carries one of these keys keeps deploying unchanged.

const LOADER_KEYS: ReadonlySet<string> = new Set([
	'NODE_OPTIONS',
	'NODE_PATH',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'LD_AUDIT',
	'BASH_ENV',
	'ENV',
	'PROMPT_COMMAND',
	'PYTHONSTARTUP',
	'PYTHONPATH',
	'PYTHONHOME',
	'PERL5OPT',
	'PERL5LIB',
	'RUBYOPT',
	'RUBYLIB',
	'JAVA_TOOL_OPTIONS',
	'_JAVA_OPTIONS',
	'JDK_JAVA_OPTIONS',
	'DOTNET_STARTUP_HOOKS',
	'HOME',
	'PATH',
	'SHELL',
	// Java launchers and Tomcat read these at start (-javaagent, ...).
	'JAVA_OPTS',
	'CATALINA_OPTS',
	// TLS trust and proxies: a token could turn off certificate checks or send
	// every outbound request (and its credentials) through a host it picks.
	'NODE_TLS_REJECT_UNAUTHORIZED',
	'NODE_USE_ENV_PROXY',
	'NODE_EXTRA_CA_CERTS',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'REQUESTS_CA_BUNDLE',
	'CURL_CA_BUNDLE',
	'PYTHONHTTPSVERIFY',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
])

// package managers and toolchains read their config, registry, cache
// and install hooks from their own families (corepack fetches and runs a package
// manager named by COREPACK_*), and the runtimes from theirs. No NODE_ prefix here
// (NODE_ENV is refused for tokens by the positive rule, not this list). Case-insensitive.
const LOADER_PREFIXES: readonly string[] = [
	'COMPOSE_',
	'DOCKER_',
	'GIT_',
	'SSH_',
	'NPM_',
	'COREPACK_',
	'PNPM_',
	'YARN_',
	'BUN_',
	'UV_',
	'POETRY_',
	'PIPENV_',
	'PIP_',
	'PRISMA_',
	'DENO_',
	'CGO_',
	'PHP',
	'PYTHON',
	'RUBY',
	'GEM_',
	'BUNDLE_',
	'PERL',
	'JAVA_',
	'SPRING_',
	'MANAGEMENT_',
]

// keys the C library, the shell or a runtime reads at start.
const LOADER_EXACT_EXTRA: readonly string[] = [
	'SHELLOPTS',
	'BASHOPTS',
	'PS4',
	'HOSTALIASES',
	'GCONV_PATH',
	'LOCPATH',
	'RES_OPTIONS',
	'LOCALDOMAIN',
	'CLASSPATH',
	'NODE_ICU_DATA',
	'SPRING_APPLICATION_JSON',
	'LOGGING_CONFIG',
]

/** the Go toolchain's variables (GOPROXY, GOFLAGS, GOTOOLCHAIN, GOPATH, ...): one
 *  word after GO, no underscore, so GOOGLE_CLIENT_ID stays an ordinary key. */
const GO_TOOLCHAIN_RE = /^GO[A-Z0-9]+$/

// keys that decide where an app connects or sends data (a token could send a
// secret it cannot read, such as MAIL_API_KEY next to MAIL_API_URL, to a host it picks),
// or which file / directory / config it loads.
const DESTINATION_SUFFIXES: readonly string[] = [
	'_URL',
	'_URI',
	'_HOST',
	'_HOSTNAME',
	'_ENDPOINT',
	'_DSN',
	'_SERVER',
	'_ADDR',
	'_ADDRESS',
	'_REGISTRY',
	'_MIRROR',
	'_HOME',
	'_PATH',
	'_DIR',
	'_FILE',
	'_CONFIG',
	'_PROXY',
]
const DESTINATION_PREFIXES: readonly string[] = ['OTEL_', 'SENTRY_', 'PG', 'MYSQL_', 'MONGO', 'REDIS']
// the marker in the middle (DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING,
// NEXTAUTH_URL_INTERNAL).
const DESTINATION_INFIXES: readonly string[] = ['_URL_', '_URI_', '_HOST_', '_DSN_', '_ENDPOINT_', '_ADDR_', '_SERVER_']

/** for a bearer-token write also any key that looks like runtime options or a
 *  proxy setting (`*_OPTS`, `*OPTIONS*`, `*PROXY*`), case-insensitive. */
function tokenDeniedShape(key: string): boolean {
	const k = key.toUpperCase()
	return k.includes('OPTIONS') || k.includes('_OPTS') || k.includes('PROXY')
}

/** a destination / config-shaped key (see DESTINATION_SUFFIXES). */
function isDestinationEnvKey(key: string): boolean {
	const k = key.toUpperCase()
	return (
		DESTINATION_SUFFIXES.some((x) => k.endsWith(x)) ||
		DESTINATION_PREFIXES.some((p) => k.startsWith(p)) ||
		DESTINATION_INFIXES.some((x) => k.includes(x))
	)
}

const NODE_OPTIONS_FLAG =
	'(?:--max-old-space-size=\\d+|--enable-source-maps|--dns-result-order=\\w+)'
const NODE_OPTIONS_SAFE_RE = new RegExp(`^${NODE_OPTIONS_FLAG}(?: ${NODE_OPTIONS_FLAG})*$`)

/** True for a runtime-loader / injection key. Case-insensitive on purpose:
 *  a lowercase twin is never a legitimate app setting either. */
export function isLoaderEnvKey(key: string): boolean {
	const k = key.toUpperCase()
	return (
		LOADER_KEYS.has(k) ||
		LOADER_EXACT_EXTRA.includes(k) ||
		GO_TOOLCHAIN_RE.test(k) ||
		LOADER_PREFIXES.some((p) => k.startsWith(p))
	)
}

function isSafeNodeOptions(value: string): boolean {
	return NODE_OPTIONS_SAFE_RE.test(value)
}

/** the POSITIVE half of the token rule. A key a token may write or delete is
 *  credential-shaped: it ends with `_SECRET`, `_TOKEN`, `_API_KEY` or `_KEY`, or has a
 *  `_SECRET_` / `_TOKEN_` segment (e.g. WEBHOOK_SECRET_<APP>, MAILER_TOKEN_<APP>; the
 *  rule matches the shape, never a literal name). A key with a `PUBLIC` segment (`NEXT_PUBLIC_*`,
 *  `*_PUBLIC_KEY`: client bundles, signature checks) never is. Case-insensitive. */
export function isCredentialShapedEnvKey(key: string): boolean {
	const k = key.toUpperCase()
	if (/(^|_)PUBLIC(_|$)/.test(k)) return false
	return (
		k.endsWith('_SECRET') ||
		k.endsWith('_TOKEN') ||
		k.endsWith('_API_KEY') ||
		k.endsWith('_KEY') ||
		k.includes('_SECRET_') ||
		k.includes('_TOKEN_')
	)
}

/** the operator's extra allow rule for tokens, POWDER_TOKEN_ENV_ALLOW: a regex
 *  matched against the whole key (case-sensitive), empty by default. A pattern that does
 *  not compile allows nothing. The deny rules still apply to a key it allows. */
export function tokenEnvOperatorAllows(key: string, pattern = process.env.POWDER_TOKEN_ENV_ALLOW ?? ''): boolean {
	const p = pattern.trim()
	if (!p) return false
	try {
		return new RegExp(`^(?:${p})$`).test(key)
	} catch {
		return false
	}
}

/** THE rule for an env write or delete that does not come from an admin
 *  browser session (a bearer token, scoped or not), used by every env write path
 *  (setForProject and so the rollback and the env-file write-through, bulk import, the
 *  env-file PUT, /api/apps) and the deletes (DELETE /api/projects/<id>/env/<key>, keys
 *  an env-file PUT drops). Reason it is refused, or null. Refused: a value with a line
 *  break (any key); a runtime-loader / toolchain key (isLoaderEnvKey) or an options /
 *  proxy shaped one, except NODE_OPTIONS with only the safe flags; a destination /
 *  config-shaped key (isDestinationEnvKey); and every key that is neither
 *  credential-shaped (isCredentialShapedEnvKey) nor allowed by POWDER_TOKEN_ENV_ALLOW
 *  (so NODE_ENV, DEBUG, CORS_ORIGIN, NEXT_PUBLIC_* are refused). Such keys are set from
 *  the dashboard by an admin. */
export function tokenEnvWriteRefusal(
	key: string,
	value: string,
	action: 'set' | 'delete' = 'set',
	// who is refused: a bearer token, or a human browser session that is not an
	// admin's. Only the wording differs; the rule is the same.
	caller: EnvRefusalCaller = 'token',
): string | null {
	const verb = action === 'set' ? 'set' : 'delete'
	const session = caller === 'session'
	const dash = session
		? `only an admin can ${verb} it, from the dashboard`
		: `${action} it from the dashboard (an admin browser session); a token cannot`
	const who = session ? 'a non-admin user' : 'a token'
	if (/[\r\n]/.test(value))
		return `the value of ${key} has a line break, which ${session ? 'only an admin may set' : 'a token write may not set'}: ${dash}`
	const k = key.toUpperCase()
	if (isLoaderEnvKey(key) || tokenDeniedShape(key)) {
		if (k === 'NODE_OPTIONS' && action === 'set' && isSafeNodeOptions(value) && tokenEnvOperatorAllows(key)) return null
		return `${key} changes how the app's runtime, its package manager or the deploy starts, so ${session ? '' : `only an admin browser session can ${verb} it: `}${dash}${
			k === 'NODE_OPTIONS' && action === 'set'
				? ` (with NODE_OPTIONS in POWDER_TOKEN_ENV_ALLOW, ${session ? 'non-admin users' : 'tokens'} may set it to --max-old-space-size=N, --enable-source-maps, --dns-result-order=X)`
				: ''
		}`
	}
	if (isDestinationEnvKey(key))
		return `${key} decides where the app connects, sends data or loads files from, so ${session ? '' : `only an admin browser session can ${verb} it: `}${dash}`
	if (isCredentialShapedEnvKey(key) || tokenEnvOperatorAllows(key)) return null
	return `${key} is not a credential key ${who} may ${verb} (${who} may only ${verb} keys ending in _SECRET, _TOKEN, _API_KEY or _KEY, or with a _SECRET_ / _TOKEN_ segment, never NEXT_PUBLIC_* or *_PUBLIC_KEY, plus keys the operator allows in POWDER_TOKEN_ENV_ALLOW): ${dash}`
}

/** Who an env refusal is worded for: an API token, or a non-admin browser session. */
export type EnvRefusalCaller = 'token' | 'session'

export function envKeyDeleteDenied(key: string, adminSession: boolean, caller: EnvRefusalCaller = 'token'): string | null {
	return adminSession ? null : tokenEnvWriteRefusal(key, '', 'delete', caller)
}

/** Reason the write is refused, or null when it is allowed. `adminSession` is an admin's
 *  browser session (isAdmin and not a token): always allowed. Otherwise
 *  tokenEnvWriteRefusal decides. */
export function envKeyWriteDenied(
	key: string,
	value: string,
	adminSession: boolean,
	caller: EnvRefusalCaller = 'token',
): string | null {
	return adminSession ? null : tokenEnvWriteRefusal(key, value, 'set', caller)
}

/** an import / backfill response names the keys it skipped under this rule. */
export function deniedNote(keys: readonly string[]): { deniedNote?: string } {
	return keys.length
		? { deniedNote: `not imported (only an admin browser session can set them; set them from the dashboard): ${keys.join(', ')}` }
		: {}
}

export class EnvKeyDeniedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'EnvKeyDeniedError'
	}
}

/** the one answer to every token refusal of an env file save. */
export const TOKEN_ENV_FILE_REFUSAL =
	'an API token may save this env file only when every key in it (changed or not, and every key it drops) is a credential key a token may write, and the file on disk matches powder (no restored snapshot left); save it from the dashboard (an admin browser session), or set single keys with the project env API'

export function isAdminSession(user: { isAdmin: boolean; viaToken?: boolean }): boolean {
	return user.isAdmin === true && user.viaToken !== true
}
