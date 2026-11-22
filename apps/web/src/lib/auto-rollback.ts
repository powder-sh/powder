// Automatic rollback preflight: the safety checks powder owns before an ops hub may roll an
// app back on its own (GET /api/internal/auto-rollback). The hub decides THAT a deploy made
// things worse (error rate after the deploy vs the app's own baseline); powder answers
// WHETHER it may be undone and to WHAT, then the hub uses the existing rollback route.
//
// Never rolled back automatically:
//   - powder itself, and any container named in POWDER_AUTO_ROLLBACK_NEVER (comma list),
//   - apps with app_repos.auto_rollback = false (the per-app opt-out),
//   - anything but the latest deploy of the app (a newer deploy, or one in flight, wins),
//   - a deploy older than the decision window,
//   - a deploy whose diff changed the database schema, unless every schema change is an
//     added .sql migration made only of additive statements, or carries the
//     `-- powder:reversible` marker (the author promises the old code runs on the new schema),
//   - when the diff cannot be read (missing commit, git error): unknown is a no,
//   - when the previous image is gone from the server.
// Pure functions here; the route does the I/O.

import { randomBytes } from 'node:crypto'
import { gitCmd, gitHardenShellFunctions } from './git-harden'
import { appCheckoutDirShell } from './app-checkout'
import { isPowderSelfContainer } from './secret-mask'
import { OUTPUT_TRUNCATED_MARKER } from './capped-output'
import { shq } from './shell'

/** A deploy finished longer ago than this is no longer "just deployed". */
const AUTO_ROLLBACK_MAX_AGE_MIN = 25

function autoRollbackNeverNames(
	env: Record<string, string | undefined> = process.env,
): Set<string> {
	return new Set(
		(env.POWDER_AUTO_ROLLBACK_NEVER ?? '')
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	)
}

export function isAutoRollbackExcluded(
	name: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return isPowderSelfContainer(name, env) || autoRollbackNeverNames(env).has(name.toLowerCase())
}

// ── migrations ────────────────────────────────────────────────────────────────

/** Paths that change a database schema (migration folders, schema files, any .sql). */
const MIGRATION_PATH_RE =
	/(^|\/)(migrations?|migrate|drizzle|prisma|supabase|alembic|db\/schema[^/]*|schema)(\/|\.(ts|js|mjs|cjs|prisma|sql)$)|\.sql$|(^|\/)schema\.prisma$|(^|\/)knexfile\.[jt]s$/i

/** Generator bookkeeping that rides along with a migration and changes nothing by itself. */
const NEUTRAL_META_RE =
	/(^|\/)drizzle\/meta\/[^/]+\.json$|(^|\/)prisma\/migrations\/migration_lock\.toml$/i

export function isMigrationPath(path: string): boolean {
	return MIGRATION_PATH_RE.test(path) && !NEUTRAL_META_RE.test(path)
}

/** The author's promise in a migration file: the previous code keeps working on this schema. */
const REVERSIBLE_MARKER = /--\s*powder:reversible\b/i

/** Statements the previous code survives: new objects, new nullable or defaulted columns. */
const ADDITIVE_STATEMENT_RES = [
	// not UNIQUE: a unique index on an existing table can make the old code's inserts fail
	/^create\s+index\b/i,
	/^create\s+table\b/i,
	/^create\s+(sequence|extension|schema|type)\b/i,
	// not OR REPLACE: a replaced view can change columns the old code reads
	/^create\s+view\b/i,
	/^comment\s+on\b/i,
	/^(begin|commit|start\s+transaction)$/i,
	/^set\s+(local\s+)?(search_path|statement_timeout|lock_timeout)\b/i,
	/^grant\b/i,
]

const ALTER_TABLE_RE =
	/^alter\s+table\s+(if\s+exists\s+)?(only\s+)?("[^"]+"|[\w.]+)(\."[^"]+")?\s+([\s\S]*)$/i

