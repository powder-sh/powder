// Turns a raw deploy log into a structured, at-a-glance failure. The full log
// is never lost: these fields sit *alongside* it so the dashboard can answer
// "why did this fail" without a human reading the whole blob.
//
// The one authority for that answer (summarizeDeployFailure). Its one-line
// summary is what the dashboard shows, what the "copy error" block carries, the
// GitHub commit status description and the text of the ops endpoint event.
//
// Inputs:
//   1. The `__POWDER_FAIL__ step=<phase> code=<rc>` trailer that rebuildDeploy's
//      remote shell prints from an EXIT trap (see lib/deploy/script.ts). This is the
//      authoritative "which phase died + exit code". It exists even when the
//      step produced no stderr of its own.
//   2. The failing step's own region of the log: from its last "── <step> ──"
//      banner to the trailer (the whole log when the banner is missing).
//
// The summary is read by STEP FIRST, then by evidence inside that step's region:
// every step has a kind (build, test, pull, git, migrate, release, swap-check,
// container, guard) and each kind has its own ordered rules. A build failure is
// only explained by build evidence, a test gate failure by test evidence, a
// failure after the swap by container evidence: a line that only means something
// in one kind of step (a test that prints ECONNREFUSED on purpose, a build tool's
// "worker exited with code 1") cannot name the cause of another. A step with no
// readable evidence in its region reads "failed during: <step>".
//
// Terminal escapes are stripped once, before any rule runs (runners colour their
// summaries). The rules run on the raw log in memory (masking first would hide
// words they match, e.g. "unauthorized: authentication required"); what leaves
// this module is masked (lib/secret-text.ts): the assembled summary with its
// captures, and the last-line fallback, which is taken from the masked log so a
// key-body line can never become a summary.

import type { TestGate } from '@powder/db/schema'
import {
	BUILDKIT_PREFIX_RE,
	type FailedRun,
	commitOnlyLine,
	copyMissingReason,
	failingLines,
	lastFailedRun,
	runFailureText,
	stripAnsi,
} from './buildkit-log'
import { POWDER_DB_SLOW_SUMMARY, isPowderDbError } from './deploy-bookkeeping'
import { GIT_REMOTE_UNREADABLE } from './deploy/tool-lines'
import { HEALTH_CHECK_STEP, IMAGE_READBACK_STEP } from './deploy-swap'
import { NEVER_CLAIMED_STEP, WATCHDOG_STOPPED_STEP } from './deploy-watchdog-reason'
import { safeFailedStep, summaryBeyondStep } from './notify-text'
import { type SafeText, redactSecrets } from './secret-text'

export interface DeployFailure {
	failedStep: string | null
	exitCode: number | null
	errorSummary: SafeText
}

// ── step kinds ───────────────────────────────────────────────────────────────

/** What a failed step does, which decides what evidence may explain it. */
export type FailureStepKind = 'build' | 'test' | 'pull' | 'git' | 'migrate' | 'release' | 'swap-check' | 'container' | 'guard'

/** Every step name powder's deploy code reports (the `step "<name>"` banners of
 *  deploy/script.ts, deploy/self-deploy.ts and the builder, and the fail trailers
 *  powder writes itself in deploy/run.ts and deploy-runner.ts). A contract test
 *  renders the scripts and fails on a step that is missing here. */
const STEP_KINDS: Readonly<Record<string, FailureStepKind>> = Object.freeze({
	start: 'guard',
	'app lock': 'guard',
	preflight: 'guard',
	'config preflight': 'guard',
	'preflight build-context': 'guard',
	'preflight pages-test-files': 'guard',
	'compose guard': 'guard',
	'compose guard (pre-up)': 'guard',
	'tracked .env guard': 'guard',
	dockerignore: 'guard',
	'dockerfile check': 'guard',
	'image labels': 'guard',
	'swap gate': 'guard',
	'budget check': 'guard',
	budget: 'guard',
	'script upload': 'guard',
	'env render': 'guard',
	'domain labels': 'guard',
	superseded: 'guard',
	'prebuilt image (builder)': 'guard',
	'preflight git auth': 'git',
	'git sync (force src/ to GitHub)': 'git',
	'git sync (force workdir to GitHub, preserve runtime compose)': 'git',
	'git rev-parse': 'git',
	'no git repo, skipping pull': 'git',
	'docker compose build (local build)': 'build',
	'docker compose build': 'build',
	build: 'build',
	'docker compose pull (registry mode)': 'pull',
	'docker compose pull': 'pull',
	'test gate': 'test',
	'db migrate': 'migrate',
	release: 'release',
	'swap-check': 'swap-check',
	'docker compose up': 'container',
	'normalize (enforce restart + mem cap)': 'container',
	'resolve image': 'container',
	'ready, recreate will run detached': 'container',
	[HEALTH_CHECK_STEP]: 'container',
	[IMAGE_READBACK_STEP]: 'container',
	// the watchdog's reap reasons (deploy-watchdog-reason.ts): no log region, a step name only
	[WATCHDOG_STOPPED_STEP]: 'guard',
	[NEVER_CLAIMED_STEP]: 'guard',
})

/** The env-file link guard's steps (`env file links (<where>)`, deploy/script.ts). */
const ENV_LINK_STEP_RE = /^env file links \([a-z -]{1,40}\)$/

/** The kind of a failed step; null for no step or a name powder does not print. Pure. */
export function failureStepKind(step: string | null): FailureStepKind | null {
	if (!step) return null
	if (Object.hasOwn(STEP_KINDS, step)) return STEP_KINDS[step] ?? null
	return ENV_LINK_STEP_RE.test(step) ? 'guard' : null
}

/** The step name as a summary repeats it: a step powder prints keeps its own
 *  punctuation (the same name the deploy page's banner shows); anything else (a
 *  trailer forged by build output, a name from an older release) is normalised
 *  by safeFailedStep. Pure. */
export function failedStepText(step: string | null): string {
	return step && failureStepKind(step) ? step : safeFailedStep(step)
}

/** The summary of a failure with no readable evidence: only the step. */
export function stepOnlySummary(step: string): string {
	return `failed during: ${failedStepText(step)}`
}

/** The `error` text of a failed deploy's ops endpoint event (hq.ts reportDeployToHq):
 *  `failed during: <step> · <summary>` when a step is known. Receivers read the step
 *  out of the text up to the `·` (`failed during:\s*([^·\n]+)`), so the step is
 *  written exactly as the step-only summary always printed it (safeFailedStep), and
 *  the event also carries it as `failedStep`. A summary that only repeats the step is
 *  sent as the step alone; no step: the summary as it is. Only the event uses this:
 *  the stored summary, the dashboard and the GitHub status keep the summary. Pure. */
