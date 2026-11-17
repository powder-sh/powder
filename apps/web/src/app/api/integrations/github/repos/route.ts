import { singleTenantBlocks } from '@/lib/access'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { listRepos } from '@/lib/github'
import { getGithubIntegration } from '@/lib/integrations'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
	const session = await auth.api.getSession({ headers: await headers() })
	if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 })
	const blocked = singleTenantBlocks(session.user.id)
	if (blocked) return blocked
	const i = await getGithubIntegration(session.user.id)
	if (!i) return Response.json({ error: 'github not connected' }, { status: 400 })
	try {
		const repos = await listRepos(i.token)
		// trim down to what the client needs
		return Response.json({
			repos: repos.map((r) => ({
				id: r.id,
				fullName: r.full_name,
				name: r.name,
				ownerLogin: r.owner.login,
				ownerAvatar: r.owner.avatar_url,
				private: r.private,
				defaultBranch: r.default_branch,
				sshUrl: r.ssh_url,
				updatedAt: r.updated_at,
			})),
		})
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'failed', 'integrations/github/repos') },
			{ status: 502 },
		)
	}
}
