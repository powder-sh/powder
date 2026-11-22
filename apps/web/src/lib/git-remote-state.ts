// The container page's "is the remote ahead" answer, from the git-status route.
// Three states, never conflated: a remote that could not be checked is not "up
// to date".

export type RemoteState =
	| { kind: 'ahead' }
	| { kind: 'current' }
	| { kind: 'unchecked'; reason: string }

/** Pure. `upstreamError` set, or no remote commit to compare: unchecked. */
export function remoteState(s: {
	currentSha?: string | null
	upstreamSha?: string | null
	upstreamError?: string | null
}): RemoteState {
	if (s.upstreamError) return { kind: 'unchecked', reason: s.upstreamError }
	if (!s.upstreamSha || !s.currentSha) return { kind: 'unchecked', reason: 'no remote commit to compare with' }
	return s.upstreamSha === s.currentSha ? { kind: 'current' } : { kind: 'ahead' }
}
