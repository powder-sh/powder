// "send test" for one notification target. POST ?id=<target id>.

import { requireUser } from '@/lib/access'
import { db, eq, notificationTargets } from '@/lib/db'
import { sendTestNotification } from '@/lib/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Same as the webhook send timeout in lib/notifications.ts. */
const TEST_FAILURE_MIN_MS = 5000

export async function POST(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const id = new URL(req.url).searchParams.get('id')
	if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
	const [target] = await db
		.select()
		.from(notificationTargets)
		.where(eq(notificationTargets.id, id))
		.limit(1)
	if (!target) return Response.json({ error: 'not found' }, { status: 404 })
	const started = Date.now()
	const ok = await sendTestNotification(target)
	if (!ok) {
		// One generic answer for every failure (refused, timeout, blocked, non-2xx),
		// padded to the send timeout so the response time does not tell a closed
		// port from a filtered one either: the test button is not a port scanner.
		const wait = TEST_FAILURE_MIN_MS - (Date.now() - started)
		if (wait > 0) await new Promise((r) => setTimeout(r, wait))
		return Response.json({ ok: false, error: 'send failed, check the powder log' }, { status: 502 })
	}
	return Response.json({ ok: true })
}