/** ALTER TABLE ... ADD COLUMN, every clause an add of a nullable or defaulted column. */
function isAdditiveAlter(stmt: string): boolean {
	const m = stmt.match(ALTER_TABLE_RE)
	if (!m) return false
	const clauses = (m[5] ?? '').split(/,(?![^(]*\))/)
	return clauses.every((c) => {
		const t = c.trim()
		if (!/^add\s+(column\s+)?(if\s+not\s+exists\s+)?/i.test(t)) return false
		if (/^add\s+(constraint|primary|unique|foreign|check)\b/i.test(t)) return false
		const hasDefault = /\bdefault\b/i.test(t) && !/\bdefault\s+null\b/i.test(t)
		if (/\bnot\s+null\b/i.test(t) && !hasDefault) return false
		return true
	})
}

/**
 * One pass over the SQL: string literals become '', quoted identifiers "x", comments a space.
 * A single pass (not regex in some order) so an apostrophe in a comment or a `--` in a
 * string cannot hide a statement. Null (unknown) wherever these boundaries could differ from
 * the ones Postgres and psql use: a quote or block comment that never ends, a nested block
 * comment (Postgres nests them, this pass does not), an escape string (E'...') or Unicode
 * string (U&'...', U&"..."), and any backslash (with standard_conforming_strings off a
 * backslash escapes a quote, and psql reads backslash meta-commands). A -- comment ends at
 * \n or \r, as in Postgres.
 */
export function stripSqlNoise(sql: string): string | null {
	if (sql.includes('\\')) return null
	let out = ''
	let i = 0
	const n = sql.length
	while (i < n) {
		const c = sql.charAt(i)
		const next = sql[i + 1]
		if (c === '-' && next === '-') {
			let end = i + 2
			while (end < n && sql[end] !== '\n' && sql[end] !== '\r') end++
			i = end
			out += ' '
		} else if (c === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2)
			if (end < 0) return null
			// a /* before the end (the * of the closing */ included: "/*/") opens a nested comment
			if (sql.slice(i + 2, end + 1).includes('/*')) return null
			i = end + 2
			out += ' '
		} else if (c === "'" || c === '"') {
			// U&'...' / U&"...": Unicode escapes (and UESCAPE) are not modelled
			if (out.charAt(out.length - 1) === '&') return null
			// E'...' (any case): the e/E right before the quote is not the end of a longer word
			const p1 = out.charAt(out.length - 1)
			if (c === "'" && (p1 === 'e' || p1 === 'E') && !/[\w$]/.test(out.charAt(out.length - 2)))
				return null
			let k = i + 1
			for (;;) {
				const e = sql.indexOf(c, k)
				if (e < 0) return null
				if (sql[e + 1] === c) {
					k = e + 2
					continue
				}
				i = e + 1
				break
			}
			out += c === "'" ? "''" : '"x"'
		} else {
			out += c
			i++
		}
	}
	return out
}

