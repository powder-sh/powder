// Whose failure is a failed builder phase: the app's or the build host's?
//
// A builder phase that fails falls back to a local build on the app's server
// (deploy/run.ts), so a build host outage never blocks a deploy. A failure the
// commit itself causes fails the same way there: the fallback only repeats it
// on the production server. Those are named here and fail the deploy at the
// build step, with no local rebuild.
//
// The verdict is `app` only on positive proof, never for want of a sign of the
// build host: calling a build host fault the app's would block a deploy the
// fallback saves, and build hosts fail in more ways than any list of signs
// holds (a full disk, a killed step, DNS, a registry, a damaged cache mount, a
// database only the app's server reaches). The proofs:
//   - the clone has no Dockerfile at the configured path;
//   - the Dockerfile check refused a construct it does not support (a rule on
//     the Dockerfile's text, the same on any server);
//   - a COPY / ADD names a file that is not there (BuildKit's checksum error
//     with the quoted path; its store errors, which a prune race also
//     produces, do not count);
//   - a RUN step that only runs tests, lint or a type check exited non-zero
//     (the same rule as the builder test gate);
//   - any other RUN step exited non-zero and ITS OWN output (the `#N` lines of
//     the step BuildKit names as failed, never the output of a step before it,
//     which may have printed the same line and passed) carries one of a few
//     lines only the commit can cause: a lockfile the package manager rejects,
//     a TypeScript error with a file position (not in an install step, where a
//     dependency's own scripts print them).
// A step whose own output shows it ran out of memory or disk is never proof.
// Everything else is `builder` (fall back, as before): a failed step whose
// output cannot be told apart from the rest (no `#N ERROR` line, as when a
// long output was cut), and any failure of a build that did not build the
// commit the deploy asked for (the fallback builds that one and may pass).
//
// POWDER_BUILDER_APP_VERDICT=off turns every `app` verdict back into the
// fallback (builderAppVerdictEnabled), for a verdict that proves wrong.

import { commitOnlyLine, copyMissingReason, failingLines, lastFailedRun, runFailureText } from './buildkit-log'
import { redactSecrets } from './secret-text'

export type BuilderFailureVerdict = { kind: 'app'; reason: string } | { kind: 'builder' }

/** False with POWDER_BUILDER_APP_VERDICT=off (also 0 / false / no): every failed
 *  builder phase then falls back to a local build, as before this rule. Read at
 *  each failed builder phase. */
export function builderAppVerdictEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return !/^(off|0|false|no)$/i.test((env.POWDER_BUILDER_APP_VERDICT ?? '').trim())
}

/** A builder script exit at or above this is a kill, a timeout or ssh itself
 *  (124 timeout, 128 git, 137 SIGKILL, 255 ssh), never the build's own verdict. */
const BUILDER_INFRA_EXIT_MIN = 124

/** One `&&` part of a RUN command that only checks the code: a package manager's
 *  test / lint / type check script, or a test runner, linter or tsc called directly
 *  (no pipe, `;` or `||` after it: the step's exit code must be the check's). */
const CHECK_PART_RE =
	/^(?:(?:npm|pnpm|yarn|bun)(?:\s+(?:--filter|-F|-w|--workspace)(?:=|\s+)\S+)*\s+(?:run\s+)?(?:test|lint|typecheck|type-check|formatcheck|format:check|check|docs:check)(?::\S+)?|(?:npx\s+|pnpm\s+exec\s+|yarn\s+)?(?:vitest|jest|tsc|eslint|biome)(?:\s[^|;&]*)?)$/

/** A step that ran out of memory or disk did not judge the code, so a check-only
 *  step (or a proof line) with one of these in the step's own lines is no proof.
 *  A small fixed set of resource-exhaustion signs that only takes verdicts away
 *  from the narrow `app` rules; not a list of build host faults, which no list holds. */
const STEP_EXHAUSTED_RE = /heap out of memory|\bKilled\b|SIG(?:KILL|ABRT)|\b(?:exit(?:ed)?|code|status)\b[^\n]{0,20}\b137\b|ENOSPC|no space left/i

