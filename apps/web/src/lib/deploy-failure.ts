// Turns a raw deploy log into a structured, at-a-glance failure. The full log
// is never lost — these fields sit *alongside* it so the dashboard can answer
// "why did this fail" without a human reading the whole blob.
//
// Two inputs feed the result:
//   1. The `__POWDER_FAIL__ step=<phase> code=<rc>` trailer that rebuildDeploy's
//      remote shell prints from an EXIT trap (see lib/deploy/script.ts). This is the
//      authoritative "which phase died + exit code". It exists even when the
//      step produced no stderr of its own — which is exactly the class of
//      silent failure where the log would just end at "── docker compose up ──".
//   2. A pattern scan over the log for a human one-liner. First match wins, so
//      order the table most-specific → most-generic.

// The patterns run on the raw log in memory (masking first would hide words
// they match, e.g. "unauthorized: authentication required"); what leaves this
// module is masked (lib/secret-text.ts): the assembled summary with its
// captures, and the last-line fallback, which is taken from the masked log so
// a key-body line can never become a summary.

import { safeFailedStep } from './notify-text'
import { type SafeText, redactSecrets } from './secret-text'

export interface DeployFailure {
	failedStep: string | null
	exitCode: number | null
	errorSummary: SafeText
}

// Ordered most-specific → most-generic. `summary` may use the regex capture
// groups via the matcher fn so we can name the offending container / file / etc.
// `step` is the failing step from the trap marker (null when there is none).
const PATTERNS: { re: RegExp; summary: (m: RegExpMatchArray, step: string | null) => string }[] = [
	{
		// swap-check's better-auth probe (lib/deploy/fragments.ts swap_auth_check): the
		// candidate passed its health URL but the auth endpoint 5xx'd. Body part is only
		// present when it mentioned SCHEMA_MISMATCH.
		re: /auth check: (\/\S{0,300}) returned (\d{3}) \(better-auth schema mismatch\? run the migration\)(?:: ([^\n]{0,500}?))?\)?(?:\n|$)/,
		summary: (m) =>
			`auth check: ${m[1]} returned ${m[2]} (better-auth schema mismatch? run the migration)${m[3] ? `: ${m[3]}` : ''}`,
	},
	{
		// rebuildDeploy's pages/app test-file preflight (lib/deploy/script.ts). Named
		// explicitly so the dashboard says WHICH file instead of "failed during:
		// preflight pages-test-files".
		re: /test file inside pages\/app tree: (\S{1,300})/,
		summary: (m) =>
			`test file inside pages/app tree: ${m[1]} — Next builds it as a route (move it out of pages/)`,
	},
	{
		// `Error when allocating new name: ... container name "/api-worker" is already in use`
		re: /container name "\/?([^"\n]{1,200})" is already in use/i,
		summary: (m) => `container name conflict: ${m[1]} — a stale sibling container still holds the name`,
	},
	{
		// npm ci / pnpm --frozen-lockfile in the image rejects a lockfile written by a newer
		// npm/pnpm on the laptop (npm 11 vs the node image's npm 10, pnpm 11 vs a pinned 10).
		re: /npm ci` can only install packages when your package\.json and package-lock\.json|ERR_PNPM_(LOCKFILE_CONFIG_MISMATCH|OUTDATED_LOCKFILE)/,
		summary: () =>
			'lockfile rejected by the package manager in the image (written by a newer npm/pnpm locally): pin the same version in the Dockerfile or regenerate the lock with the image version',
	},
	{
		re: /no space left on device/i,
		summary: () => 'disk full on the server (no space left on device)',
	},
	{
		// An image or tag missing in its registry. powder builds on the server, so
		// this is usually a FROM image of the Dockerfile; only a registry-mode app
		// (compose `image:` with no build, step "docker compose pull") pulls its own
		// image from a registry the user set up.
		re: /(manifest unknown|manifest for [^\n]{0,300} not found|not found: manifest|pull access denied)/i,
		summary: (_m, step) =>
			isRegistryPullStep(step)
				? "image not found in its registry: the app's compose image: names a tag that was never pushed (or a misspelled name)"
				: 'an image the build needs was not found: check the FROM lines of the Dockerfile (image name and tag)',
	},
	{
		re: /denied: requested access to the resource is denied|unauthorized: authentication required/i,
		summary: (_m, step) =>
			isRegistryPullStep(step)
				? "registry auth denied pulling the app's image: run docker login for that registry on the server, or make the image public"
				: 'registry auth denied pulling a FROM image of the Dockerfile: use a public image, or docker login on the server for a private one',
	},
	{
		re: /Permission denied \(publickey\)|Could not read from remote repository/i,
		summary: () => 'git auth failed — deploy key missing or not authorized on the repo',
	},
	{
		re: /Your local changes to the following files would be overwritten/i,
		summary: () => 'git pull blocked by uncommitted local changes on the server',
	},
	{
		re: /You are not currently on a branch|detached HEAD/i,
		summary: () => 'git is in detached HEAD on the server — reattach to the default branch',
	},
	{
		re: /Cannot connect to the Docker daemon/i,
		summary: () => 'docker daemon is down on the server',
	},
	{
		re: /(Killed|signal: killed|out of memory|Cannot allocate memory|JavaScript heap out of memory)/i,
		summary: () => 'build ran out of memory (OOM-killed): add memory or swap on the server, or make the build use less',
	},
	{
		// A tracked migration re-runs a CREATE/ALTER whose object already exists —
		// the schema was applied out-of-band (hand-run) or _powder_migrations
		// desynced. Distinct, common, and NOT a connectivity problem — name it so
		// nobody goes hunting the DB.
		re: /relation "([^"\n]{1,200})" already exists|column "([^"\n]{1,200})" of relation [^\n]{0,300} already exists|already exists\b/i,
		summary: (m) =>
			`migration collision${m[1] || m[2] ? `: ${m[1] || m[2]} already exists` : ''} — a migration was applied out-of-band or _powder_migrations is behind; baseline it, don't re-run`,
	},
	{
		re: /ECONNREFUSED[ \t]{1,20}([\d.]{1,64}:\d{1,5})?/i,
		summary: (m) => `connection refused${m[1] ? ` to ${m[1]}` : ''} — a dependency (db / sibling service) was not reachable`,
	},
	{
		// compose recreated the container but it crash-loops / exits immediately
		re: /(Container [^\n]{0,300} (Error|Exited)|exited with code|unhealthy|dependency failed to start)/i,
		summary: () => 'container failed to start / crash-looped after recreate',
	},
	{
		re: /no such service:?[ \t]{0,20}(\S{1,200})/i,
		summary: (m) => `compose service not found: ${m[1]} — service name probably differs from container_name`,
	},
	{
		re: /SSH timeout to (\S{1,300})/i,
		summary: (m) => `SSH timed out to ${m[1]} — server unreachable or overloaded`,
	},
	{
		re: /health check failed/i,
		summary: () => 'post-deploy health check failed (auto-rollback may have run)',
	},
]

