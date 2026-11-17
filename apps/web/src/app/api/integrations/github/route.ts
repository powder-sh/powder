import { singleTenantBlocks } from '@/lib/access'
import { headers } from 'next/headers'
import { BodyTooLargeError, bodyTooLargeResponse, readJsonCapped } from '@/lib/http-limits'
import { auth, githubOAuthConfigured } from '@/lib/auth'
import {
	deleteGithubIntegration,
	getGithubIntegrationDisplay,
	setGithubPat,
} from '@/lib/integrations'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function currentUser() {
	const session = await auth.api.getSession({ headers: await headers() })
	return session?.user ?? null
}

export async function GET() {
	const user = await currentUser()
	if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
	const blocked = singleTenantBlocks(user.id)
	if (blocked) return blocked
	const status = await getGithubIntegrationDisplay(user.id)
	return Response.json({ ...status, oauthAvailable: githubOAuthConfigured })
}

export async function POST(req: Request) {
	const user = await currentUser()
	if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
	const blocked = singleTenantBlocks(user.id)
	if (blocked) return blocked
	let body: { token?: string }
	try {
		body = await readJsonCapped<{ token?: string }>(req)
	} catch (e) {
		if (e instanceof BodyTooLargeError) return bodyTooLargeResponse()
		return Response.json({ error: 'invalid json' }, { status: 400 })
	}
	if (!body.token) return Response.json({ error: 'token required' }, { status: 400 })
	try {
		const row = await setGithubPat(user.id, body.token)
		return Response.json({
			connected: true,
			username: row.username,
			scopes: row.scopes ? row.scopes.split(',') : [],
			source: 'pat',
		})
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'failed', 'integrations/github') },
			{ status: 400 },
		)
	}
}

export async function DELETE() {
	const user = await currentUser()
	if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
	const blocked = singleTenantBlocks(user.id)
	if (blocked) return blocked
	await deleteGithubIntegration(user.id)
	return Response.json({ ok: true })
}
