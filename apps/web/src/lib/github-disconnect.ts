// on disconnect, remove the deploy key and push webhook powder
// installed on GitHub at connect (ids in app_repos, 0055). Best effort: each
// failure is logged and reported, never blocks the disconnect. A row without
// recorded ids touches nothing on GitHub.
import type { AppRepo } from './db'
import { deleteDeployKey, deleteWebhook, parseGithubRepoUrl } from './github'
import { getAdminGithubIntegration, getGithubIntegration } from './integrations'

export type GithubCleanupOutcome = 'deleted' | 'not recorded' | `failed: ${string}`

export async function removeGithubObjects(
	repo: Pick<AppRepo, 'repoUrl' | 'ownerUserId' | 'githubDeployKeyId' | 'githubHookId'>,
	actingUserId: string,
): Promise<{ deployKey: GithubCleanupOutcome; hook: GithubCleanupOutcome }> {
	const out: { deployKey: GithubCleanupOutcome; hook: GithubCleanupOutcome } = {
		deployKey: 'not recorded',
		hook: 'not recorded',
	}
	const keyId = repo.githubDeployKeyId
	const hookId = repo.githubHookId
	if (keyId == null && hookId == null) return out
	const fail = (what: string, err: unknown): GithubCleanupOutcome => {
		const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200)
		console.warn(`[github-disconnect] could not delete the ${what} on ${repo.repoUrl}: ${msg}`)
		return `failed: ${msg}`
	}
	const parsed = parseGithubRepoUrl(repo.repoUrl)
	if (!parsed) {
		const f = fail('GitHub objects', new Error('repo URL is not a github.com repo'))
		return { deployKey: keyId != null ? f : out.deployKey, hook: hookId != null ? f : out.hook }
	}
	let gh: { token: string } | null = null
	try {
		gh =
			(await getGithubIntegration(actingUserId)) ??
			(await getAdminGithubIntegration(repo.ownerUserId))
	} catch (err) {
		gh = null
		fail('GitHub objects (token lookup)', err)
	}
	if (!gh) {
		const f = fail('GitHub objects', new Error('no GitHub token available'))
		return { deployKey: keyId != null ? f : out.deployKey, hook: hookId != null ? f : out.hook }
	}
	if (hookId != null) {
		try {
			await deleteWebhook(gh.token, parsed.owner, parsed.repo, hookId)
			out.hook = 'deleted'
		} catch (err) {
			out.hook = fail(`webhook ${hookId}`, err)
		}
	}
	if (keyId != null) {
		try {
			await deleteDeployKey(gh.token, parsed.owner, parsed.repo, keyId)
			out.deployKey = 'deleted'
		} catch (err) {
			out.deployKey = fail(`deploy key ${keyId}`, err)
		}
	}
	return out
}
