// THE authority for "what is a secret" in free text (deploy logs, git and SSH
// errors, cron output, notification bodies). Every other module that needs to
// mask text calls in here; none keeps its own regex set. Client-safe: no
// imports, so UI components can use it too.
//
// redactSecrets is the only function that mints SafeText. Sinks that leave
// powder (DB text columns for deploys, SSE, HQ, notifications, GitHub statuses,
// MCP results) take SafeText, so a raw string fails tsc at the call site.
//
// The rules cover llm-redact.ts redactSecrets (all of it), secret-mask.ts
// SENSITIVE_PARAM (query parameters), crons.ts maskSecrets (Bearer / PGPASSWORD= /
// password=, all covered by the name rule), plus the shapes those miss: glpat-, npm_, AIza,
// dop_v1_, hf_, Slack and Discord webhook URLs, `-u user:pass`, sensitive query
// parameters. One mask token: [redacted].

declare const SAFE_TEXT: unique symbol
/** Text that has been through redactSecrets. Only this module creates it. */
export type SafeText = string & { readonly [SAFE_TEXT]: true }

export const MASK = '[redacted]'

/** Names that mark a value as secret (env keys, JSON keys, query parameters). */
export const SECRET_NAME_RE = /pass|pwd|secret|token|key|auth|cred|dsn|private|signature/i

// A PEM private key: BEGIN ... END within 16 KB of key-body characters (no
// `-----` in between, which also stops the scan at the next marker), or,
// with no END (a truncated log), BEGIN plus the key-body lines right after it
// (whole base64 lines, Proc-Type / DEK-Info / Comment headers; each must end
// the line, so the first ordinary log line after a truncated key is kept whole;
// one blank line may follow the headers, as in old encrypted keys). A BEGIN
// marker inside ordinary text
// (`grep -q "-----BEGIN OPENSSH PRIVATE KEY-----" f`) masks the marker only and
// never swallows the rest of the log.
const PEM_RE =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:(?!-----)[A-Za-z0-9+/=:,.\s\\-]){0,16384}?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?:(?:\r?\n|\\n)(?:[A-Za-z0-9+/=]{1,128}\r?|(?:Proc-Type|DEK-Info|Comment): [^\n\\]{0,128}\r?(?:(?:\r?\n|\\n)(?=\r?\n|\\n))?)(?=\r?\n|\\n|$))*)/g
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/
// One key-body line (stream redactor), and "only key-body lines until the end".
const PEM_BODY_LINE_RE =
	/^(?:[A-Za-z0-9+/=]{1,128}|(?:Proc-Type|DEK-Info|Comment): [^\n\\]{0,128})\r?$/
const PEM_HEADER_LINE_RE = /^(?:Proc-Type|DEK-Info|Comment): [^\n\\]{0,128}\r?$/
const PEM_OPEN_TAIL_RE =
	/^(?:\r?\n(?:[A-Za-z0-9+/=]{1,128}\r?|(?:Proc-Type|DEK-Info|Comment): [^\n\\]{0,128}\r?(?:\r?\n(?=\r?\n))?)(?=\r?\n|$))*\r?\n?$/
const PEM_MAX_LINES = 400

