// A push that only changes DEPLOYMENT.md never deploys. powder's own post-deploy sync
// (sync-deployment-md.ts) commits that file into the app's repo; deploying that commit
// rebuilt an unchanged app and queued it again behind every other app on the server (each content deploy was
// followed by a second, empty one).

type PushCommit = { added?: unknown; modified?: unknown; removed?: unknown }

/** Extra caution: a long push is never skipped (push webhooks list up to 2048 commits). */
const GITHUB_PUSH_COMMIT_CAP = 20

/** True only when a plain push (not forced, created or deleted) lists its commits in full, every commit lists
 *  at least one file, and every file is the root DEPLOYMENT.md. A force push lists only the commits past the merge
 *  base, so a rewind under a sync commit would otherwise hide the code change. */
export function onlyDeploymentMdChanged(payload: {
	commits?: unknown
	head_commit?: unknown
	forced?: unknown
	created?: unknown
	deleted?: unknown
}): boolean {
	if (payload.forced === true || payload.created === true || payload.deleted === true) return false
	const commits = payload.commits
	if (!Array.isArray(commits) || commits.length === 0 || commits.length >= GITHUB_PUSH_COMMIT_CAP) return false
	const all: unknown[] = [...commits, ...(payload.head_commit ? [payload.head_commit] : [])]
	for (const c of all) {
		if (!c || typeof c !== 'object') return false
		let files = 0
		for (const key of ['added', 'modified', 'removed'] as const) {
			const list = (c as PushCommit)[key]
			if (list === undefined) continue
			if (!Array.isArray(list)) return false
			for (const f of list) {
				if (f !== 'DEPLOYMENT.md') return false
				files++
			}
		}
		// an empty commit (a "redeploy" commit) or a commit without file lists is a reason to deploy
		if (files === 0) return false
	}
	return true
}
