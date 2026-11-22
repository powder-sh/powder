// The short view of a failed deploy's log for list readers (the per-app deployments tab):
// the summary fields plus the end of the log, never the whole log. The query reads only
// the last LOG_WINDOW_CHARS of output and error (a log can be megabytes); this turns those
// windows into the masked tail. The full log stays on /deploys/<id>.

import { failureTail, tailCuts } from './deploy-log'
import { redactSecrets } from './secret-text'

/** How much of output and error the list query reads for a failed deploy. */
export const LOG_WINDOW_CHARS = 64 * 1024

/** A window cut by `right(col, LOG_WINDOW_CHARS)` may start mid-line, even mid-secret:
 *  drop that partial first line, then mask. Pure. */
export function maskWindow(text: string | null | undefined, windowChars = LOG_WINDOW_CHARS): string | null {
	if (text == null) return null
	const cut = text.length >= windowChars
	const whole = cut ? text.slice(text.indexOf('\n') + 1) : text
	return redactSecrets(whole)
}

/** The masked tail of a failed deploy and whether it leaves part of the log out. Pure. */
export function failureTailFromWindows(
	w: { output: string | null | undefined; error: string | null | undefined },
	windowChars = LOG_WINDOW_CHARS,
): { logTail: string; logCut: boolean } {
	const output = maskWindow(w.output, windowChars)
	const error = maskWindow(w.error, windowChars)
	const logTail = failureTail({ output, error })
	const windowCut = (w.output?.length ?? 0) >= windowChars || (w.error?.length ?? 0) >= windowChars
	return { logTail, logCut: windowCut || tailCuts(output ?? '') || tailCuts(error ?? '') }
}