export function opsEventErrorText(step: string | null, summary: SafeText): SafeText {
	if (!step) return summary
	const head = `failed during: ${safeFailedStep(step)}`
	const rest = summaryBeyondStep(step, summary)
	return redactSecrets(rest ? `${head} · ${rest}` : head)
}

/** The failure fields of an ops endpoint deploy event (hq.ts DeployEvent): the event
 *  text (opsEventErrorText), the step as that text names it (safeFailedStep, null when
 *  unknown) and its exit code. Every sender of a failed deploy's event takes them from
 *  here. Pure. */
export function opsEventFailureFields(
	step: string | null,
	exitCode: number | null | undefined,
	summary: SafeText,
): { error: SafeText; failedStep: string | null; exitCode: number | null } {
	const masked = maskedFailedStep(step)
	return { error: opsEventErrorText(masked, summary), failedStep: masked ? safeFailedStep(masked) : null, exitCode: exitCode ?? null }
}

/** A step name as it may leave powder: a step that redaction would change (a trailer
 *  forged by build output carrying a token or a URL with credentials) becomes
 *  `unknown`, so no part of it is stored, shown or sent. Pure. */
export function maskedFailedStep(step: string | null): string | null {
	if (!step) return step
	return String(redactSecrets(step)) === step ? step : 'unknown'
}

/** The failed step is the test gate (.powder/test.sh), on the target or the builder. */
export function isTestGateStep(step: string | null): boolean {
	return !!step && /test gate/i.test(step)
}

/** The registry-mode pull step of the deploy script (lib/deploy/script.ts). */
function isRegistryPullStep(step: string | null): boolean {
	return !!step && step.startsWith('docker compose pull')
}

// ── powder's own lines ───────────────────────────────────────────────────────

/** Lines powder's own deploy code prints to say why it stopped (a refusal, a
 *  guard, a preflight, the deadline). Each is written to be read as the cause,
 *  so the summary is the line itself. Matched at the start of a line: app output
 *  in a build is BuildKit-prefixed (`#N `), and the kinds whose output is the
 *  app's own (TOOL_ONLY_KINDS) accept only bracketed tool tags. */
export const TOOL_CAUSE_LINE_RE = new RegExp(
	`^(?:${[
		'preflight: ',
		'self-deploy: refusing',
		'refusing: ',
		'powder: (?:refusing|git: cannot)',
		'\\[builder\\]: refusing',
		'deploy: ',
		'(?:compose|compose file|env file|bind|infra|profile) guard: ',
		'image labels: ',
		'swap gate: ',
		'swap-check: FAILED \\(',
		'per-app lock (?:path|dir) ',
		'another deploy of this app holds the (?:per-app )?lock',
		'\\[build-cache\\] (?:refusing|no Dockerfile at |cannot |could not )',
		'\\[migrate\\] [^\\n]{0,200}?(?:REFUSING|cannot |FAILED|failed|is not a postgres)',
		'\\[release\\] (?:cannot |not enough )',
		'\\[(?:builder )?test-gate\\] refusing',
		'\\[builder\\] refusing',
		'\\[build-lock\\] no free build slot',
		'\\[deadline\\] ',
		'env render (?:failed|REFUSED)',
		'domain labels override refused',
	].join('|')})`,
)

/** Tool lines that only say the step failed, not why (the cause is in the
 *  step's output above them). Never a summary on their own. */
export const TOOL_VERDICT_LINE_RE =
	/^(?:\[(?:builder )?test-gate\] FAILED \(exit \d{1,3}\)|swap-check: old container untouched|\[release\] FAILED \(rc=\d{1,3}\)|\[builder\] the tests in \.powder\/test\.sh failed on the builder|deploy: git sync of (?:src\/|the workdir) FAILED|preflight: build refused by the Dockerfile check \(see \[build-cache\] lines above\))/

/** Kinds whose region holds the app's own unprefixed output (tests, the release
 *  command, a candidate's log): only bracketed tool lines count there. */
const TOOL_ONLY_KINDS: ReadonlySet<FailureStepKind> = new Set(['test', 'release', 'swap-check'])

/** True when `line` is one of powder's own cause lines in a step of `kind`. */
export function isToolCauseLine(line: string, kind: FailureStepKind | null): boolean {
	if (!TOOL_CAUSE_LINE_RE.test(line) || TOOL_VERDICT_LINE_RE.test(line)) return false
	return !(kind && TOOL_ONLY_KINDS.has(kind)) || /^\[/.test(line)
}

const TOOL_LINE_CHARS = 400

/** The last cause line powder printed in the region, cut to TOOL_LINE_CHARS. A line
 *  that ends in ':' introduces indented detail lines (the compose guard's broken rule,
 *  the git sync's link refusal): the first of them IS the cause, so it comes first and
 *  the line follows in brackets. powder-migrate's `cannot <do X> ('<database error>')`
 *  lines lead with the database's own error. Cause first: every place the summary goes
 *  may cut its end. */
function lastToolCauseLine(lines: readonly string[], kind: FailureStepKind | null): string | null {
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = (lines[i] ?? '').trim()
		if (!isToolCauseLine(lines[i] ?? '', kind)) continue
		const next = lines[i + 1] ?? ''
		if (l.endsWith(':') && /^[ \t]+\S/.test(next))
			return `${next.trim().replace(/^- /, '')} (${l.slice(0, -1)})`.slice(0, TOOL_LINE_CHARS)
		const migrate = l.match(/^(\[migrate\] [^:\n]{1,100}: cannot [^(\n]{1,160}?) \((?:got )?'([^'\n]{1,600})'/)
		if (migrate?.[1] && migrate[2]) {
			const db = migrate[2].match(/(?:FATAL|ERROR):[^\n]*$/)?.[0] ?? migrate[2]
			return `${db.replace(/\s+/g, ' ').trim()} (${migrate[1]})`.slice(0, TOOL_LINE_CHARS)
		}
		return l.slice(0, TOOL_LINE_CHARS)
	}
	return null
}

// ── memory ───────────────────────────────────────────────────────────────────

/** Stable memory-failure kinds. The summary starts with `<kind>: ` so cards dedupe
 *  and robots can match it: `heap-oom` = Node's V8 heap limit (a flag fixes it),
 *  `container-oom` = the process was SIGKILLed (exit 137 / OOMKilled: a memory limit
 *  or the kernel OOM killer; the heap flag does not help). */
export type MemoryFailureKind = 'heap-oom' | 'container-oom'

/** V8's own fatal heap messages (node prints them before aborting). */
export const HEAP_OOM_RE =
	/JavaScript heap out of memory|Reached heap limit|FATAL ERROR: Ineffective mark-compacts|Allocation failed - JavaScript heap/

/** A SIGKILL / OOM kill the deploy log can show: the test gate's own exit line
 *  (lib/deploy/fragments.ts testGateShell), docker inspect. A RUN step's exit 137 is
 *  read by buildkit-log.ts (isKilledRun). */
const CONTAINER_OOM_RE = /test-gate\] FAILED \(exit 137\)|"?OOMKilled"?:? ?true/
const isKilledRun = (text: string) => lastFailedRun(text)?.exitCode === 137
/** The shell's line for a child it lost to SIGKILL (`Killed`, alone on its line). */
const KILLED_LINE_RE = /^[ \t]*Killed[ \t]*$/m

