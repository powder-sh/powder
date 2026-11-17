// Reads package.json + lockfiles + checks for Dockerfile in a github repo,
// returns: detected framework, package manager, default container port,
// whether a Dockerfile already exists.

import { requireUser } from '@/lib/access'
import { detectFromPackageJson, detectPackageManager } from '@/lib/framework-detect'
import { getRepoFile, repoHasDockerfile } from '@/lib/github'
import { getGithubIntegration } from '@/lib/integrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
	req: Request,
	ctx: { params: Promise<{ owner: string; repo: string }> },
) {
	const { owner, repo } = await ctx.params
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp

	const gh = await getGithubIntegration(userOrResp.id)
	if (!gh) return Response.json({ error: 'github not connected' }, { status: 400 })

	const url = new URL(req.url)
	const ref = url.searchParams.get('ref') ?? undefined

	const lockfileNames = ['bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'] as const
	const [pkgText, hasDockerfile, ...lockResults] = await Promise.all([
		getRepoFile(gh.token, owner, repo, 'package.json', ref).catch(() => null),
		repoHasDockerfile(gh.token, owner, repo, 'Dockerfile', ref).catch(() => false),
		...lockfileNames.map((n) =>
			repoHasDockerfile(gh.token, owner, repo, n, ref).catch(() => false),
		),
	])

	const framework = pkgText
		? detectFromPackageJson(pkgText)
		: { id: 'unknown', displayName: 'unknown', defaultContainerPort: 3000 }

	const lockfiles: Record<string, boolean> = {}
	lockfileNames.forEach((n, i) => {
		lockfiles[n] = lockResults[i] === true
	})
	const packageManager = detectPackageManager(lockfiles)

	return Response.json({
		framework,
		packageManager,
		hasDockerfile,
		defaultDockerfilePath: './Dockerfile',
	})
}
