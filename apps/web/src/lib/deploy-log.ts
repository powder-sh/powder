// Display-only clean-up of a deploy log. The stored text keeps the
// `__POWDER_FAIL__ step=... code=...` trailer (lib/deploy-failure.ts parses it);
// the page shows the failed step and exit code in its own banner instead.

export function stripFailMarkers(text: string): string {
	return text.replace(/^[ \t]*__POWDER_FAIL__[^\n]*(\n|$)/gm, '')
}

// ── a failed deploy's log: one copy, and its tail ──────────────────────────────
// A step failure's `error` used to hold the step's whole log, which `output` holds
// too: the page showed it twice. The deploy runner now stores only the tail in `error`
// when every line of it is already in `output` (errorToStore); older rows still carry
// the whole log in both, so the readers below decide by content, never by row age.

/** How much of a failed log the short views show: the per-app tab, the copied error,
 *  and what the runner keeps in `error` when `output` has it all. */
export const FAILURE_TAIL_LINES = 60
export const FAILURE_TAIL_CHARS = 8 * 1024

function contentLines(text: string): string[] {
	return stripFailMarkers(text)
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '')
}

/** True when every non-empty line of `error` (fail markers aside) is also a line of
 *  `output`: showing `output` alone then loses nothing the error said. Pure. */
export function errorCoveredByOutput(error: string | null | undefined, output: string | null | undefined): boolean {
	if (!error) return true
	if (!output) return false
	const have = new Set(contentLines(output))
	return contentLines(error).every((l) => have.has(l))
}

/** The one log text the deploy page shows, copies and downloads: `output`, with the
 *  error in front only when it says something `output` does not. Fail markers removed. Pure. */
export function deployLogText(d: { output: string | null | undefined; error: string | null | undefined }): string {
	const output = d.output ?? ''
	if (d.error && !errorCoveredByOutput(d.error, output)) {
		return stripFailMarkers(`ERROR: ${d.error}\n\n${output}`)
	}
	return stripFailMarkers(output)
}

/** The last `lines` lines of `text`, at most `maxChars` characters, whole lines only
 *  (a single longer line is cut from its end). Trailing blank space dropped. Pure. */
export function logTailText(text: string, lines = FAILURE_TAIL_LINES, maxChars = FAILURE_TAIL_CHARS): string {
	const all = text.replace(/\s+$/, '').split('\n')
	const out: string[] = []
	let size = 0
	for (let i = all.length - 1; i >= 0 && out.length < lines; i--) {
		const line = all[i] ?? ''
		if (size + line.length + 1 > maxChars) {
			if (out.length === 0) out.push(line.slice(-maxChars))
			break
		}
		out.push(line)
		size += line.length + 1
	}
	return out.reverse().join('\n')
}

/** True when logTailText would leave something out. Pure. */
export function tailCuts(text: string, lines = FAILURE_TAIL_LINES, maxChars = FAILURE_TAIL_CHARS): boolean {
	return logTailText(text, lines, maxChars).length < text.replace(/\s+$/, '').length
}

/** The end of a failed deploy's log, where its cause is: the tail of `output`, followed by
 *  the error when the error says something `output` does not (a health check verdict, a
 *  watchdog note). Fail markers removed. Pure. */
export function failureTail(d: { output: string | null | undefined; error: string | null | undefined }): string {
	const output = (d.output ?? '').replace(/\s+$/, '')
	const extra = d.error && !errorCoveredByOutput(d.error, output) ? d.error : null
	const source = extra ? (output ? `${output}\n\nERROR: ${extra}` : extra) : output
	return logTailText(stripFailMarkers(source))
}

/** What the runner stores in `error` for a failure: when every line of it is already in
 *  `output` (a step failure, whose error is the step's whole log), only its tail, so the
 *  log is stored once; otherwise the error unchanged. `output` must be masked like `error`
 *  (both leave powder masked). Pure. */
export function errorToStore(error: string, maskedOutput: string): string {
	return errorCoveredByOutput(error, maskedOutput) ? logTailText(error) : error
}
