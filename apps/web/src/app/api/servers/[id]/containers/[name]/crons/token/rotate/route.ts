// rotate the app's cron token (POWDER_CRON_TOKEN) and reveal the new one once.
// A token minted through an API token or the scheduler is never shown, so an
// operator has no other way to get it into the app's env. Admin browser session only: the route
// is in SESSION_ONLY (the proxy refuses any bearer token), and it checks the session
// again here. Existing http crons keep working: they read the current token when they
// fire, so they send the new one from now on (the app must get the new value).
import { requireContainerAccess } from '@/lib/access'
import { rotateAppCronToken } from '@/lib/cron-scheduler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { user } = access
	if (user.isAdmin !== true || user.viaToken === true)
		return Response.json(
			{ error: 'rotating the cron token needs an admin browser session; API tokens cannot reach it', code: 'session_only' },
			{ status: 403 },
		)
	const token = await rotateAppCronToken(id, name)
	if (!token) return Response.json({ error: 'unknown app' }, { status: 404 })
	return Response.json({ cronToken: token })
}