/** Stable memory-failure kinds. The summary starts with `<kind>: ` so cards dedupe
 *  and robots can match it: `heap-oom` = Node's V8 heap limit (a flag fixes it),
 *  `container-oom` = the process was SIGKILLed (exit 137 / OOMKilled: a memory limit
 *  or the kernel OOM killer; the heap flag does not help). */
export type MemoryFailureKind = 'heap-oom' | 'container-oom'

/** V8's own fatal heap messages (node prints them before aborting). */
export const HEAP_OOM_RE =
	/JavaScript heap out of memory|Reached heap limit|FATAL ERROR: Ineffective mark-compacts|Allocation failed - JavaScript heap/

/** A SIGKILL / OOM kill the deploy log can show: the test gate's own exit line
 *  (lib/deploy/fragments.ts testGateShell), docker build's RUN exit, docker inspect. */
const CONTAINER_OOM_RE = /test-gate\] FAILED \(exit 137\)|did not complete successfully: exit code: 137|"?OOMKilled"?:? ?true/

function isTestGateStep(step: string | null): boolean {
	return !!step && /test gate/i.test(step)
}

/** Classify a failed step's output as a memory failure, or null. One shared function
 *  for every step: the test gate (.powder/test.sh), the image build, the builder. Pure:
 *  same text and step, same answer. A V8 heap signature wins over an exit 137 (the
 *  heap message names the cause). */
export function classifyMemoryFailure(
	text: string,
	step: string | null,
): { kind: MemoryFailureKind; summary: string } | null {
	const gate = isTestGateStep(step)
	const what = step ? `the step "${safeFailedStep(step)}"` : 'a Node process'
	if (HEAP_OOM_RE.test(text)) {
		return {
			kind: 'heap-oom',
			summary: gate
				? 'heap-oom: the test gate ran out of Node heap (the V8 heap limit, not a code bug): set NODE_OPTIONS=--max-old-space-size=<MB> on that step in .powder/test.sh (size it with tsc --extendedDiagnostics "Memory used" or the step\'s peak, plus headroom, under POWDER_TESTGATE_MEM if set)'
				: `heap-oom: ${what} ran out of Node heap (the V8 heap limit, not a code bug): set NODE_OPTIONS=--max-old-space-size=<MB> for that command (Dockerfile: ENV before the RUN; .powder/test.sh: on that line), sized from its peak plus headroom`,
		}
	}
	if (CONTAINER_OOM_RE.test(text)) {
		return {
			kind: 'container-oom',
			summary: gate
				? 'container-oom: the test gate was killed (exit 137, SIGKILL: the test container memory limit or the kernel OOM killer), not a code bug and not the Node heap: add memory or swap on the server, or free memory there; if POWDER_TESTGATE_MEM is set, raise it; NODE_OPTIONS will not help'
				: `container-oom: ${what} was killed (exit 137, SIGKILL: a container memory limit or the kernel OOM killer), not a code bug and not the Node heap: add memory or swap on the server, or make the step use less; NODE_OPTIONS will not help`,
		}
	}
	return null
}

