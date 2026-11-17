// Item values for the command palette (components/command-palette.tsx). One id
// per item, so values never collide, and the first result is known up front:
// the palette selects it whenever the results change, so Enter opens it.

export interface PaletteResults {
	projects: { id: string }[]
	deploys: { id: string }[]
	actions: { id: string }[]
}

export const paletteValue = {
	project: (id: string) => `project:${id}`,
	deploy: (id: string) => `deploy:${id}`,
	action: (id: string) => `action:${id}`,
}

/** The value of the first item in display order (apps, deploys, actions), or ''. */
export function firstPaletteValue(r: PaletteResults): string {
	const p = r.projects[0]
	if (p) return paletteValue.project(p.id)
	const d = r.deploys[0]
	if (d) return paletteValue.deploy(d.id)
	const a = r.actions[0]
	return a ? paletteValue.action(a.id) : ''
}

/** Results tagged with the query they answer. */
export interface PaletteAnswer<T> {
	q: string
	data: T
}

/** True when the results on screen answer the query in the search field, so Enter may open
 *  the selected item. While a newer query is debouncing or in flight, Enter waits
 *  for its answer instead of opening an item of the previous list. Pure. */
export function paletteAnswersQuery(query: string, answer: PaletteAnswer<unknown> | null): boolean {
	return answer !== null && answer.q === query
}

/** Enter pressed while the list on screen answers an older query: remembers the
 *  query it was pressed for, so the answer to that query opens its first item.
 *  Editing the query, or that query's search failing, forgets it: only an answer
 *  to the same query, with no edit or failure in between, opens an item. */
export function createEnterPending() {
	let pendingFor: string | null = null
	return {
		press(query: string) {
			pendingFor = query
		},
		/** The query in the search field changed. */
		queryChanged(query: string) {
			if (pendingFor !== query) pendingFor = null
		},
		/** The search for this query failed (or was aborted); a dropped answer to an
		 *  older query leaves an Enter for the newer one alone. */
		failed(query: string) {
			if (pendingFor === query) pendingFor = null
		},
		clear() {
			pendingFor = null
		},
		/** True once, when this answer is for the query Enter was pressed for and the
		 *  search field still shows it. */
		take(query: string, answer: PaletteAnswer<unknown> | null): boolean {
			if (pendingFor === null || pendingFor !== query || !paletteAnswersQuery(query, answer)) return false
			pendingFor = null
			return true
		},
	}
}

/** One search at a time: each run aborts the one before it, and an answer that
 *  lands after a newer run started (or after cancel) is dropped, so a slow
 *  response can never overwrite a newer one. run resolves null when dropped or
 *  failed. */
export function createPaletteSearch<T>(fetchResults: (q: string, signal: AbortSignal) => Promise<T>) {
	let seq = 0
	let ctrl: AbortController | null = null
	return {
		async run(q: string): Promise<PaletteAnswer<T> | null> {
			ctrl?.abort()
			const mine = new AbortController()
			ctrl = mine
			const n = ++seq
			try {
				const data = await fetchResults(q, mine.signal)
				return n === seq ? { q, data } : null
			} catch {
				return null
			}
		},
		cancel() {
			seq++
			ctrl?.abort()
			ctrl = null
		},
	}
}