/** The Dockerfile check's refusal of a construct in the Dockerfile's text (every
 *  such rule says "is not supported"). Refusals that depend on the server (a local
 *  image, a base image that could not be pulled or pinned, a file that changed
 *  while it was read) have other words or no path and never match. */
const DOCKERFILE_REFUSED_RE = /^\[build-cache\] refusing \/[^\s:]{1,500}: (an? [^\n]{0,300}? is not supported)/m

/** True when every `&&` part of a RUN command is a test, lint or type check. */
export function isCheckOnlyRunCommand(command: string): boolean {
	const parts = command
		.split('&&')
		.map((p) => p.trim())
		.filter(Boolean)
	return parts.length > 0 && parts.every((p) => CHECK_PART_RE.test(p))
}

/** The verdict for a builder script that exited non-zero. `output`: what it
 *  printed, `exitCode`: its exit code. `requestedSha` / `builtSha`: the commit
 *  the deploy asked for and the one the builder checked out (null: unknown);
 *  with a commit asked for, the verdict is `app` only when that one was built. Pure. */
export function classifyBuilderFailure(
	output: string,
	exitCode: number | null,
	commit: { requestedSha?: string | null; builtSha?: string | null } = {},
): BuilderFailureVerdict {
	if (exitCode === null || exitCode <= 0 || exitCode >= BUILDER_INFRA_EXIT_MIN) return { kind: 'builder' }
	if (commit.requestedSha && commit.requestedSha !== commit.builtSha) return { kind: 'builder' }
	if (/^\[build-cache\] no Dockerfile at /m.test(output)) return { kind: 'app', reason: 'the repo has no Dockerfile at the configured path' }
	// The verdict reads the raw output; every fragment the reason quotes is cut from the
	// REDACTED output, so a cut never drops the context the redactor needs.
	const safe = String(redactSecrets(output))
	if (DOCKERFILE_REFUSED_RE.test(output)) {
		const refused = safe.match(DOCKERFILE_REFUSED_RE)
		return { kind: 'app', reason: `the Dockerfile check refused the Dockerfile${refused ? `: ${refused[1]}` : ''}` }
	}
	const copy = copyMissingReason(output) ? (copyMissingReason(safe) ?? 'the Dockerfile copies a file that is not there') : null
	if (copy) return { kind: 'app', reason: copy }
	const run = lastFailedRun(output)
	const safeRun = lastFailedRun(safe)
	if (!run) return { kind: 'builder' }
	const { command, own } = run
	if (run.exitCode >= BUILDER_INFRA_EXIT_MIN) return { kind: 'builder' }
	if (isCheckOnlyRunCommand(command)) {
		// the step's lines unknown (a cut output): the whole output stands in for them.
		if (STEP_EXHAUSTED_RE.test(own ? own.join('\n') : output)) return { kind: 'builder' }
		const safeOwn = safeRun?.own ?? null
		return { kind: 'app', reason: runFailureText(safeRun?.command ?? '', safeOwn ? failingLines(safeOwn) : null) }
	}
	if (!own) return { kind: 'builder' }
	const text = own.join('\n')
	// a step that ran out of memory or disk proves nothing, whatever else it printed.
	if (STEP_EXHAUSTED_RE.test(text)) return { kind: 'builder' }
	if (!commitOnlyLine(own, command)) return { kind: 'builder' }
	const safeProof = safeRun?.own ? commitOnlyLine(safeRun.own, command) : null
	return { kind: 'app', reason: runFailureText(safeRun?.command ?? '', safeProof ?? 'a line only the commit causes') }
}

/** The builder phase failed on the commit itself (classifyBuilderFailure `app`).
 *  The deploy fails at the build step with no local-build fallback. */
export class BuilderAppBuildFailedError extends Error {
	/** the commit the builder built (its nonced marker); null when unknown */
	readonly builtSha: string | null
	constructor(reason: string, builtSha: string | null = null) {
		super(`${reason} on the builder`)
		this.name = 'BuilderAppBuildFailedError'
		this.builtSha = builtSha
	}
}