/** The registry-mode pull step of the deploy script (lib/deploy/script.ts). */
function isRegistryPullStep(step: string | null): boolean {
	return !!step && step.startsWith('docker compose pull')
}

const SCAN_TAIL_CHARS = 64 * 1024
const SCAN_LINE_CHARS = 2048

function boundScanText(text: string): string {
	const tail = text.length > SCAN_TAIL_CHARS ? text.slice(-SCAN_TAIL_CHARS) : text
	return tail
		.split('\n')
		.map((l) => (l.length > SCAN_LINE_CHARS ? l.slice(0, SCAN_LINE_CHARS) : l))
		.join('\n')
}

function lastNonEmptyLine(text: string): string {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		// drop our own marker + the section banners so the fallback is real signal
		.filter((l) => l && !l.startsWith('__POWDER_FAIL__') && !/^──.*──$/.test(l))
	return lines.at(-1) ?? 'deploy failed (no output captured)'
}

export function parseDeployFailure(rawOutput: string | null | undefined): DeployFailure {
	const output = rawOutput ?? ''

	// 1. authoritative step/code from the remote trap (last marker wins — there
	//    can be nested ones from retried sub-shells).
	const markers = [
		...output.matchAll(/__POWDER_FAIL__[ \t]{1,20}step=([^\n]{0,200}?)[ \t]{1,20}code=(\d{1,5})/g),
	]
	const marker = markers.at(-1) ?? null
	const failedStep = marker?.[1]?.trim() || null
	const exitCode = marker ? Number(marker[2]) : null

	// 2. human one-liner: first matching pattern, else the step name, else the
	//    last meaningful line.
	//
	// Scope the scan to the FAILING STEP's own output — the region from the last
	// "── <failedStep> ──" banner to the fail marker. Otherwise benign noise from
	// an earlier phase hijacks the summary: e.g. a Next.js `next build` that
	// queries the DB at build time prints ECONNREFUSED (harmless — the build
	// still succeeds), and a LATER db-migrate collision was mis-summarized as
	// "connection refused / dependency not reachable".
	// Fall back to the whole log when the banner isn't found.
	let scanText: string = output
	if (failedStep) {
		const banner = `── ${failedStep} ──`
		const at = output.lastIndexOf(banner)
		if (at !== -1) {
			const end = output.indexOf('__POWDER_FAIL__', at)
			scanText = output.slice(at, end === -1 ? undefined : end)
		}
	}

	// ReDoS bound: the patterns see at most the last SCAN_TAIL_CHARS of the
	// region, each line cut at SCAN_LINE_CHARS (the cause is at the end).
	const window = boundScanText(scanText)
	// Memory failures first: a heap OOM log also matches the generic "out of memory"
	// pattern below, which gives the wrong fix (add memory) for a V8 heap limit.
	const mem = classifyMemoryFailure(window, failedStep)
	let errorSummary: SafeText | null = mem ? redactSecrets(mem.summary) : null
	for (const { re, summary } of mem ? [] : PATTERNS) {
		const m = window.match(re)
		if (m) {
			// Captures come from the raw log: mask the assembled line.
			errorSummary = redactSecrets(summary(m, failedStep))
			break
		}
	}
	if (!errorSummary) {
		errorSummary = redactSecrets(
			failedStep
				? `failed during: ${safeFailedStep(failedStep)}`
				: lastNonEmptyLine(redactSecrets(output)),
		)
	}

	return { failedStep, exitCode, errorSummary }
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
} {
	if (err instanceof DeployStepError) {
		return {
			error: redactSecrets(err.message),
			failedStep: err.failedStep,
			exitCode: err.exitCode,
			errorSummary: err.errorSummary,
		}
	}
	const raw = err instanceof Error ? err.message : 'unknown error'
	const error = redactSecrets(raw)
	const parsed = parseDeployFailure(raw)
	return {
		error,
		failedStep: parsed.failedStep,
		exitCode: parsed.exitCode,
		errorSummary: parsed.errorSummary,
	}
}

/** The builder ran the app's .powder/test.sh and the tests failed. Deterministic for the commit: the deploy fails
 *  at the test gate, with no local-build fallback (that re-ran the same tests on the production server). */
export class BuilderTestGateFailedError extends Error {
	constructor() {
		super('the tests in .powder/test.sh failed on the builder')
		this.name = 'BuilderTestGateFailedError'
	}
}

// Thrown by rebuildDeploy on a non-zero remote exit. `.message` stays the full
// log, masked (callers store err.message into the `error` column), while the
// parsed fields ride alongside for the dashboard.
export class DeployStepError extends Error {
	readonly failedStep: string | null
	readonly exitCode: number | null
	readonly errorSummary: SafeText

	constructor(fullOutput: string) {
		super(redactSecrets(fullOutput))
		this.name = 'DeployStepError'
		const parsed = parseDeployFailure(fullOutput)
		this.failedStep = parsed.failedStep
		this.exitCode = parsed.exitCode
		this.errorSummary = parsed.errorSummary
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
