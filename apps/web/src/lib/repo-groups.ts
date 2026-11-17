import { appRepos, db, eq, repoDeploymentGroups } from './db'
import type { AppRepo, RepoDeploymentGroup } from './db'
import { decryptSecret } from './crypto'

// Reads for existing repo_deployment_groups rows (one webhook for several
// app_repos rows of the same repo). The deploy webhook looks a token up here
// first; on a hit it fans out to every app_repos row in the group, gated by each
// sub-app's paths_filter. powder has no code path that creates a group.

/** Store GitHub's repository.id on a group (first verified push). Best effort. */
export async function setGroupGithubRepoId(id: string, repoId: number): Promise<void> {
	try {
		await db.update(repoDeploymentGroups).set({ githubRepoId: repoId }).where(eq(repoDeploymentGroups.id, id))
	} catch (err) {
		console.warn('[repo-groups] could not store the GitHub repository id:', err instanceof Error ? err.message : err)
	}
}

export async function getGroupByToken(token: string): Promise<RepoDeploymentGroup | null> {
	const [row] = await db
		.select()
		.from(repoDeploymentGroups)
		.where(eq(repoDeploymentGroups.webhookToken, token))
		.limit(1)
	return row ?? null
}

export async function listSubAppsForGroup(groupId: string): Promise<AppRepo[]> {
	return db.select().from(appRepos).where(eq(appRepos.deploymentGroupId, groupId))
}

export function decryptWebhookSecretForGroup(group: RepoDeploymentGroup): string {
	return decryptSecret(group.webhookSecretEncrypted)
}