// Test runners' own failure lines: vitest/jest summaries ("Test Files  1 failed | 233 passed",
// "Tests:       2 failed, 10 passed"), node --test's TAP "# fail N", and per-file "FAIL " lines.
const TEST_SUMMARY_FAILED_RE = /^[ \t]*(?:Test Files|Test Suites:|Tests:?)[ \t]+(\d{1,6}) failed|^# fail (\d{1,6})[ \t]*$/gm
const TEST_FAIL_LINE_RE = /^[ \t]*FAIL[ \t]+(\S{1,300})[^\n]*/gm
// A test file that "failed" only because its worker died is the crash, not an assertion.
// (vitest/tinypool, node workers, jest-worker "A jest worker process (pid=N) was terminated"
// and its "Call retries were exceeded").
const WORKER_CRASH_RE =
	/Worker (?:exited|terminated) unexpectedly|ERR_WORKER_OUT_OF_MEMORY|ERR_IPC_CHANNEL_CLOSED|Channel closed|A jest worker process \(pid=\d{1,10}\) was terminated|Call retries were exceeded/
const ASSERTION_RE = /AssertionError|Assertion failed|expected [^\n]{0,300} to |expect\(received\)|not ok \d{1,6} /

function lastIndexOfRe(text: string, re: RegExp): number {
	const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
	let last = -1
	for (const m of text.matchAll(g)) last = m.index ?? last
	return last
}

/** Real test failures in a step's output that are not themselves a crash, or null. Pure.
 *  Present = a runner reported N>0 failed (or a FAIL file line) AFTER the last V8 heap
 *  message (the run went on past the crash, so the crash did not end it), and the failures
 *  are not only dead workers. `file` = the first failing test file when a FAIL line names
 *  one (a path); `first` = the first FAIL line's own text when it names a test, not a
 *  file (a custom runner's `FAIL <test name>`); `failLines` = how many FAIL lines there
 *  are; `notOk` = TAP's first failing test (`not ok N - <name>`) and how many there are;
 *  `summary` = the runner's last "N failed" line, whitespace collapsed. Terminal
 *  escapes and BuildKit prefixes are stripped first. */
