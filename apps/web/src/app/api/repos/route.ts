import { requireUser, visibleRepos } from '@/lib/access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const rows = await visibleRepos(userOrResp, 'admin-session')
	return Response.json({
		repos: rows.map((r) => ({
			id: r.id,
			serverId: r.serverId,
			containerName: r.containerName,
			repoUrl: r.repoUrl,
			branch: r.branch,
			createdAt: r.createdAt,
		})),
	})
}
