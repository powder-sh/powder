// CI status for a single project. Looks up the repo via app_repos, asks
// GitHub for the most recent workflow runs on the project's branch, runs the
// pattern matcher on the most recent FAILED run's log, returns everything the
// /projects/[id]/ci tab needs to render.

import { requireProjectAccess } from '@/lib/access'
import { translateFailure } from '@/lib/ci-translate'
import { getRunFailureTail, listRunsForRepo, parseGitHubRepo } from '@/lib/github-ci'
import { getAdminGithubIntegration } from '@/lib/integrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id, { selfRead: true })
	if (access instanceof Response) return access
	const { repo, user } = access

	const parsed = parseGitHubRepo(repo.repoUrl)
	if (!parsed) {
		return Response.json({
			connected: false,
			reason: 'not_github',
			runs: [],
		})
	}

	// Only a CURRENT admin's token, the owner's first when the owner is one (same
	// as the diagnose route); a removed or non-admin owner's stored token is never used.
	const tokenSource = await getAdminGithubIntegration(repo.ownerUserId ?? user.id)
	if (!tokenSource) {
		return Response.json({
			connected: false,
			reason: 'no_token',
			runs: [],
		})
	}

	const runs = await listRunsForRepo(tokenSource.token, parsed.owner, parsed.repo, {
		branch: repo.branch,
		perPage: 10,
	})

	// Translate the latest failing run synchronously — cheap pattern match, no
	// LLM. The "diagnose with AI" button hits the separate diagnose endpoint.
	const latestFailed = runs.find((r) => r.status === 'completed' && r.conclusion === 'failure')
	let latestFailureDiagnosis = null
	if (latestFailed) {
		const log = await getRunFailureTail(
			tokenSource.token,
			parsed.owner,
			parsed.repo,
			latestFailed.id,
			6000,
		)
		latestFailureDiagnosis = translateFailure(log)
	}

	return Response.json({
		connected: true,
		owner: parsed.owner,
		repo: parsed.repo,
		branch: repo.branch,
		runs: runs.map((r) => ({
			id: r.id,
			name: r.name,
			displayTitle: r.display_title,
			status: r.status,
			conclusion: r.conclusion,
			htmlUrl: r.html_url,
			headSha: r.head_sha,
			headBranch: r.head_branch,
			runNumber: r.run_number,
			event: r.event,
			createdAt: r.created_at,
			runStartedAt: r.run_started_at,
			updatedAt: r.updated_at,
		})),
		latestFailedRunId: latestFailed?.id ?? null,
		latestFailureDiagnosis,
	})
}
