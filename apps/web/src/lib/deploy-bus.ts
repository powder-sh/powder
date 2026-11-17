// In-memory pub/sub for streaming deploy output to SSE subscribers.
// Powder is one process; module-level state is fine.
//
// Event data is SafeText: everything published reaches a browser, so it must
// have been through lib/secret-text.ts. Streams use chunkPublisher, which
// line-buffers so a token split across two chunks is still masked.

import { type SafeText, SecretStreamRedactor, redactSecrets } from './secret-text'

type DeployEvent =
	| { type: 'chunk'; data: SafeText }
	| { type: 'end'; data: SafeText }
	| { type: 'error'; data: SafeText }

type Listener = (event: DeployEvent) => void

const subscribers = new Map<string, Set<Listener>>()

export function subscribe(deployId: string, listener: Listener): () => void {
	let set = subscribers.get(deployId)
	if (!set) {
		set = new Set()
		subscribers.set(deployId, set)
	}
	set.add(listener)
	return () => {
		const s = subscribers.get(deployId)
		if (!s) return
		s.delete(listener)
		if (s.size === 0) subscribers.delete(deployId)
	}
}

function publish(deployId: string, event: DeployEvent): void {
	const set = subscribers.get(deployId)
	if (!set) return
	for (const listener of set) {
		try {
			listener(event)
		} catch {
			// ignore listener errors
		}
	}
}

/** A masked, line-buffered chunk stream for one deploy. `chunk(raw)` publishes
 *  the masked complete lines and returns them; `flush()` publishes the rest. */
export function chunkPublisher(deployId: string): {
	chunk: (raw: string) => SafeText
	flush: () => SafeText
} {
	const r = new SecretStreamRedactor()
	const emit = (safe: SafeText) => {
		if (safe) publish(deployId, { type: 'chunk', data: safe })
		return safe
	}
	return { chunk: (raw) => emit(r.push(raw)), flush: () => emit(r.flush()) }
}

/** Publish a terminal event; the text is masked here. */
export function publishTerminal(deployId: string, type: 'end' | 'error', text: string): void {
	publish(deployId, { type, data: redactSecrets(text) })
}
