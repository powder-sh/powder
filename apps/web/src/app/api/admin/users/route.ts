// Admin user management. There is no signup; this lets an admin create a second
// user (e.g. another admin) without SQL surgery. A user only has access once
// their id is in POWDER_ADMIN_USER_IDS.
//
// GET  /api/admin/users        — list user + account-summary rows
// POST /api/admin/users        — create credential user; body { email, name, password? }
//                                 password optional: if absent, server generates 12 random bytes (base64url)
//                                 returns { user, tempPassword } once; never readable again

import { randomBytes } from 'node:crypto'
import { requireUser } from '@/lib/access'
import { isAdminUserId } from '@/lib/admin-ids'
import { account, db, eq, sql, user as userTable } from '@/lib/db'
import { hashPassword } from 'better-auth/crypto'

// Match better-auth's id format (32-char URL-safe random) without pulling
// nanoid as a direct dependency — randomBytes + base64url slice does the same.
function randomId(): string {
	return randomBytes(24).toString('base64url').slice(0, 32)
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
	const u = await requireUser()
	if (u instanceof Response) return u
	if (!u.isAdmin) return Response.json({ error: 'admin only' }, { status: 403 })

	// Join user → account to surface which providers each user has (credential
	// vs github) and whether they've ever logged in (last session createdAt).
	const rows = (await db.execute(sql`
		SELECT
			u.id,
			u.email,
			u.name,
			u.created_at,
			COALESCE(
				(SELECT json_agg(a.provider_id) FROM account a WHERE a.user_id = u.id),
				'[]'::json
			) AS providers,
			(SELECT MAX(s.created_at) FROM session s WHERE s.user_id = u.id) AS last_session_at
		FROM "user" u
		ORDER BY u.created_at DESC
	`)) as unknown as Array<{
		id: string
		email: string
		name: string
		created_at: Date
		providers: string[]
		last_session_at: Date | null
	}>

	return Response.json({
		users: rows.map((r) => ({
			id: r.id,
			email: r.email,
			name: r.name,
			createdAt: new Date(r.created_at).toISOString(),
			providers: r.providers ?? [],
			lastSessionAt: r.last_session_at ? new Date(r.last_session_at).toISOString() : null,
			// In POWDER_ADMIN_USER_IDS (or the first-run admin): can use the dashboard.
			isAdmin: isAdminUserId(r.id),
		})),
	})
}

export async function POST(req: Request) {
	const u = await requireUser()
	if (u instanceof Response) return u
	if (!u.isAdmin) return Response.json({ error: 'admin only' }, { status: 403 })

	const body = (await req.json().catch(() => ({}))) as {
		email?: unknown
		name?: unknown
		password?: unknown
	}
	const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
	const name = typeof body.name === 'string' ? body.name.trim() : ''
	const providedPassword = typeof body.password === 'string' ? body.password : ''

	if (!email || !email.includes('@')) {
		return Response.json({ error: 'valid email required' }, { status: 400 })
	}
	if (!name) {
		return Response.json({ error: 'name required' }, { status: 400 })
	}
	if (providedPassword && providedPassword.length < 8) {
		return Response.json({ error: 'password must be ≥ 8 chars' }, { status: 400 })
	}

	// Check for existing email — better-auth has a unique constraint on it
	// but we want a clean 409 instead of a postgres error.
	const [existing] = await db
		.select({ id: userTable.id })
		.from(userTable)
		.where(eq(userTable.email, email))
		.limit(1)
	if (existing) {
		return Response.json({ error: `user with email ${email} already exists` }, { status: 409 })
	}

	// Generate password if not provided: 12 CSPRNG bytes (96 bits), base64url.
	const tempPassword = providedPassword || randomBytes(12).toString('base64url')

	const passwordHash = await hashPassword(tempPassword)

	const userId = randomId()
	const accountId = randomId()
	const now = new Date()

	await db.transaction(async (tx) => {
		await tx.insert(userTable).values({
			id: userId,
			email,
			name,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		})
		await tx.insert(account).values({
			id: accountId,
			accountId: userId, // for the credential provider, better-auth uses user.id as account_id
			providerId: 'credential',
			userId,
			password: passwordHash,
			createdAt: now,
			updatedAt: now,
		})
	})

	console.log(
		`[admin] created user ${email} (${userId}) — caller=${u.email} (${u.id})`,
	)

	return Response.json({
		user: { id: userId, email, name, createdAt: now.toISOString() },
		tempPassword,
		notice:
			"Password shown once: share it with the user securely. They sign in at /login. There is no page to change it yet: signed in, they can POST /api/auth/change-password with {\"currentPassword\", \"newPassword\"}.",
	})
}