// [pattern, replacement]. Order matters: multi-line and URL rules before the
// line rules, Bearer/Basic before the name rule (which would take `Bearer` as
// the value), token prefixes after it.
// Exported so a copy of these rules kept elsewhere can be pinned to them by a test.
export const SECRET_RULES: readonly (readonly [RegExp, string])[] = [
	// PEM private key blocks (multi-line), before any line-based rule sees them.
	[PEM_RE, MASK],
	// scheme://user:password@host. The userinfo needs a ':' before any '/', and
	// the '@' must be followed by a host (then end, port, path, query), so an
	// '@' in a path (registry.npmjs.org/@types/x) is not userinfo. The password
	// itself may contain '/', ':' and '@': the shortest match that
	// still ends in `@host` wins.
	[
		/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s'"<>/@:]{0,256}:[^\s'"<>]{0,256}?@(?=[A-Za-z0-9._~\[\]-]+(?:[:/?#\s'"<>),;]|$))/gi,
		`$1${MASK}@`,
	],
	// scheme://<token>@host: a long token-shaped bare username (classic 40-hex
	// PATs, Azure DevOps PATs, Gitea / Bitbucket tokens). Short names (git,
	// oauth2, x-access-token) stay.
	[
		/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[A-Za-z0-9._~%+-]{20,256}@(?=[A-Za-z0-9.-]+)/gi,
		`$1${MASK}@`,
	],
	// Webhook URLs whose path IS the credential.
	[/(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s'"<>]+/gi, `$1${MASK}`],
	[/(https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi, `$1${MASK}`],
	// Sensitive query parameters: ?token=, &access_key=, X-Amz-Signature= ...
	// The secret word must END the parameter name (?authorId= is not one).
	[
		/([?&][A-Za-z0-9_.-]{0,64}?(?:password|passwd|pwd|pass|secret|token|key|auth|credentials?|signature|sig)=)[^&\s#'"<>]+/gi,
		`$1${MASK}`,
	],
	// AWS secret access key values (40 chars) after an AWS secret-like key.
	[
		/\b(aws[A-Za-z0-9_ .-]{0,12}secret[A-Za-z0-9_ .-]{0,24}["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}\b/gi,
		`$1${MASK}`,
	],
	// curl -u user:pass / --user user:pass
	[/((?:^|\s)(?:-u|--user)\s+["']?[^\s:'"]{1,128}:)[^\s'"]+/g, `$1${MASK}`],
	// Authorization headers with any scheme (GitHub's `token x`), then bare Bearer/Basic.
	// A `$VAR` / `${VAR}` value is a reference to an env var, not a secret: kept.
	[
		/\b(Authorization["']?\s*:\s*["']?(?:Bearer|Basic|token)\s+)(?!\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?=[\s"']|$))[^\s"']+/gi,
		`$1${MASK}`,
	],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
	// Named values. A name counts only when its LAST word is a secret word
	// (any case: snake, kebab, Title-Case, camelCase, UPPER), so "authorId",
	// "authMode", "credits", "keyboard" and English text ("unauthorized:
	// authentication required", "Tests passed: 5") stay readable. A plain
	// *key name (cache keys, i18n keys) needs a secret-looking value (16+
	// chars, not a path or a number); api/secret/private/access/... keys
	// always mask. A bare word before ': ' (token:, key:, auth:) needs a
	// random-looking value. Values may be quoted with the closing quote
	// missing (a cut line); a shell reference ($VAR, ${VAR:-x}) or a semver
	// is never a value.
	//  - UPPER_SNAKE with the secret word anywhere: AUTH_HEADER=x, PRIVATE_THING=x
	[
		/(?<![\w$\{])\b((?:[A-Z0-9]+_){0,6}(?:[A-Z0-9]{0,32}(?:PASSWORD|PASSWD|SECRET|TOKEN)|PASS|PWD|PASSPHRASE|CREDENTIALS?|CRED|AUTH|DSN|PRIVATE|API_?KEY|(?:SECRET|PRIVATE|ACCESS|ENCRYPTION|SIGNING|MASTER|LICENSE|ACCOUNT)_KEY)(?:_[A-Z0-9]+){0,6})(["']?\s*[=:]\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"[^"\n]*"?|'[^'\n]*'?|[^\s"']+)/g,
		`$1$2${MASK}`,
	],
	//  - name=value, any case: Password=x; (connection strings), --token=x, api_key=x
	[
		/(?<![\w$\{])((?:[A-Za-z0-9]+[_.-]){0,6}(?:[A-Za-z0-9]{0,32}(?:password|passwd|passphrase|secret|token|apikey|api[_-]key|credentials?|authorization|private[_-]?key|client[_-]?secret|(?:api|secret|private|access|encryption|signing|master|license|account|shared[_-]?access)[_-]?key)|(?:pass|pwd|auth|dsn|cred)))(?![A-Za-z0-9_])(\s*=\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"[^"\n]*"?|'[^'\n]*'?|[^\s"']+)/gi,
		`$1$2${MASK}`,
	],
	[
		/(?<![\w$\{])((?:[A-Za-z0-9]+[_.-]){0,6}[A-Za-z0-9]{0,32}key)(?![A-Za-z0-9_])(\s*=\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"(?![./~])[^"\n]{16,}"?|'(?![./~])[^'\n]{16,}'?|(?![./~]|\d+(?![^\s"',}]))[^\s"',}]{16,})/gi,
		`$1$2${MASK}`,
	],
	//  - name: value with a compound or fused name: X-Api-Key: x, X-Vault-Token: x, apiKey: x
	[
		/(?<![\w$\{])((?:[A-Za-z0-9]+[_.-]){1,6}(?:[A-Za-z0-9]{0,32}(?:password|passwd|passphrase|secret|token|apikey|api[_-]key|credentials?|authorization|private[_-]?key|client[_-]?secret|(?:api|secret|private|access|encryption|signing|master|license|account|shared[_-]?access)[_-]?key)|(?:pass|pwd|auth|dsn|cred))|[A-Za-z0-9]{1,32}(?:password|passwd|passphrase|secret|token|apikey|api[_-]key|credentials?|authorization|private[_-]?key|client[_-]?secret|(?:api|secret|private|access|encryption|signing|master|license|account|shared[_-]?access)[_-]?key)|(?:api|secret|private|access|encryption|signing|master|license|account|shared[_-]?access)[_-]?key|password|passwd|pwd|secret|passphrase|private[_-]?key|client[_-]?secret)(?![A-Za-z0-9_])(\s*:\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"[^"\n]*"?|'[^'\n]*'?|[^\s"']+)/gi,
		`$1$2${MASK}`,
	],
	[
		/(?<![\w$\{])((?:[A-Za-z0-9]+[_.-]){1,6}[A-Za-z0-9]{0,32}key|[A-Za-z0-9]{1,32}key)(?![A-Za-z0-9_])(\s*:\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"(?![./~])[^"\n]{16,}"?|'(?![./~])[^'\n]{16,}'?|(?![./~]|\d+(?![^\s"',}]))[^\s"',}]{16,})/gi,
		`$1$2${MASK}`,
	],
	//  - YAML-ish bare word: token: <random>, apikey: <random>
	[
		/(?<![\w$\{])((?:token|auth|key|apikey|dsn|pass|credentials?))(?![A-Za-z0-9_])(\s*:\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|["']?(?=[A-Za-z0-9+/=_]{0,256}\d)[A-Za-z0-9+/=_]{20,256}["']?(?![^\s,}\]]))/gi,
		`$1$2${MASK}`,
	],
	//  - quoted keys (JSON, YAML, PHP/Ruby =>): "password": "x", "License-Key": x, 'auth_token' => 'x'
	[
		/(["'])((?:[A-Za-z0-9]+[_.-]){0,6}(?:[A-Za-z0-9]{0,32}(?:password|passwd|passphrase|secret|token|apikey|api[_-]key|credentials?|authorization|private[_-]?key|client[_-]?secret|(?:api|secret|private|access|encryption|signing|master|license|account|shared[_-]?access)[_-]?key)|(?:pass|pwd|auth|dsn|cred)))\1(\s*(?:=>|[:=])\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"[^"\n]*"?|'[^'\n]*'?|[^\s"']+)/gi,
		`$1$2$1$3${MASK}`,
	],
	[
		/(["'])((?:[A-Za-z0-9]+[_.-]){0,6}[A-Za-z0-9]{0,32}key)\1(\s*(?:=>|[:=])\s*)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"(?![./~])[^"\n]{16,}"?|'(?![./~])[^'\n]{16,}'?|(?![./~]|\d+(?![^\s"',}]))[^\s"',}]{16,})/gi,
		`$1$2$1$3${MASK}`,
	],
	//  - CLI flags with a space: --token x, --password x, --api-key x (never the next --flag)
	[
		/(?<![\w-])(--(?:[a-z0-9]+-){0,4}(?:token|password|passwd|secret|api-?key|access-key|secret-key|pass))(\s+)(?!-)(?!["']?\$)(?!["']?[\^~]?\d+\.\d+\.\d+)(?:\[redacted\]|"[^"\n]*"?|'[^'\n]*'?|[^\s"']+)/gi,
		`$1$2${MASK}`,
	],
	//  - -p <password> only in login commands; `-p 3000:3000` stays a port
	[
		/\b((?:docker|podman|buildah|skopeo|helm|oras|nerdctl)\s+(?:registry\s+)?login\b[^\n]{0,200}?\s-p)(\s*)(?!-)[^\s"']+/g,
		`$1$2${MASK}`,
	],
	[/\b(mysql(?:dump|admin|sh)?\b[^\n]{0,200}?\s-p)(?=[^\s-])[^\s"']+/g, `$1${MASK}`],
	//  - Cookie headers, npmrc auth lines
	[/\b((?:set-)?cookie["']?\s*:\s*["']?)[^\n"']+/gi, `$1${MASK}`],
	[/(:_(?:authToken|auth|password)\s*=\s*)(?!\$)[^\s"']+/gi, `$1${MASK}`],
	// Token prefixes: GitHub, OpenAI/Anthropic, AWS key ids, GitLab, npm, Google,
	// DigitalOcean, Hugging Face. The fine-grained PAT prefix
	// is written github_[p]at_ (same match) so the source holds no token-shaped
	// literal for the public-export leak guard to flag.
	[
		/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_[p]at_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|AIza[0-9A-Za-z_-]{35}|dop_v1_[a-f0-9]{64}|hf_[A-Za-z0-9]{30,})\b/g,
		MASK,
	],
	// Stripe secret/restricted keys, Slack tokens, JWTs.
	[/\b[sr]k_(?:live|test)_[A-Za-z0-9]+/g, MASK],
	[/\bxox[abpr]-[A-Za-z0-9-]+/g, MASK],
	[/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, MASK],
	// Long base64 runs (>= 64 chars): key bodies, kubeconfig data, docker auth
	// blobs. Only runs with an upper-case letter past F or a '+': hex (container
	// and image ids, digests, git shas) and lower-case paths
	// (io.containerd.content.v1.content/blobs/...) are not secrets by shape.
	// A hex key is caught by its name (ENCRYPTION_KEY=...) instead.
	[
		/(?<![A-Za-z0-9+/])(?<!sha(?:256|384|512):)(?=[A-Za-z0-9+/]*[G-Z+])[A-Za-z0-9+/]{64,}={0,2}/g,
		MASK,
	],
]

/** Whole-value mask for one secret value (env var, inspect Env entry): never
 *  more than the last 2 chars; very short values are hidden fully. */
export function maskValue(value: string): string {
	if (value.length <= 4) return '****'
	return `****${value.slice(-2)}`
}

/** The env value preview shape written now (makePreview): length only. */
export const LENGTH_ONLY_PREVIEW_RE = /^\u2022{4} \(\d+ chars\)$/

/** A stored env preview as it may leave powder. Rows in the prefix format hold
 *  a 4-char prefix of the value (or the whole short value), so anything that
 *  is not the length-only shape becomes a bare mask with no length. */
export function safeStoredPreview(stored: string | null): string | null {
	if (stored == null || stored === '') return stored
	return LENGTH_ONLY_PREVIEW_RE.test(stored) ? stored : '\u2022\u2022\u2022\u2022'
}

// Lines longer than this are cut before the rules run on the whole text, which
// bounds the cost of every rule (ReDoS budget, redos-budget.test.ts). A line is
// ended by \n OR \r (progress output redraws with \r). A long line up to
// LINE_FULL_MASK_CHARS is masked WHOLE first, then cut to its head and tail
// (LINE_HEAD_CHARS each, at whitespace) around the cut marker, so neither part
// can carry half a secret. Longer lines keep only the head up to
// the last whitespace before LINE_KEEP_CHARS, or masked whole when it has none.
export const LINE_MAX_CHARS = 4096
const LINE_KEEP_CHARS = 4000
const LINE_HEAD_CHARS = 2000
const LINE_FULL_MASK_CHARS = 64 * 1024
const LINE_CUT_MARK = ' [line cut]'

function isLineWs(c: string): boolean {
	return c === ' ' || c === '\t'
}

function cutLongLine(line: string): string {
	if (line.length <= LINE_FULL_MASK_CHARS) {
		let m = line
		for (const [re, to] of SECRET_RULES) m = m.replace(re, to)
		if (m.length <= LINE_MAX_CHARS) return m
		const head = m.slice(0, LINE_HEAD_CHARS)
		const hws = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\t'))
		const tail = m.slice(m.length - LINE_HEAD_CHARS)
		let tws = -1
		for (let i = 0; i < tail.length; i++)
			if (isLineWs(tail[i] as string)) {
				tws = i
				break
			}
		const h = hws > 0 ? head.slice(0, hws) : MASK
		const t = tws >= 0 && tws < tail.length - 1 ? tail.slice(tws + 1) : MASK
		// No whitespace anywhere near either end: one giant token, masked whole.
		if (hws <= 0 && t === MASK) return MASK
		return `${h}${LINE_CUT_MARK} ${t}`
	}
	const head = line.slice(0, LINE_KEEP_CHARS)
	const ws = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\t'))
	return ws > 0 ? `${head.slice(0, ws)}${LINE_CUT_MARK}` : MASK
}

function capLongLines(text: string): string {
	if (text.length <= LINE_MAX_CHARS) return text
	// A scan, not a regex: /[^\n]{4097,}/ is itself quadratic on 4 KB lines.
	let out = ''
	let at = 0
	for (let i = 0; i <= text.length; i++) {
		const c = i < text.length ? text[i] : '\n'
		if (c !== '\n' && c !== '\r') continue
		const line = text.slice(at, i)
		out += line.length > LINE_MAX_CHARS ? cutLongLine(line) : line
		if (i < text.length) out += c
		at = i + 1
	}
	return out
}

/** Mask every secret shape in `text`. Idempotent: redacting SafeText again is a no-op. */
export function redactSecrets(text: string): SafeText {
	let out = capLongLines(text)
	for (const [re, to] of SECRET_RULES) out = out.replace(re, to)
	return out as SafeText
}

/** redactSecrets for nullable columns. */
export function redactNullable(text: string | null | undefined): SafeText | null {
	return text == null ? null : redactSecrets(text)
}

/** Slicing masked text can only drop characters, never reveal one. */
export function safeSlice(text: SafeText, start?: number, end?: number): SafeText {
	return text.slice(start, end) as SafeText
}

// Longest run kept waiting for a newline before it is masked anyway (a single
// giant line: a token split exactly here can escape, nothing else can).
const MAX_PENDING = 64 * 1024

/** Line-buffered redaction for streamed output: a token or PEM block split
 *  across chunks is masked as a whole. push() returns the masked complete
 *  lines; flush() returns the masked remainder at the end of the stream. */
export class SecretStreamRedactor {
	private pending = ''
	private inPem = false
	private pemLines = 0
	// The last key line was a header, so one blank line may follow.
	private pemAfterHeader = false

	push(chunk: string): SafeText {
		if (!chunk) return '' as SafeText
		this.pending += chunk
		const nl = this.pending.lastIndexOf('\n')
		if (nl === -1) {
			if (this.pending.length < MAX_PENDING) return '' as SafeText
			return this.flush()
		}
		const complete = this.pending.slice(0, nl + 1)
		this.pending = this.pending.slice(nl + 1)
		return this.block(complete)
	}

	flush(): SafeText {
		const rest = this.pending
		this.pending = ''
		return this.block(rest)
	}

	private block(text: string): SafeText {
		if (!text) return '' as SafeText
		let t = text
		if (this.inPem) {
			// Continuing a key block opened by an earlier chunk (its BEGIN and body
			// so far were already masked): drop key-body lines and the END line,
			// stop at the first line that is not part of a key.
			const lines = t.split(/(?<=\n)/)
			let i = 0
			while (i < lines.length && this.pemLines < PEM_MAX_LINES) {
				const line = (lines[i] ?? '').replace(/\n$/, '')
				if (PEM_END_RE.test(line)) {
					i++
					this.inPem = false
					break
				}
				const blankAfterHeader = this.pemAfterHeader && /^\r?$/.test(line)
				if (!blankAfterHeader && !PEM_BODY_LINE_RE.test(line)) {
					this.inPem = false
					break
				}
				this.pemAfterHeader = PEM_HEADER_LINE_RE.test(line)
				this.pemLines++
				i++
			}
			if (this.pemLines >= PEM_MAX_LINES) this.inPem = false
			t = lines.slice(i).join('')
			if (this.inPem) return '' as SafeText
		}
		// A BEGIN followed only by key-body lines to the end of this block: the
		// key continues in the next chunk.
		const begins = [...t.matchAll(PEM_BEGIN_RE)]
		const last = begins.at(-1)
		if (last) {
			const tail = t.slice(last.index + last[0].length)
			if (PEM_OPEN_TAIL_RE.test(tail)) {
				this.inPem = true
				this.pemLines = 0
				const lines = tail.replace(/\r?\n$/, '').split('\n')
				this.pemAfterHeader = PEM_HEADER_LINE_RE.test(lines.at(-1) ?? '')
			}
		}
		return redactSecrets(t)
	}
}
