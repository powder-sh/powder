// The one reader of a BuildKit build log: which RUN step failed, that step's own
// output lines, and the lines in them that name the cause. Two callers read the
// same text: the dedicated builder's verdict (builder-failure.ts: whose failure
// is it) and the deploy's one-line failure summary for a local build
// (deploy-failure.ts: why did it fail). Pure, no I/O.

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** Terminal escapes: CSI sequences (colours, cursor moves), OSC sequences (titles,
 *  links) and the two-byte escapes. Test runners and compose colour their output. */
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, 'g')

/** `text` without terminal escapes, with CR LF and lone CR (progress redraws) as LF. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '').replace(/\r\n?/g, '\n')
}

/** BuildKit plain progress prefixes every line of a RUN step with "#<step> <seconds> "
 *  (or "#<step> " on its own lines). */
export const BUILDKIT_PREFIX_RE = /^#\d{1,4} (?:\d{1,6}(?:\.\d{1,3})? )?/gm

/** BuildKit's line for a RUN step that exited non-zero. Matched without the
 *  `failed to solve:` prefix: a long output is cut in the middle and can lose it. */
const RUN_FAILED_RE = /process "\/bin\/sh -c ([^\n]{0,2000}?)" did not complete successfully: exit code: (\d{1,3})/g

/** BuildKit: a COPY / ADD source that is not there. */
const COPY_MISSING_RE = /failed to calculate checksum of ref [^\n]{0,300}: ("[^"\n]{1,500}"): not found/

/** A RUN command that installs packages: dependencies' install scripts print
 *  into its output, so a TypeScript error there is not the commit's. */
const INSTALL_COMMAND_RE = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add)\b|(?:^|[\s;&|])yarn\s*(?:$|&&|;)/

/** Lines in a failed build or install step that only the commit causes
 *  (`build`: not accepted from an install step). */
