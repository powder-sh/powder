// Which commit to show for a deploy, and how to label it. The one authority for every
// display of a deploy's commit: the /deploys list, the deploy page, the copied error block,
// the "debug this deploy" prompt, the ops-hub deploy event and the activity feed.
//
// Three columns can name it (packages/db/src/schema/deploys.ts):
//   git_sha       the commit this deploy put into production (set after the swap only)
//   built_sha     the commit it synced or built, live or not (0070)
//   requested_sha the commit the push asked for (0035)
// The first one set wins. A requested commit is labelled as such: the deploy may have died
// before it synced anything, or built a newer tip of the branch instead.
//
// Readers that mean "what went live" (rollback targets, the CI tab's deployed commit, the
// last-good lookups) keep reading git_sha on its own. Pure, safe in client components.

export interface DeployCommitFacts {
	gitSha?: string | null
	builtSha?: string | null
	requestedSha?: string | null
}

export interface DeployCommit {
	sha: string
	/** the first 7 characters */
	short: string
	/** true when only the requested commit is known */
	requested: boolean
}

export function deployCommit(d: DeployCommitFacts): DeployCommit | null {
	const built = d.gitSha || d.builtSha || null
	const sha = built ?? (d.requestedSha || null)
	if (!sha) return null
	return { sha, short: sha.slice(0, 7), requested: !built }
}

/** The one written form of a requested commit, after the short sha. */
export const REQUESTED_MARK = '(requested)'

/** "abc1234" or "abc1234 (requested)": the one label form for a deploy's commit. */
export function formatCommitLabel(c: { short: string; requested: boolean }): string {
	return c.requested ? `${c.short} ${REQUESTED_MARK}` : c.short
}

/** formatCommitLabel of the deploy's commit; null when no commit is known. */
export function deployCommitLabel(d: DeployCommitFacts): string | null {
	const c = deployCommit(d)
	return c ? formatCommitLabel(c) : null
}
