// Monorepo fan-out filter: a sub-app deploys if it has no pathsFilter (always)
// or any changed file is under one of its prefixes. Handles `dir/**`, `dir/`,
// `dir`, and exact paths. Unknown changes (empty list) deploy, to be safe.
// Lives here rather than in the webhook route so it can be unit-tested (a
// Next route module may only export route handlers).
export function pathsMatch(filter: string[] | null | undefined, changed: string[]): boolean {
	if (!filter || filter.length === 0) return true
	if (changed.length === 0) return true // unknown changes → deploy to be safe
	return changed.some((file) =>
		filter.some((raw) => {
			const p = raw.replace(/\/\*\*$/, '').replace(/\/$/, '')
			return file === raw || file === p || file.startsWith(`${p}/`)
		}),
	)
}