/** Every statement of this migration is additive (the old code keeps working). */
export function isAdditiveSql(sql: string): boolean {
	// Dollar quotes ($$...$$, $tag$...$tag$, tags may hold any letter) are not modelled by
	// stripSqlNoise, so any $ that is not a $1-style parameter, anywhere (comments included),
	// is unknown, never additive. A NUL (the server stops reading there) or U+FFFD (bytes that
	// were not UTF-8) means this text is not what Postgres reads.
	if (/\$(?!\d)/.test(sql) || sql.includes('\0') || sql.includes('\uFFFD')) return false
	const clean = stripSqlNoise(sql)
	if (clean === null) return false
	// Outside strings, quoted identifiers and comments only printable ASCII and whitespace:
	// Postgres reads a non-ASCII character as part of an identifier, while the checks below
	// treat Unicode spaces as whitespace and non-ASCII letters as word boundaries.
	if (/[^\t\n\v\f\r\x20-\x7e]/.test(clean)) return false
	const statements = clean
		.split(/;|-->\s*statement-breakpoint/i)
		.map((s) => s.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
	// an empty (or unreadable) migration is not proof of anything
	if (statements.length === 0) return false
	return statements.every(
		(s) => ADDITIVE_STATEMENT_RES.some((re) => re.test(s)) || isAdditiveAlter(s),
	)
}

export interface DiffEntry {
	/** git diff --name-status letter: A, M, D, T, ... */
	status: string
	path: string
}

export interface MigrationVerdict {
	/** Schema paths the diff touches (neutral generator files excluded). */
	touched: string[]
	/** True when nothing schema-related changed, or every change is reversible by design. */
	reversible: boolean
	/** Plain reason when not reversible. */
	why: string | null
}

/**
 * Did this diff change the database schema in a way the previous image cannot run on?
 * `addedSql` holds the content of added .sql files (path -> text). A modified or deleted
 * migration, a schema file change (schema.prisma, drizzle schema.ts pushed at boot) or a
 * non-additive SQL statement is a no, unless the file carries REVERSIBLE_MARKER.
 */
export function classifyMigrations(
	entries: DiffEntry[],
	addedSql: Record<string, string>,
): MigrationVerdict {
	const touched = entries.filter((e) => isMigrationPath(e.path)).map((e) => e.path)
	if (touched.length === 0) return { touched, reversible: true, why: null }
	for (const e of entries) {
		if (!isMigrationPath(e.path)) continue
		const sql = addedSql[e.path]
		if (e.status === 'A' && sql !== undefined && /\.sql$/i.test(e.path)) {
			if (REVERSIBLE_MARKER.test(sql) || isAdditiveSql(sql)) continue
			return { touched, reversible: false, why: `${e.path} has a statement that is not additive` }
		}
		if (sql !== undefined && REVERSIBLE_MARKER.test(sql)) continue
		const verb = e.status === 'A' ? 'adds' : e.status === 'D' ? 'deletes' : 'changes'
		return { touched, reversible: false, why: `the update ${verb} ${e.path}` }
	}
	return { touched, reversible: true, why: null }
}

/** Parse `git diff --name-status --no-renames` output. */
export function parseNameStatus(out: string): DiffEntry[] {
	return out
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const [status = '', ...rest] = l.split('\t')
			return { status: status.charAt(0), path: rest.join('\t') }
		})
		.filter((e) => e.path)
}

// ── target and blockers ───────────────────────────────────────────────────────

export interface DeployRow {
	id: string
	kind: string
	status: string
	startedAt: Date
	/** When the deploy was asked for; startedAt resets when a worker claims it. */
	queuedAt?: Date | null
	finishedAt: Date | null
	gitSha: string | null
	imageTag: string | null
	/** Held on the settle window, as the database answered deploy-settle.ts heldSql. */
	held?: boolean
}

/**
 * The image that ran right before `bad`: the newest successful deploy that started before it
 * with a tagged image other than bad's (a rollback row carries its target's image). Null when
 * there is none, or when that image is the same code (a redeploy of one sha: rolling back would
 * change nothing, and anything older is not "the previous image").
 */
export function pickRollbackTarget(bad: DeployRow, history: DeployRow[]): DeployRow | null {
	const prev = history
		.filter(
			(d) =>
				d.id !== bad.id &&
				d.startedAt.getTime() < bad.startedAt.getTime() &&
				d.status === 'success' &&
				!!d.imageTag &&
				d.imageTag !== bad.imageTag,
		)
		.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
	if (!prev) return null
	if (!prev.gitSha || !bad.gitSha || prev.gitSha === bad.gitSha) return null
	return prev
}

