// AI-powered diagnosis of a specific workflow run. Pattern matcher already
// ran in /api/projects/[id]/ci; this endpoint is only invoked when the user
// clicks "diagnose with AI" on a failure the matcher didn't recognize, or
// wants a deeper take.

import { requireProjectAccess } from '@/lib/access'
import { diagnoseFailureWithLlm, translateFailure } from '@/lib/ci-translate'
import { getRunFailureTail, parseGitHubRepo } from '@/lib/github-ci'
import { getAdminGithubIntegration } from '@/lib/integrations'
import { redactSecrets } from '@/lib/secret-text'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; runId: string }> }) {
	const { id, runId } = await ctx.params
	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const { repo, user } = access
	const runIdNum = Number(runId)
	if (!Number.isFinite(runIdNum) || runIdNum <= 0) {
		return Response.json({ error: 'invalid run id' }, { status: 400 })
	}

	const parsed = parseGitHubRepo(repo.repoUrl)
	if (!parsed) return Response.json({ error: 'non-github repo' }, { status: 400 })
	// only a CURRENT admin's token, the owner's first when the
	// owner is one; a removed or non-admin owner's stored token is never used.
	const tokenSource = await getAdminGithubIntegration(repo.ownerUserId ?? user.id)
	if (!tokenSource) return Response.json({ error: 'no github token' }, { status: 400 })

	const log = await getRunFailureTail(tokenSource.token, parsed.owner, parsed.repo, runIdNum, 8000)
	// Always run the pattern matcher too — if it has a clean hit, no need to
	// pay for the LLM call.
	const patternHit = translateFailure(log)
	if (patternHit.source === 'pattern') {
		// the raw GitHub Actions log can print secrets: masked like every log reader.
		return Response.json({ diagnosis: patternHit, logTail: redactSecrets(log) })
	}

	const llm = await diagnoseFailureWithLlm(log, {
		repoSlug: `${parsed.owner}/${parsed.repo}`,
	})
	return Response.json({ diagnosis: llm, logTail: redactSecrets(log) })
}
