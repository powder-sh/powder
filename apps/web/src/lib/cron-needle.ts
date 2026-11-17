import { MASK } from './secret-text'

// Pull a stable substring out of a command we can pass to grep without false
// positives. Strip leading env vars, redirections, and bash -c wrappers.
// The command arrives MASKED (GET /api/crons masks it server-side), so the
// needle stops at the first mask token: the journal holds the real command,
// and the part before the secret still finds it.
export function grepNeedle(command: string): string {
	let s = command.trim()
	// Drop `bash -c '<inner>'` wrapping if present so we grep on the inner cmd.
	const bashC = s.match(/(?:bash|sh)\s+-c\s+['"](.+)['"]\s*$/)
	if (bashC) s = bashC[1] ?? s
	// Strip leading `cd … &&`, `VAR=val`, etc.
	s = s.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, '')
	s = s.replace(/^cd\s+\S+\s*&&\s*/, '')
	const cut = s.indexOf(MASK)
	if (cut !== -1) s = s.slice(0, cut)
	// Cap at 60 chars and trim quotes so the grep -F arg is well-formed.
	return s.slice(0, 60).replace(/['"`]/g, '')
}
