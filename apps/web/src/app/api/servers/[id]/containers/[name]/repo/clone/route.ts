import { requireContainerAccess } from '@/lib/access'
import { decryptDeployKey, getRepoFor } from '@/lib/repos'
import { redactSecrets } from '@/lib/secret-text'
import { gitCloneRepo, inspectContainer } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name, { allowUnmanaged: true })
	if (access instanceof Response) return access
	const { server } = access

	const repo = await getRepoFor(id, name)
	if (!repo) return Response.json({ error: 'repo not connected' }, { status: 400 })

	const detail = await inspectContainer(server, name)
	if (!detail.compose.workingDir) {
		return Response.json(
			{ error: 'container has no compose working dir' },
			{ status: 400 },
		)
	}

	// the deploy key was already planted at <workingDir>/.deploy-key during connect
	const keyPath = `${detail.compose.workingDir}/.deploy-key`

	// re-plant in case it got nuked, decrypting from db
	const priv = decryptDeployKey(repo)
	const { writeFileSecret } = await import('@/lib/ssh')
	await writeFileSecret(server, keyPath, priv)

	try {
		const { output } = await gitCloneRepo(
			server,
			detail.compose.workingDir,
			repo.repoUrl,
			repo.branch,
			keyPath,
		)
		// re-plant the key into the new (cloned) dir since the dir was replaced
		await writeFileSecret(server, keyPath, priv)
		// git output and errors can carry secrets (a token in a remote URL)
		return Response.json({ ok: true, output: redactSecrets(output) })
	} catch (err) {
		return Response.json(
			{ error: redactSecrets(clientErrorMessage(err, 'clone failed', 'servers/:id/containers/:name/repo/clone')) },
			{ status: 500 },
		)
	}
}
