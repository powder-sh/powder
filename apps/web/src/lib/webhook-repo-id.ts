// a push webhook must keep naming the GitHub repository the app
// was connected to. app_repos.github_repo_id holds GitHub's numeric
// repository.id (stored at connect, or from the first verified push for rows
// connected before 0055). A SIGNED push whose repository.id differs is refused:
// the hook now fires for another repository (transferred, or the secret reused).
// A full_name that no longer matches the stored repo URL with the SAME id is a
// rename: GitHub redirects the old name, so that only WARNs.
// deployment groups (repo_deployment_groups.github_repo_id, 0056)
// go through the same decision.
import type { AppRepo } from './db'
import { parseGithubRepoUrl } from './github'

export type RepoIdDecision =
	| { action: 'ok'; warn?: string }
	| { action: 'store'; id: number; warn?: string }
	| { action: 'refuse'; message: string }

export function repoIdDecision(
	repo: Pick<AppRepo, 'githubRepoId' | 'repoUrl'>,
	payloadRepository: unknown,
): RepoIdDecision {
	const r = payloadRepository as { id?: unknown; full_name?: unknown } | null | undefined
	const id = typeof r?.id === 'number' && Number.isSafeInteger(r.id) && r.id > 0 ? r.id : null
	// No repository in the body (a hand-made call with the secret): nothing to compare.
	if (id === null) return { action: 'ok' }
	const parsed = parseGithubRepoUrl(repo.repoUrl)
	const fullName = typeof r?.full_name === 'string' ? r.full_name : null
	const warn =
		parsed && fullName && fullName.toLowerCase() !== `${parsed.owner}/${parsed.repo}`.toLowerCase()
			? `push comes from ${fullName} but the app is connected to ${parsed.owner}/${parsed.repo} (repo renamed or transferred?); update the repo URL`
			: undefined
	const stored = repo.githubRepoId
	if (stored == null) return { action: 'store', id, ...(warn ? { warn } : {}) }
	if (stored !== id)
		return {
			action: 'refuse',
			message: `refusing the push: it names GitHub repository id ${id}${fullName ? ` (${fullName})` : ''}, but this app is connected to repository id ${stored}. The repo was transferred or replaced, or the webhook secret is used on another repo. Reconnect the repo in powder if this is intended.`,
		}
	return { action: 'ok', ...(warn ? { warn } : {}) }
}