/** The git deploy right before `bad` (any outcome), for the hub's "twice in a row" rule. */
export function previousGitDeploy(bad: DeployRow, history: DeployRow[]): DeployRow | null {
	return (
		history
			.filter(
				(d) =>
					d.id !== bad.id &&
					d.kind === 'git_deploy' &&
					d.status === 'success' &&
					d.startedAt.getTime() < bad.startedAt.getTime(),
			)
			.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null
	)
}

export type Blocker =
	| 'excluded'
	| 'opted-out'
	| 'unregistered'
	| 'not-git-deploy'
	| 'not-success'
	| 'superseded'
	| 'too-old'
	| 'no-sha'
	| 'no-target'
	| 'migration'
	| 'diff-unknown'
	| 'image-missing'
	| 'ambiguous'

/** The checks that need only the database (the route adds migration / image ones over SSH). */
export function staticBlockers(input: {
	deploy: DeployRow
	containerName: string
	autoRollback: boolean | null
	history: DeployRow[]
	now: Date
	env?: Record<string, string | undefined>
}): Blocker[] {
	const b: Blocker[] = []
	const { deploy, history, now } = input
	if (isAutoRollbackExcluded(input.containerName, input.env)) b.push('excluded')
	if (input.autoRollback === null) b.push('unregistered')
	else if (!input.autoRollback) b.push('opted-out')
	if (deploy.kind !== 'git_deploy') b.push('not-git-deploy')
	if (deploy.status !== 'success') b.push('not-success')
	const asked = (d: DeployRow) => (d.queuedAt ?? d.startedAt).getTime()
	// A push held on the settle window has not deployed anything: it does not supersede
	// (else every hold inside the 25 min window would switch automatic rollback off).
	// The rollback route cancels it when the rollback runs.
	if (
		history.some(
			(d) =>
				d.id !== deploy.id &&
				d.held !== true &&
				(d.status === 'queued' ||
					d.status === 'running' ||
					d.startedAt.getTime() > deploy.startedAt.getTime() ||
					asked(d) > asked(deploy)),
		)
	)
		b.push('superseded')
	const doneAt = deploy.finishedAt ?? deploy.startedAt
	if (now.getTime() - doneAt.getTime() > AUTO_ROLLBACK_MAX_AGE_MIN * 60_000) b.push('too-old')
	if (!deploy.gitSha) b.push('no-sha')
	if (!pickRollbackTarget(deploy, history)) b.push('no-target')
	return b
}

export const SHA_RE = /^[0-9a-f]{7,40}$/i

// ── the SSH step ──────────────────────────────────────────────────────────────

const MAX_SQL_BYTES = 200_000
/** Destructive DDL anywhere in the added lines (ERE, case-insensitive). */
const CODE_DDL_RE =
	'drop[[:space:]]+(table|column|index|constraint|type|view|schema)|rename[[:space:]]+(column|to)|alter[[:space:]]+column|truncate[[:space:]]|alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]]'

/** Read-only shell for the app's server: does the diff range exist in the clone, is the
 *  target image still there, which files changed, and the text of added .sql files.
 *  `from`/`to` must already match SHA_RE. Git runs through powder_git (lib/git-harden.ts).
 *  Every marker carries `nonce` (newPreflightNonce(), fresh per run, passed to
 *  parsePreflightOutput too): file names and file content cannot know it, so they cannot
 *  end a section early or start a new one. */
