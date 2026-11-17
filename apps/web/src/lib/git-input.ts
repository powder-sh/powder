// One authority for the repo URL and branch values powder stores and later
// interpolates into git commands (createRepo, repo groups, gitCloneRepo, the
// repo connect route). Pure, no imports.

/** Branch / ref names we accept. No leading '-' (git option injection), no '..'. */
export const GIT_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/

/** Repo URL charset. No leading '-' (git would read it as an option); no '%',
 *  so credentials cannot hide behind percent-encoding. */
const SAFE_REPO_URL = /^(?!-)[A-Za-z0-9._@:/-]+$/

export const REPO_URL_CREDENTIALS_ERROR =
	'repo URL must not contain credentials (user:token@...). Connect with the deploy key powder generates instead.'

/** Why a repo URL is refused, or null when it is fine. A token in the URL would
 *  be stored in plaintext and echoed by git errors, so userinfo is refused on
 *  http(s) URLs entirely and a password is refused on every other form (the
 *  `git@` user of ssh and scp-style URLs stays allowed). */
export function repoUrlProblem(url: string): string | null {
	if (!SAFE_REPO_URL.test(url)) return 'unsafe repo url'
	const scheme = url.match(/^([a-z][a-z0-9+.-]*):\/\//i)
	if (scheme) {
		let u: URL
		try {
			u = new URL(url)
		} catch {
			return 'unsafe repo url'
		}
		const http = /^https?$/i.test(scheme[1] ?? '')
		if (u.password || (http && u.username)) return REPO_URL_CREDENTIALS_ERROR
		return null
	}
	// scp-like: [user@]host:path. A ':' before the '@' is a password.
	const at = url.indexOf('@')
	if (at !== -1 && url.slice(0, at).includes(':')) return REPO_URL_CREDENTIALS_ERROR
	return null
}

/** Why a branch is refused, or null. */
export function branchProblem(branch: string): string | null {
	return GIT_REF_RE.test(branch) ? null : 'unsafe branch name'
}
