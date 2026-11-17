// DELETE /api/admin/users/<id> - remove a user: their sessions, accounts (the
// credential password and any GitHub link), API tokens and stored integration
// tokens, then the user row. Admin browser session only (SESSION_ONLY in
// lib/session-only.ts; the proxy refuses a bearer token and checks CSRF).
// Refused: an admin id (POWDER_ADMIN_USER_IDS or the first-run admin) and the
// caller's own id. History rows (deploys, audit) keep the id as text.

import { requireUser } from '@/lib/access'
import { isAdminUserId } from '@/lib/admin-ids'
import { account, db, eq, session, userApiTokens, userIntegrations, user as userTable } from '@/lib/db'
import { RECREATE_HINT } from '@/lib/recreate-hint'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const u = await requireUser()
	if (u instanceof Response) return u
	if (!u.isAdmin || u.viaToken === true) {
		return Response.json({ error: 'removing a user needs an admin browser session' }, { status: 403 })
	}
	const { id } = await ctx.params
	if (id === u.id) return Response.json({ error: 'you cannot remove yourself' }, { status: 400 })
	if (isAdminUserId(id)) {
		return Response.json(
			{ error: `this user is an admin: take the id out of POWDER_ADMIN_USER_IDS in powder.env first, then ${RECREATE_HINT}` },
			{ status: 400 },
		)
	}

	const removed = await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ id: userTable.id, email: userTable.email })
			.from(userTable)
			.where(eq(userTable.id, id))
			.for('update')
		if (!row) return null
		await tx.delete(session).where(eq(session.userId, id))
		await tx.delete(account).where(eq(account.userId, id))
		await tx.delete(userApiTokens).where(eq(userApiTokens.userId, id))
		await tx.delete(userIntegrations).where(eq(userIntegrations.userId, id))
		await tx.delete(userTable).where(eq(userTable.id, id))
		return row
	})
	if (!removed) return Response.json({ error: 'user not found' }, { status: 404 })

	console.log(`[admin] removed user ${removed.email} (${removed.id}) - caller=${u.email} (${u.id})`)
	return Response.json({ ok: true, removed: { id: removed.id, email: removed.email } })
}