export function preflightScript(p: {
	workingDir: string
	from: string
	to: string
	imageTag: string
	nonce: string
}): string {
	if (!SHA_RE.test(p.from) || !SHA_RE.test(p.to)) throw new Error('sha is not a hex commit id')
	if (!NONCE_RE.test(p.nonce)) throw new Error('preflight nonce must be 32 hex chars')
	const m = (k: string) => preflightMarker(k, p.nonce)
	const g = `${gitCmd('"$G"', '"$G"')} -c core.quotePath=false`
	return [
		`cd ${shq(p.workingDir)} || { echo ${m('nowd')}; exit 0; }`,
		// the checkout: one authority (lib/app-checkout.ts); none = the working dir, where git finds no commit
		`${appCheckoutDirShell('G_CO')}; G="$PWD"; if [ "$G_CO" = src ]; then G="$PWD/src"; fi`,
		gitHardenShellFunctions().trimEnd(),
		`${g} cat-file -e ${p.from}^{commit} 2>/dev/null && ${g} cat-file -e ${p.to}^{commit} 2>/dev/null || { echo ${m('nocommit')}; exit 0; }`,
		`echo ${m('img')}`,
		`docker image inspect --format ok ${shq(p.imageTag)} 2>/dev/null || echo missing`,
		`echo ${m('files')}`,
		`${g} diff --name-status --no-renames ${p.from} ${p.to} || echo ${m('differr')}`,
		`echo ${m('end')}`,
		'__d=$(mktemp)',
		// schema changes made from code (ensure-tables at boot): destructive DDL on added lines
		`${g} diff -U0 --no-renames ${p.from} ${p.to} -- ':(top)' ':(top,exclude,icase)*.sql' > "$__d" || echo ${m('differr')}`,
		`echo "${m('ddl')} $(grep -E '^[+][^+]' "$__d" | grep -ciE ${shq(CODE_DDL_RE)})"; rm -f "$__d"`,
		`${g} diff --name-only --no-renames --diff-filter=A ${p.from} ${p.to} | grep -iE '\\.sql$' | head -40 | while IFS= read -r f; do printf '${m('sql')} %s\\n' "$f"; ${g} show "${p.to}:$f" | head -c ${MAX_SQL_BYTES + 1}; printf '\\n'; done`,
	].join('\n')
}

const NONCE_RE = /^[0-9a-f]{32}$/

/** A fresh nonce for one preflightScript / parsePreflightOutput pair. */
export function newPreflightNonce(): string {
	return randomBytes(16).toString('hex')
}

function preflightMarker(kind: string, nonce: string): string {
	return `__${kind}_${nonce}__`
}

export type PreflightOutput =
	| { error: string }
	| { imageOk: boolean; entries: DiffEntry[]; addedSql: Record<string, string>; codeDdl: number }

export function parsePreflightOutput(out: string, nonce: string): PreflightOutput {
	if (!NONCE_RE.test(nonce)) return { error: 'preflight nonce must be 32 hex chars' }
	const m = (k: string) => preflightMarker(k, nonce)
	if (out.includes(OUTPUT_TRUNCATED_MARKER)) return { error: 'the diff is too large to read whole' }
	if (out.includes(m('nowd'))) return { error: 'no-workdir' }
	if (out.includes(m('nocommit')))
		return { error: 'a commit of the diff range is not in the clone' }
	const ddlRe = new RegExp(`^${m('ddl')} (\\d+)$`, 'm')
	const img = out.indexOf(m('img'))
	const files = out.indexOf(m('files'))
	const end = out.indexOf(m('end'))
	if (out.includes(m('differr')) || img < 0 || files < img || end < files || !ddlRe.test(out))
		return { error: 'git diff failed' }
	const imageOk = out.slice(img + m('img').length, files).trim() === 'ok'
	const entries = parseNameStatus(out.slice(files + m('files').length, end))
	const codeDdl = Number(out.match(ddlRe)?.[1] ?? '0')
	const addedSql: Record<string, string> = {}
	for (const part of out
		.slice(end + m('end').length)
		.split(new RegExp(`^${m('sql')} `, 'm'))
		.slice(1)) {
		const nl = part.indexOf('\n')
		if (nl < 0) continue
		const text = part.slice(nl + 1)
		// cut at the byte cap: unknown, never "additive"
		if (Buffer.byteLength(text, 'utf8') > MAX_SQL_BYTES)
			return { error: `${part.slice(0, nl).trim()} is too large to read` }
		addedSql[part.slice(0, nl).trim()] = text
	}
	return { imageOk, entries, addedSql, codeDdl }
}