export function findTestFailures(rawText: string): {
	file: string | null
	first: string | null
	failLines: number
	notOk: { first: string; count: number } | null
	summary: string | null
} | null {
	const text = stripAnsi(rawText).replace(BUILDKIT_PREFIX_RE, '')
	let lastEvidence = -1
	let summary: string | null = null
	for (const m of text.matchAll(TEST_SUMMARY_FAILED_RE)) {
		if (Number(m[1] ?? m[2]) > 0) {
			lastEvidence = Math.max(lastEvidence, m.index ?? -1)
			const at = m.index ?? 0
			const end = text.indexOf('\n', at)
			summary = text.slice(at, end === -1 ? undefined : end).replace(/\s+/g, ' ').trim().slice(0, 160)
		}
	}
	const failLines = [...text.matchAll(TEST_FAIL_LINE_RE)]
	for (const m of failLines) lastEvidence = Math.max(lastEvidence, m.index ?? -1)
	if (lastEvidence === -1) return null
	// the heap crash came after every test report: the run aborted on it
	if (lastIndexOfRe(text, HEAP_OOM_RE) > lastEvidence) return null
	if (WORKER_CRASH_RE.test(text) && !ASSERTION_RE.test(text)) return null
	const head = failLines[0]?.[1] ?? null
	const file = head ? head.replace(/[ \t]*>.*$/, '') : null
	const isPath = !!file && /[./]/.test(file)
	const firstLine = failLines[0]?.[0].replace(/^[ \t]*FAIL[ \t]+/, '').replace(/\s+/g, ' ').trim().slice(0, 100) ?? null
	// TAP (node:test): top-level `not ok` lines are the failed tests; nested ones only when there is no top level
	const top = [...text.matchAll(/^not ok \d{1,6} - ([^\n]{1,200})/gm)]
	const tap = top.length ? top : [...text.matchAll(/^[ \t]{1,40}not ok \d{1,6} - ([^\n]{1,200})/gm)]
	const notOk = tap.length ? { first: (tap[0]?.[1] ?? '').replace(/\s+#\s.*$/, '').trim().slice(0, 100), count: tap.length } : null
	return { file: isPath ? file : null, first: isPath ? null : firstLine, failLines: failLines.length, notOk, summary }
}

/** Classify a failed step's output as a memory failure, or null. One shared function
 *  for every step: the test gate (.powder/test.sh), the image build, the builder. Pure:
 *  same text and step, same answer. A V8 heap signature wins over an exit 137 (the
 *  heap message names the cause), but only when no real test failures are reported
 *  after it (findTestFailures): a side process's heap crash in a run that went on to
 *  fail an assertion is a test failure, and the heap hint would send the fix the wrong way. */
export function classifyMemoryFailure(
	text: string,
	step: string | null,
	exitCode: number | null = null,
): { kind: MemoryFailureKind; summary: string } | null {
	const gate = isTestGateStep(step)
	const what = step ? `the step "${failedStepText(step)}"` : 'a Node process'
	if (HEAP_OOM_RE.test(text) && !findTestFailures(text)) {
		return {
			kind: 'heap-oom',
			summary: gate
				? 'heap-oom: the test gate ran out of Node heap (the V8 heap limit, not a code bug): set NODE_OPTIONS=--max-old-space-size=<MB> on that step in .powder/test.sh (size it with tsc --extendedDiagnostics "Memory used" or the step\'s peak, plus headroom, under POWDER_TESTGATE_MEM if set)'
				: `heap-oom: ${what} ran out of Node heap (the V8 heap limit, not a code bug): set NODE_OPTIONS=--max-old-space-size=<MB> for that command (Dockerfile: ENV before the RUN; .powder/test.sh: on that line), sized from its peak plus headroom`,
		}
	}
	if (CONTAINER_OOM_RE.test(text) || isKilledRun(text) || (gate && exitCode === 137)) {
		return {
			kind: 'container-oom',
			summary: gate
				? 'container-oom: the test gate was killed (exit 137, SIGKILL: the test container memory limit or the kernel OOM killer), not a code bug and not the Node heap: add memory or swap on the server, or free memory there; if POWDER_TESTGATE_MEM is set, raise it; NODE_OPTIONS will not help'
				: `container-oom: ${what} was killed (exit 137, SIGKILL: a container memory limit or the kernel OOM killer), not a code bug and not the Node heap: add memory or swap on the server, or make the step use less; NODE_OPTIONS will not help`,
		}
	}
	// The shell's bare "Killed" line for a child it lost to SIGKILL, read only in the gate's
	// last lines (gateTail) and only when no test failed: a "Killed" in the body of a run
	// that went on to fail assertions is not what stopped it. The gate's own exit is said
	// as it was (the FAILED line's, else the step's), never assumed to be 137.
	if (gate && KILLED_LINE_RE.test(gateTail(text.split('\n')).join('\n')) && !findTestFailures(text)) {
		const rc = text.match(/^\[(?:builder )?test-gate\] FAILED \(exit (\d{1,3})\)/m)?.[1] ?? (exitCode == null ? null : String(exitCode))
		return {
			kind: 'container-oom',
			summary: `container-oom: a process in the test gate was killed (usually out of memory: the test container memory limit or the kernel OOM killer${rc ? `; the gate exited ${rc}` : ''}), not a code bug and not the Node heap: add memory or swap on the server, or free memory there; if POWDER_TESTGATE_MEM is set, raise it; NODE_OPTIONS will not help`,
		}
	}
	return null
}

// ── evidence rules ───────────────────────────────────────────────────────────

/** What a rule sees: the step's region of the log (escapes stripped, bounded), its
 *  lines, the failed step and its kind. `text` and `lines` are the region REDACTED
 *  (secret-text.ts) before any rule runs: every fragment a rule cuts out of a line for
 *  display comes from them, so a cut can never drop the context the redactor needs (a
 *  URL's `user:password@` cut to `user:password`). `raw` is the same region unredacted,
 *  read only by rules whose summary is fixed text (masking first would hide words they
 *  match, e.g. "unauthorized: authentication required"). */
interface Ctx {
	text: string
	lines: string[]
	raw: string
	/** build steps: the failed RUN step read from `raw` (fixed-text rules only) */
	rawRun: FailedRun | null
	step: string | null
	kind: FailureStepKind | null
	/** build steps: the RUN step BuildKit reports as failed (buildkit-log.ts), else null */
	run: FailedRun | null
	/** the failed step's exit code from the trailer, null when unknown */
	exitCode: number | null
}

/** A build step's evidence scope: the failed RUN step's own lines when BuildKit
 *  names them (a line an earlier, passed step printed is no evidence), else the region. */
function ownScope(c: Ctx): Ctx {
	const own = c.run?.own
	const rawOwn = c.rawRun?.own
	return own ? { ...c, text: own.join('\n'), lines: own, raw: rawOwn ? rawOwn.join('\n') : c.raw } : c
}

/** One piece of evidence: a summary, or null when the region does not show it. */
type Rule = (c: Ctx) => string | null

/** A rule that quotes what it matched: matched on the redacted region. */
const re = (pattern: RegExp, summary: (m: RegExpMatchArray, c: Ctx) => string): Rule => (c) => {
	const m = c.text.match(pattern)
	return m ? summary(m, c) : null
}

/** A rule whose summary is fixed text (no fragment of the log): matched on the raw region. */
const fixed = (pattern: RegExp, summary: (c: Ctx) => string): Rule => (c) => (pattern.test(c.raw) ? summary(c) : null)

/** The last line of `lines` matching `pattern` (trimmed, cut), or null. */
function lastLine(lines: readonly string[], pattern: RegExp, skip?: (l: string) => boolean): string | null {
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = (lines[i] ?? '').trim()
		if (l && pattern.test(l) && !skip?.(l)) return l.slice(0, 300)
	}
	return null
}

const R = {
	/** heap-oom / container-oom (classifyMemoryFailure) */
	memory: (c) => classifyMemoryFailure(c.raw, c.step, c.exitCode)?.summary ?? null,
	/** deploy/run.ts: the builder phase failed on the commit itself (builder-failure.ts), so
	 *  there was no local rebuild. The reason names the step and carries its failing lines.
	 *  Anchored on its closing words: the test gate's line ("... the same tests would fail there") is not this one. */
	builderApp: re(
		/\[builder\] ([^\n]{1,1500}?) on the builder - not falling back to a local build \(the same build would fail there\)/,
		(m) => `${m[1]}; your commit's own build failure on the builder (the build host is fine, nothing was rebuilt)`,
	),
	/** swap-check's better-auth probe (lib/deploy/fragments.ts swap_auth_check): the
	 *  candidate passed its health URL but the auth endpoint 5xx'd. Body part is only
	 *  present when it mentioned SCHEMA_MISMATCH. */
	authCheck: re(
		/auth check: (\/\S{0,300}) returned (\d{3}) \(better-auth schema mismatch\? run the migration\)(?:: ([^\n]{0,500}?))?\)?(?:\n|$)/,
		(m) => `auth check: ${m[1]} returned ${m[2]} (better-auth schema mismatch? run the migration)${m[3] ? `: ${m[3]}` : ''}`,
	),
	/** rebuildDeploy's pages/app test-file preflight (lib/deploy/script.ts). */
	pagesTestFile: re(
		/test file inside pages\/app tree: (\S{1,300})/,
		(m) => `test file inside pages/app tree: ${m[1]}; Next builds it as a route (move it out of pages/)`,
	),
	/** `Error when allocating new name: ... container name "/api-worker" is already in use` */
	nameConflict: re(
		/container name "\/?([^"\n]{1,200})" is already in use/i,
		(m) => `container name conflict: ${m[1]}; a stale sibling container still holds the name`,
	),
	/** npm ci / pnpm --frozen-lockfile in the image rejects a lockfile written by a newer
	 *  npm/pnpm on the laptop (npm 11 vs the node image's npm 10, pnpm 11 vs a pinned 10). */
	lockfile: fixed(
		/npm ci` can only install packages when your package\.json and package-lock\.json|ERR_PNPM_(LOCKFILE_CONFIG_MISMATCH|OUTDATED_LOCKFILE)/,
		() =>
			'lockfile rejected by the package manager in the image (written by a newer npm/pnpm locally): pin the same version in the Dockerfile or regenerate the lock with the image version',
	),
	diskFull: fixed(/no space left on device/i, () => 'disk full on the server (no space left on device)'),
	/** An image or tag missing in its registry. powder builds on the server, so this is
	 *  usually a FROM image of the Dockerfile; only a registry-mode app pulls its own image. */
	manifestMissing: fixed(/(manifest unknown|manifest for [^\n]{0,300} not found|not found: manifest|pull access denied)/i, (c) =>
		isRegistryPullStep(c.step)
			? "image not found in its registry: the app's compose image: names a tag that was never pushed (or a misspelled name)"
			: 'an image the build needs was not found: check the FROM lines of the Dockerfile (image name and tag)',
	),
	registryDenied: fixed(/denied: requested access to the resource is denied|unauthorized: authentication required/i, (c) =>
		isRegistryPullStep(c.step)
			? "registry auth denied pulling the app's image: run docker login for that registry on the server, or make the image public"
			: 'registry auth denied pulling a FROM image of the Dockerfile: use a public image, or docker login on the server for a private one',
	),
	/** The git-auth preflight (deploy/script.ts, deploy/self-deploy.ts) prints its own
	 *  line with the LAST lines of `git ls-remote`, which are cut before the words git
	 *  itself uses for an auth failure: the line is read by its fixed words. */
	gitRemoteUnreadable: (c) => {
		const l = c.lines.findLast((x) => x.startsWith(GIT_REMOTE_UNREADABLE))
		if (!l) return null
		const detail = l.split(' :: ').slice(1).join(' :: ').replace(/\s+/g, ' ').trim().slice(0, 200)
		return `git auth failed: powder cannot read the git remote (deploy key missing or not authorized on the repo, or a wrong remote URL)${detail ? `: ${detail}` : ''}`
	},
	gitAuth: fixed(/Permission denied \(publickey\)|Could not read from remote repository/i, () => 'git auth failed: deploy key missing or not authorized on the repo'),
	localChanges: fixed(/Your local changes to the following files would be overwritten/i, () => 'git pull blocked by uncommitted local changes on the server'),
	detachedHead: fixed(/You are not currently on a branch|detached HEAD/i, () => 'git is in detached HEAD on the server; reattach to the default branch'),
	/** git's own last fatal line in a git step (`fatal: couldn't find remote ref main`). */
	gitFatal: (c) => {
		const l = lastLine(c.lines, /^(?:fatal|error): /)
		return l ? `git failed: ${l}` : null
	},
	dockerDown: fixed(/Cannot connect to the Docker daemon/i, () => 'docker daemon is down on the server'),
	oomKilled: fixed(
		/(Killed|signal: killed|out of memory|Cannot allocate memory|JavaScript heap out of memory)/i,
		() => 'build ran out of memory (OOM-killed): add memory or swap on the server, or make the build use less',
	),
	/** A tracked migration re-runs a CREATE/ALTER whose object already exists: the schema
	 *  was applied out-of-band or _powder_migrations desynced. Not a connectivity problem. */
	collision: re(
		/relation "([^"\n]{1,200})" already exists|column "([^"\n]{1,200})" of relation [^\n]{0,300} already exists|already exists\b/i,
		(m) =>
			`migration collision${m[1] || m[2] ? `: ${m[1] || m[2]} already exists` : ''}; a migration was applied out-of-band or _powder_migrations is behind; baseline it, don't re-run`,
	),
	/** powder-migrate's `[migrate] FAILED on <file>` with the database's own ERROR line above it. */
	migrationError: (c) => {
		const failed = c.text.match(/^\[migrate\] FAILED on (\S{1,200})/m)
		const err = lastLine(c.lines, /^(?:psql:[^\n]{0,300}?: )?ERROR: /)
		if (!failed && !err) return null
		const what = err ? err.replace(/^psql:[^\n]{0,300}?: (?=ERROR: )/, '').replace(/\s+/g, ' ') : null
		return `migration ${failed ? `${failed[1]} ` : ''}failed${what ? `: ${what}` : ''}`
	},
	connRefused: re(/ECONNREFUSED[ \t]{1,20}([\d.]{1,64}:\d{1,5})?/i, (m) => `connection refused${m[1] ? ` to ${m[1]}` : ''}; a dependency (db / sibling service) was not reachable`),
	/** compose recreated the container but it crash-loops / exits immediately */
	crashLoop: fixed(
		/(Container [^\n]{0,300} (Error|Exited)|exited with code|unhealthy|dependency failed to start)/i,
		() => 'container failed to start / crash-looped after recreate',
	),
	noSuchService: re(/no such service:?[ \t]{0,20}(\S{1,200})/i, (m) => `compose service not found: ${m[1]}; service name probably differs from container_name`),
	sshTimeout: re(/SSH timeout to (\S{1,300})/i, (m) => `SSH timed out to ${m[1]}; server unreachable or overloaded`),
	healthCheck: fixed(/health check failed/i, () => 'post-deploy health check failed (auto-rollback may have run)'),
	/** powder's own refusal / guard / preflight line (TOOL_CAUSE_LINE_RE): the last one in the region. */
	toolLine: (c) => lastToolCauseLine(c.lines, c.kind),
	/** swap-check's `FAILED (<why>)` line, with the candidate's own last error line when its log shows one. */
	swapFailed: (c) => {
		const at = c.lines.findLastIndex((l) => l.startsWith('swap-check: FAILED ('))
		if (at === -1) return null
		const failed = (c.lines[at] ?? '').trim().slice(0, 200)
		const log = candidateLogLines(c.lines.slice(at + 1))
		const err = lastLine(log, /\b(?:Error|ERROR|FATAL|Fatal|panic|Exception|ECONNREFUSED)\b/)
		return err ? `${failed}: ${err.slice(0, 200)}` : failed
	},
	/** Test runner results (findTestFailures). A heap message the memory rule set aside
	 *  because tests failed after it is called out, so NODE_OPTIONS is not the fix. */
	testFailures: (c) => {
		const tests = findTestFailures(ownScope(c).text)
		if (!tests) return null
		const where = c.kind === 'test' ? 'the test gate' : c.step ? `the step "${failedStepText(c.step)}"` : 'the tests'
		const { file, first } = tests
		if (HEAP_OOM_RE.test(c.text))
			return `test-failure: ${file ? `first failing file: ${file}, ${where} failed on test assertions` : `${where} failed on test assertions`}; the "heap limit" message in the log came from a side process and is not the cause, so NODE_OPTIONS will not fix it`
		// cause first (the failing file or test, the runner's count): the summary's end may be cut
		const more = tests.failLines > 1 ? ` (and ${tests.failLines - 1} more)` : ''
		const tap = tests.notOk ? `first failing test: ${tests.notOk.first}${tests.notOk.count > 1 ? ` (and ${tests.notOk.count - 1} more)` : ''}` : null
		const parts = [file ? `first failing file: ${file}` : first ? `FAIL ${first}${more}` : tap, tests.summary]
		const said = parts.filter(Boolean).join(', ')
		return `test-failure: ${said || `the tests failed in ${where}`}`
	},
	/** vitest's run failed on an unhandled error while every test passed: its `Errors  N
	 *  error(s)` summary line and the file the error came from (`This error originated in
	 *  "<file>"`). */
	unhandledErrors: (c) => {
		const t = stripAnsi(ownScope(c).text).replace(BUILDKIT_PREFIX_RE, '')
		const n = [...t.matchAll(/^[ \t]*Errors[ \t]+(\d{1,6}) errors?\b/gm)].at(-1)
		if (!n || Number(n[1]) === 0) return null
		const files = [...new Set([...t.matchAll(/This error originated in "([^"\n]{1,300})"/g)].map((m) => m[1] ?? ''))]
		const from = files[0] ? ` from ${files[0]}${files.length > 1 ? ` (and ${files.length - 1} more files)` : ''}` : ''
		return `test-failure: an unhandled error${from} failed the run (Errors ${n[1]} error${n[1] === '1' ? '' : 's'})`
	},
	/** A located TypeScript error (or a rejected lockfile) in a test gate's output. */
	checkError: (c) => {
		const l = commitOnlyLine(c.lines.map((x) => x.trim()), '')
		return l ? `the test gate failed: ${l}` : null
	},
	/** The gate script's own last word: only from the GATE_TAIL_LINES lines before the
	 *  gate's FAILED line, never from the body of the test run (a passing test may print
	 *  error-looking stderr anywhere). First choice: the script's own labelled line that
	 *  reads as a failure (`[test.sh] ... failing the gate`, `GATE FAILED: ...`); then a
	 *  plain shell error (`mv: cannot stat ...`, `sh: x: not found`). Else nothing. */
	gateLine: (c) => {
		const tail = gateTail(c.lines)
		const own = lastLine(tail, GATE_OWN_FAILURE_RE, (x) => /^\[(?:builder )?test-gate\]|^\[builder\]|^\[deadline\]/.test(x))
		const shell = own ? null : lastLine(tail, SHELL_ERROR_RE)
		const l = own ?? shell
		return l ? `the test gate failed: ${l}` : null
	},
	/** BuildKit: a COPY / ADD source that is not there (buildkit-log.ts). */
	copyMissing: (c) => copyMissingReason(c.text),
	/** BuildKit: the RUN step that failed and the lines of ITS OWN output that name the
	 *  cause (buildkit-log.ts, the same reader the builder's verdict uses). */
	runFailed: (c) => {
		const run = c.run
		if (!run) return null
		const detail = run.own ? (commitOnlyLine(run.own, run.command) ?? failingLines(run.own)) : null
		if (!detail || !run.own) return detail ? runFailureText(run.command, detail) : `${runFailureText(run.command)} (exit ${run.exitCode})`
		const unreachable = connectionErrorNear(run.own, detail)
		return runFailureText(run.command, unreachable ?? detail)
	},
	/** BuildKit's own error for anything that is not a failed RUN (a bad Dockerfile, a missing context). */
	failedToSolve: (c) => {
		const m = [...c.text.matchAll(/failed to solve: ([^\n]{1,300})/g)].at(-1)
		return m ? `the image build failed: ${m[1]?.trim()}` : null
	},
	/** The daemon's own error in a pull step. */
	daemonError: (c) => {
		const l = lastLine(c.lines, /Error response from daemon: |^error (?:pulling|from registry)/i)
		return l ? `the image pull failed: ${l}` : null
	},
	/** The release command's own last error line (its output is the app's). */
	releaseLine: (c) => {
		const l = lastLine(c.lines, /\b(?:Error|ERROR|error:|FATAL|failed)\b/, (x) => /^\[release\]/.test(x))
		return l ? `the release command failed: ${l}` : null
	},
} satisfies Record<string, Rule>

/** No step: a heap message set aside because tests failed after it is a test
 *  failure, read before the generic "out of memory" rule can claim it. */
const heapTests: Rule = (c) => (HEAP_OOM_RE.test(c.text) ? R.testFailures(c) : null)

/** A connection error code near the chosen lines of a failed RUN step: within
 *  CONNECTION_NEAR_LINES above or below one of them, in the same step's own lines (never
 *  another step's). A build that queries its database or a service while it builds (a
 *  page export) and cannot reach it prints the query and an error list, the code a few
 *  lines away: the code is the cause. */
const CONNECTION_CODE_RE = /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b(?:[^\n]{0,40}?\b((?:\d{1,3}\.){3}\d{1,3}:\d{1,5}|[a-z0-9][a-z0-9.-]{0,100}:\d{1,5}))?/
const CONNECTION_NEAR_LINES = 5
function connectionErrorNear(own: readonly string[], detail: string): string | null {
	const chosen = new Set(detail.split(' | '))
	for (let i = 0; i < own.length; i++) {
		if (!chosen.has((own[i] ?? '').slice(0, 160))) continue
		for (let j = Math.max(0, i - CONNECTION_NEAR_LINES); j <= Math.min(own.length - 1, i + CONNECTION_NEAR_LINES); j++) {
			const line = own[j] ?? ''
			const m = line.match(CONNECTION_CODE_RE)
			if (!m) continue
			// never a URL's `user:password` read as host:port: no host right after `//` or
			// `:`, or right before `@` (the lines are redacted already; this is the second fence)
			const at = (m.index ?? 0) + m[0].length - (m[2]?.length ?? 0)
			const host = m[2] && !/(?:\/\/|:)$/.test(line.slice(0, at)) && line[at + m[2].length] !== '@' ? m[2] : null
			return `${m[1]}${host ? ` to ${host}` : ''}: the build could not reach its database or a service at build time`
		}
	}
	return null
}

/** How far above the test gate's own FAILED line its fallback may look. A failing gate
 *  script's last word sits right above that line; what can come between is a package
 *  manager's lifecycle trailer after the failed command (npm prints up to about 8
 *  lines: the script, code, path, workspace, location, command, log file) plus a
 *  blank line or two. 15 covers that and stays out of the body of a test run, whose
 *  own result lines are read by testFailures. */
const GATE_TAIL_LINES = 15

/** The lines just above the gate's FAILED line (the end of the region without one). */
function gateTail(lines: readonly string[]): string[] {
	const at = lines.findLastIndex((l) => /^\[(?:builder )?test-gate\] FAILED \(exit /.test(l))
	const end = at === -1 ? lines.length : at
	return lines.slice(Math.max(0, end - GATE_TAIL_LINES), end)
}

/** The gate script's own labelled line that reads as a failure: a label that says so
 *  itself (`GATE FAILED: grep`), or `[<tag>] ...` (not a
 *  powder tag) or an upper-case label (`GATE FAILED: ...`). The label is case-sensitive,
 *  so a test's `Error: ...` is not a gate label. */
const GATE_OWN_FAILURE_RE =
	/^(?:(?:[A-Z][A-Z ]{0,30})?(?:FAIL|ERROR)[A-Z ]{0,30}: |(?:\[[A-Za-z0-9_.-]{1,40}\] |[A-Z][A-Z ]{2,30}: )[^\n]*\b(?:[Ff]ail(?:s|ed|ing|ure)?|FAIL(?:ED)?|[Ee]rrors?|ERRORS?|[Cc]annot|[Dd]enied|[Rr]efus\w*|[Aa]bort\w*|not found|found \d))/

/** A plain shell error: `<command>: <what went wrong>` (coreutils, sh, bash). */
const SHELL_ERROR_RE =
	/^(?:[\w./-]{1,80}: (?:line \d{1,6}: )?)?[\w.-]{1,40}: [^\n]{0,200}(?:cannot |No such file or directory|not found|Permission denied|command not found|Is a directory|Not a directory)/

/** Lines of a candidate's log dump (swap-check prints it between two banners). */
function candidateLogLines(lines: readonly string[]): string[] {
	const start = lines.findIndex((l) => /^── last \d{1,4} log lines of \S{1,200} ──$/.test(l.trim()))
	if (start === -1) return []
	const end = lines.findIndex((l, i) => i > start && /^── end of \S{1,200} logs ──$/.test(l.trim()))
	return lines.slice(start + 1, end === -1 ? undefined : end)
}

/** The evidence each kind of step may be explained by, most specific first. A rule
 *  that is not listed for a kind never names that kind's cause. powder's own lines
 *  come before the app's evidence (a refusal or the deadline is the reason the step
 *  stopped); memory comes before the generic "out of memory" and test rules (a V8 heap
 *  limit needs a flag, not more memory). */
const KIND_RULES: Readonly<Record<FailureStepKind, readonly Rule[]>> = {
	build: [R.builderApp, R.toolLine, R.memory, R.testFailures, R.unhandledErrors, (c) => R.lockfile(ownScope(c)), R.diskFull, R.dockerDown, (c) => R.oomKilled(ownScope(c)), R.copyMissing, R.runFailed, R.manifestMissing, R.registryDenied, R.failedToSolve, R.sshTimeout],
	test: [R.toolLine, R.memory, R.testFailures, R.unhandledErrors, R.checkError, R.gateLine],
	pull: [R.toolLine, R.manifestMissing, R.registryDenied, R.diskFull, R.dockerDown, R.sshTimeout, R.daemonError],
	git: [R.gitRemoteUnreadable, R.gitAuth, R.localChanges, R.detachedHead, R.diskFull, R.sshTimeout, R.toolLine, R.gitFatal],
	migrate: [R.collision, R.migrationError, R.connRefused, R.toolLine, R.diskFull, R.dockerDown],
	release: [R.toolLine, R.memory, R.collision, R.connRefused, R.releaseLine],
	'swap-check': [R.authCheck, R.swapFailed, R.toolLine],
	container: [R.toolLine, R.nameConflict, R.noSuchService, R.diskFull, R.dockerDown, R.manifestMissing, R.registryDenied, R.crashLoop, R.connRefused, R.sshTimeout, R.healthCheck],
	guard: [R.pagesTestFile, R.toolLine, R.diskFull, R.dockerDown, R.sshTimeout],
}

/** A step powder does not print (a forged trailer, a step of another release):
 *  only powder's own lines and the server's state can explain it. */
const UNKNOWN_STEP_RULES: readonly Rule[] = [R.toolLine, R.diskFull, R.dockerDown, R.sshTimeout]

/** No trailer at all (an SSH or setup error thrown before the script ran): there is
 *  no step to read by, so the whole text is read with every rule, as before steps
 *  were read (most specific first). */
const NO_STEP_RULES: readonly Rule[] = [
	R.memory,
	heapTests,
	R.builderApp,
	R.authCheck,
	R.pagesTestFile,
	R.nameConflict,
	R.lockfile,
	R.diskFull,
	R.manifestMissing,
	R.registryDenied,
	R.gitRemoteUnreadable,
	R.gitAuth,
	R.localChanges,
	R.detachedHead,
	R.dockerDown,
	R.oomKilled,
	R.collision,
	R.connRefused,
	R.crashLoop,
	R.noSuchService,
	R.sshTimeout,
	R.healthCheck,
]

// ── the authority ────────────────────────────────────────────────────────────

const SCAN_TAIL_CHARS = 64 * 1024
const SCAN_LINE_CHARS = 2048

function boundScanText(text: string): string {
	const tail = text.length > SCAN_TAIL_CHARS ? text.slice(-SCAN_TAIL_CHARS) : text
	return tail
		.split('\n')
		.map((l) => (l.length > SCAN_LINE_CHARS ? l.slice(0, SCAN_LINE_CHARS) : l))
		.join('\n')
}

/** powder's own marker lines (`__POWDER_FAIL__`, a run's nonced markers): never a summary. */
const MARKER_LINE_RE = /^__POWDER_[A-Z_]{1,40}(?:_[A-Za-z0-9]{1,64})?__/

function lastNonEmptyLine(text: string): string {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		// drop our own markers + the section banners so the fallback is real signal
		.filter((l) => l && !MARKER_LINE_RE.test(l) && !/^──.*──$/.test(l))
	return lines.at(-1) ?? 'deploy failed (no output captured)'
}

/** The failing step's own region: from its last "── <step> ──" banner to the
 *  trailer after it; the whole text when the banner is not there. */
function stepRegion(output: string, step: string | null): string {
	if (!step) return output
	const at = output.lastIndexOf(`── ${step} ──`)
	if (at === -1) return output
	const end = output.indexOf('__POWDER_FAIL__', at)
	return output.slice(at, end === -1 ? undefined : end)
}

/** The one-line summary of a failed deploy: THE answer to "why did it fail", read
 *  by the failed step first and then by the evidence in that step's region of the
 *  log (see the top of this file). `log` is the raw output (masking happens here,
 *  on what leaves). One line, masked. Pure. */
export function summarizeDeployFailure(p: { step: string | null; exitCode: number | null; log: string }): SafeText {
	const output = stripAnsi(p.log)
	const step = p.step
	const kind = failureStepKind(step)
	// ReDoS bound: the rules see at most the last SCAN_TAIL_CHARS of the region, each
	// line cut at SCAN_LINE_CHARS (the cause is at the end).
	const raw = boundScanText(stepRegion(output, step))
	// redacted once, before any rule cuts a fragment out of a line (see Ctx)
	const text = String(redactSecrets(raw))
	const build = kind === 'build'
	const ctx: Ctx = {
		text,
		lines: text.split('\n'),
		raw,
		rawRun: build ? lastFailedRun(raw) : null,
		step,
		kind,
		run: build ? lastFailedRun(text) : null,
		exitCode: p.exitCode,
	}
	const rules: readonly Rule[] = !step ? NO_STEP_RULES : kind ? KIND_RULES[kind] : UNKNOWN_STEP_RULES
	for (const rule of rules) {
		const s = rule(ctx)
		if (s) return oneLine(s)
	}
	if (!step) return redactSecrets(lastNonEmptyLine(redactSecrets(output)))
	// `timeout` (a step's own time limit, or the deadline trap) exits 124
	return oneLine(p.exitCode === 124 ? `${stepOnlySummary(step)} (exit 124: a time limit stopped it)` : stepOnlySummary(step))
}

/** One line (the summary is a single line everywhere it goes), masked. */
function oneLine(s: string): SafeText {
	return redactSecrets(s.replace(/\s*\n\s*/g, ' ').trim())
}

export function parseDeployFailure(rawOutput: string | null | undefined): DeployFailure {
	const output = rawOutput ?? ''
	// authoritative step/code from the remote trap (last marker wins: there can be
	// nested ones from retried sub-shells).
	const markers = [...output.matchAll(/__POWDER_FAIL__[ \t]{1,20}step=([^\n]{0,200}?)[ \t]{1,20}code=(\d{1,5})/g)]
	const marker = markers.at(-1) ?? null
	// masked once here, where the trailer is first read: every consumer (the stored
	// failed_step, the summary, the event, the APIs) gets this value
	const failedStep = maskedFailedStep(marker?.[1]?.trim() || null)
	const exitCode = marker ? Number(marker[2]) : null
	return { failedStep, exitCode, errorSummary: summarizeDeployFailure({ step: failedStep, exitCode, log: output }) }
}

// Maps any caught error from a deploy attempt into the fields finishDeploy
// stores. DeployStepError already carries them; anything else (env-render
// failure, startDeploy issue, raw SSH error) gets a best-effort summary by
// running the pattern matcher over its message. `error` is the full text kept
// in the `error` column; the rest drive the dashboard's at-a-glance banner.
export function deployFailureFromError(err: unknown): {
	error: SafeText
	failedStep: string | null
	exitCode: number | null
	errorSummary: SafeText
	testGate: TestGate | null
	/** the commit the failed run synced or built (DeployStepError.builtSha); null = unknown */
	builtSha: string | null
} {
	if (err instanceof DeployStepError) {
		return {
			error: redactSecrets(err.message),
			failedStep: err.failedStep,
			exitCode: err.exitCode,
			errorSummary: err.errorSummary,
			testGate: storedTestGate(err.testGate, err.failedStep),
			builtSha: err.builtSha,
		}
	}
	const raw = err instanceof Error ? err.message : 'unknown error'
	// powder's own DB failed (a slow write, a dropped connection): say so, never the
	// query text or its params (drizzle puts both in the message) as the summary.
	if (isPowderDbError(err)) {
		const pgMsg = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
		return {
			error: redactSecrets(`${raw.replace(/\nparams: [\s\S]*$/, '')}${pgMsg}`),
			failedStep: null,
			exitCode: null,
			errorSummary: redactSecrets(POWDER_DB_SLOW_SUMMARY),
			testGate: null,
			builtSha: null,
		}
	}
	const error = redactSecrets(raw)
	const parsed = parseDeployFailure(raw)
	return {
		error,
		failedStep: parsed.failedStep,
		exitCode: parsed.exitCode,
		errorSummary: parsed.errorSummary,
		testGate: storedTestGate(null, parsed.failedStep),
		builtSha: null,
	}
}

/** What deploys.test_gate stores for a failed deploy: the nonced mark when there is
 *  one, else 'failed' when the deploy failed at the test gate (a refusal inside the gate,
 *  an image pull, prints no mark), else null. Pure. */
export function storedTestGate(mark: TestGate | null, failedStep: string | null): TestGate | null {
	if (isTestGateStep(failedStep)) return 'failed'
	return mark
}

/** The builder ran the app's .powder/test.sh and the tests failed. Deterministic for the commit: the deploy fails
 *  at the test gate, with no local-build fallback (that re-ran the same tests on the production server). */
export class BuilderTestGateFailedError extends Error {
	/** the commit the builder built and tested (its nonced marker); null when unknown */
	readonly builtSha: string | null
	constructor(builtSha: string | null = null) {
		super('the tests in .powder/test.sh failed on the builder')
		this.name = 'BuilderTestGateFailedError'
		this.builtSha = builtSha
	}
}

// Thrown by rebuildDeploy on a non-zero remote exit. `.message` stays the full
// log, masked (callers store err.message into the `error` column), while the
// parsed fields ride alongside for the dashboard.
export class DeployStepError extends Error {
	readonly failedStep: string | null
	readonly exitCode: number | null
	readonly errorSummary: SafeText
	/** the test gate's outcome from the run's nonced mark (deploys.test_gate); null = none */
	testGate: TestGate | null = null
	/** the commit the failed run had synced or built (nonced marker); null = unknown. The
	 *  commit status of the failure goes on it, not on the requested commit. */
	builtSha: string | null = null

	constructor(fullOutput: string) {
		super(redactSecrets(fullOutput))
		this.name = 'DeployStepError'
		const parsed = parseDeployFailure(fullOutput)
		this.failedStep = parsed.failedStep
		this.exitCode = parsed.exitCode
		this.errorSummary = parsed.errorSummary
	}

	withTestGate(result: TestGate | null): this {
		this.testGate = result
		return this
	}

	withBuiltSha(sha: string | null | undefined): this {
		this.builtSha = sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null
		return this
	}
}

/** What the worker logs for an unhandled rejection. A DeployStepError's message is
 *  the failed deploy's whole output (test TAP, build log): log one line (name,
 *  failed step, exit code, summary) instead, the full output is already on the
 *  deploy row. Any other reason is returned as is, stack included. Pure. */
export function unhandledRejectionLogValue(reason: unknown): unknown {
	if (!(reason instanceof DeployStepError)) return reason
	const step = reason.failedStep ?? 'unknown'
	const exit = reason.exitCode ?? 'unknown'
	return `${reason.name} failed_step=${step} exit=${exit}: ${reason.errorSummary}`
}
