// Generates a Dockerfile for the detected framework + package manager and
// commits it to the user's repo (on the configured branch). One-click no-
// Dockerfile recovery from the wizard.

import { requireUser } from '@/lib/access'
import {
	detectFromPackageJson,
	detectPackageManager,
	dockerfileFor,
} from '@/lib/framework-detect'
import { commitFile, getRepoFile, repoHasDockerfile } from '@/lib/github'
import { getGithubIntegration } from '@/lib/integrations'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
	req: Request,
	ctx: { params: Promise<{ owner: string; repo: string }> },
) {
	const { owner, repo } = await ctx.params
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp

	const gh = await getGithubIntegration(userOrResp.id)
	if (!gh) return Response.json({ error: 'github not connected' }, { status: 400 })

	const body = (await req.json()) as { branch?: string }
	const branch = (body.branch ?? 'main').trim()
	if (!branch) return Response.json({ error: 'branch required' }, { status: 400 })

	// Re-detect server-side so we don't trust client-provided framework.
	const lockfileNames = ['bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'] as const
	const [pkgText, hasDockerfile, ...lockResults] = await Promise.all([
		getRepoFile(gh.token, owner, repo, 'package.json', branch).catch(() => null),
		repoHasDockerfile(gh.token, owner, repo, 'Dockerfile', branch).catch(() => false),
		...lockfileNames.map((n) =>
			repoHasDockerfile(gh.token, owner, repo, n, branch).catch(() => false),
		),
	])

	if (hasDockerfile) {
		return Response.json({ ok: true, alreadyExists: true })
	}
	if (!pkgText) {
		return Response.json(
			{ error: "no package.json — can't auto-generate a Dockerfile yet" },
			{ status: 400 },
		)
	}

	const framework = detectFromPackageJson(pkgText)
	if (framework.id === 'unknown') {
		return Response.json(
			{ error: 'could not detect framework — add a Dockerfile by hand' },
			{ status: 400 },
		)
	}

	const lockfiles: Record<string, boolean> = {}
	lockfileNames.forEach((n, i) => {
		lockfiles[n] = lockResults[i] === true
	})
	const pm = detectPackageManager(lockfiles)

	const content = dockerfileFor(framework, pm, repo)
	try {
		const result = await commitFile(
			gh.token,
			owner,
			repo,
			'Dockerfile',
			content,
			`chore: add Dockerfile (powder-generated for ${framework.displayName})`,
			branch,
		)
		return Response.json({
			ok: true,
			framework: framework.displayName,
			packageManager: pm,
			commitSha: result.commitSha,
		})
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'commit failed', 'integrations/github/repos/:owner/:repo/dockerfile') },
			{ status: 502 },
		)
	}
}