const COMMIT_ONLY: { re: RegExp; what: string; build?: true }[] = [
	{ re: /npm (?:error|ERR!) code EUSAGE[\s\S]{0,400}?`npm ci` can only install packages when your package\.json and package-lock\.json/, what: 'npm ci rejected the lockfile: package.json and package-lock.json are not in sync' },
	{ re: /ERR_PNPM_OUTDATED_LOCKFILE/, what: 'pnpm rejected the lockfile: ERR_PNPM_OUTDATED_LOCKFILE' },
	{ re: /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/, what: 'pnpm rejected the lockfile: ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' },
	// located: `file(line,col): error TS1234:` or `file:line:col - error TS1234:`. A bare
	// `error TS5033: Could not write file` is the compiler's own I/O (a full disk).
	// A module or its types not found counts only for a relative path: a package that is
	// missing is the state of node_modules (a damaged install or cache mount), not the commit.
	{ re: /^[^\n]{1,400}?(?:\(\d+,\d+\): |:\d+:\d+ - )error TS(?!(?:2307|7016|2688|2792): (?![^\n]{0,80}'\.{1,2}\/))\d{4}: [^\n]{0,200}/m, what: '', build: true },
	{ re: /^Failed to type check\.$/m, what: 'the type check failed', build: true },
]

const cleanLine = (line: string) =>
	line
		.replace(ANSI_RE, '')
		.replace(/^#\d+ (?:[\d.]+ )?/, '')
		.trim()

export interface FailedRun {
	/** the RUN command as BuildKit quotes it */
	command: string
	exitCode: number
	/** the step's own output lines (no `#N <time>` prefix); null when its
	 *  `#N ERROR: process` line is not in the output (a cut output) */
	own: string[] | null
}

/** The output lines of the step BuildKit names as failed (`#N ERROR: process
 *  "/bin/sh -c <command>"`), without their `#N <time>` prefix; null when that
 *  line is not in the output (a cut output), so the step's lines are unknown. */
function failedStepLines(output: string, command: string): string[] | null {
	const at = output.lastIndexOf(` ERROR: process "/bin/sh -c ${command}"`)
	const id = at === -1 ? null : (output.slice(output.lastIndexOf('\n', at) + 1, at).match(/^#(\d+)$/)?.[1] ?? null)
	if (id === null) return null
	return output
		.split('\n')
		.filter((l) => l.startsWith(`#${id} `))
		.map(cleanLine)
		.filter((l) => l && !/^ERROR: process |^DONE |^CACHED$|^\[[^\]]+ \d+\/\d+\] /.test(l))
}

/** The last RUN step BuildKit reports as failed, or null when the output names none. */
export function lastFailedRun(output: string): FailedRun | null {
	const run = [...output.matchAll(RUN_FAILED_RE)].at(-1)
	if (!run) return null
	const command = run[1] ?? ''
	return { command, exitCode: Number(run[2]), own: failedStepLines(output, command) }
}

/** The RUN command as a summary names it: cut at RUN_COMMAND_CHARS with an ellipsis,
 *  so a long command never pushes the cause out of a short field (a GitHub commit
 *  status description holds 140 characters). */
const RUN_COMMAND_CHARS = 40
function shortCommand(command: string): string {
	const c = command.replace(/\s+/g, ' ').trim()
	return c.length > RUN_COMMAND_CHARS ? `${c.slice(0, RUN_COMMAND_CHARS - 1)}…` : c
}

/** A failed RUN step, cause first: `<detail> (the Dockerfile step RUN <command>)`, or
 *  `the Dockerfile step RUN <command> failed` when there is no detail. The cause leads
 *  because every place the summary goes may cut its end. */
export function runFailureText(command: string, detail?: string | null): string {
	return detail ? `${detail} (the Dockerfile step RUN ${shortCommand(command)})` : `the Dockerfile step RUN ${shortCommand(command)} failed`
}

/** True when the RUN command installs packages (INSTALL_COMMAND_RE). */
export function isInstallCommand(command: string): boolean {
	return INSTALL_COMMAND_RE.test(command)
}

/** The first line of a failed step's own output that only the commit causes (a
 *  rejected lockfile, a located TypeScript error outside an install step), worded
 *  for a summary; null when there is none. */
export function commitOnlyLine(own: string[], command: string): string | null {
	const text = own.join('\n')
	const install = isInstallCommand(command)
	for (const { re, what, build } of COMMIT_ONLY) {
		if (build && install) continue
		const m = text.match(re)
		if (m) return what || m[0].trim().slice(0, 200)
	}
	return null
}

/** A package manager's own lines after a script it ran failed (npm, yarn, pnpm, bun):
 *  they say THAT the script failed, never why. */
const PM_TRAILER_RE =
	/^(?:npm (?:error|ERR!)|error Command failed with exit code|info Visit https:\/\/yarnpkg\.com|ELIFECYCLE|[^\n]{0,200}ERR_PNPM_|error: script "[^"\n]{1,100}" exited with code)/

/** The last 3 lines of a failed step that look like a failure (its last 2 lines
 *  when none does), for the deploy's one-line summary. A package manager's trailer
 *  never stands for the cause: when only trailer lines look like a failure, the
 *  nearest other line above them is the cause (a formatter's or linter's last word). */
export function failingLines(own: string[]): string {
	const lines = own.filter((l) => !/^npm notice|output truncated/.test(l))
	const isHit = (l: string) => /\berror\b|\bFAIL|failed|✗|×|AssertionError/i.test(l)
	const hits = lines.filter((l) => isHit(l) && !PM_TRAILER_RE.test(l))
	if (hits.length) return hits.slice(-3).map((l) => l.slice(0, 160)).join(' | ')
	// one pass for the last trailer, one walk up from it (linear in the step's lines)
	const lastTrailer = lines.findLastIndex((l) => PM_TRAILER_RE.test(l))
	for (let i = lastTrailer - 1; i >= 0; i--) {
		const l = lines[i] ?? ''
		if (!PM_TRAILER_RE.test(l) && !/^\$ |^> /.test(l)) return l.slice(0, 160)
	}
	return lines.slice(-2).map((l) => l.slice(0, 160)).join(' | ')
}

/** A COPY / ADD whose source is not there, worded for a summary; null when the
 *  output has no such error. BuildKit marks the instruction with `>>>` in its
 *  Dockerfile excerpt, which tells a `--from` stage copy from a plain one. */
export function copyMissingReason(output: string): string | null {
	const copy = output.match(COPY_MISSING_RE)
	if (!copy) return null
	const from = /^\s*\d+ \| >>> (?:COPY|ADD)\b[^\n]*--from=/m.test(output)
	const plain = !from && /^\s*\d+ \| >>> (?:COPY|ADD)\b/m.test(output)
	const where = from ? 'from an earlier build stage, which did not produce it' : plain ? 'which the repo does not have' : 'which is not there (not in the repo, or not produced by the build stage it is copied from)'
	return `the Dockerfile copies ${copy[1]}${from ? ' ' : ', '}${where}`
}
