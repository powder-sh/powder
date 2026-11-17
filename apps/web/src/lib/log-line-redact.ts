import { redactSecrets, type SafeText } from './secret-text'

// a log stream arrives in chunks that can split a line (and a secret) anywhere.
// lineRedactor buffers up to the last complete line, masks whole lines with
// redactSecrets and emits them; the rest waits for the next chunk. A PEM private key
// block that has begun but not ended is held back whole (its body lines alone do not
// look like a secret). flush() masks and emits what is left (stream end, error). A
// pending tail longer than maxPending (one endless line) is masked and emitted as it is
// (redactSecrets keeps only the head of a line over LINE_MAX_CHARS, so the cut itself
// is never shown) and the REST OF THAT LINE is dropped up to its newline: a
// secret straddling the cut can never be emitted as an unmasked second half.

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g

function lastIndex(re: RegExp, s: string): number {
	let at = -1
	for (const m of s.matchAll(re)) at = m.index ?? at
	return at
}

export function lineRedactor(emit: (text: SafeText) => void, maxPending = 256 * 1024): { push: (chunk: string) => void; flush: () => void } {
	let pending = ''
	let skipping = false
	const out = (s: string) => {
		if (s !== '') emit(redactSecrets(s))
	}
	return {
		push(chunk: string) {
			if (skipping) {
				const nl = chunk.indexOf('\n')
				if (nl < 0) return
				// keep the newline: the next line starts on its own line
				chunk = chunk.slice(nl)
				skipping = false
			}
			pending += chunk
			const nl = pending.lastIndexOf('\n')
			if (nl >= 0) {
				const done = pending.slice(0, nl + 1)
				const open = lastIndex(PEM_BEGIN, done) > lastIndex(PEM_END, done)
				if (!open) {
					pending = pending.slice(nl + 1)
					out(done)
				}
			}
			if (pending.length > maxPending) {
				const p = pending
				pending = ''
				out(p)
				skipping = !p.endsWith('\n')
			}
		},
		flush() {
			const p = pending
			pending = ''
			out(p)
		},
	}
}
