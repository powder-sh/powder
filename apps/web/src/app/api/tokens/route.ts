import { createHash, randomBytes } from 'node:crypto'
import { requireUser } from '@/lib/access'
import { and, createId, db, eq, isNull, prefixes, userApiTokens } from '@/lib/db'
import { BodyTooLargeError, bodyTooLargeResponse, readJsonCapped } from '@/lib/http-limits'
import { isValidScope, scopesWithinCaller } from '@/lib/token-scopes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const rows = await db
		.select({
			id: userApiTokens.id,
			name: userApiTokens.name,
			prefix: userApiTokens.prefix,
			createdAt: userApiTokens.createdAt,
			lastUsedAt: userApiTokens.lastUsedAt,
			revokedAt: userApiTokens.revokedAt,
			scopes: userApiTokens.scopes,
			expiresAt: userApiTokens.expiresAt,
		})
		.from(userApiTokens)
		.where(eq(userApiTokens.userId, userOrResp.id))
	return Response.json({ tokens: rows.filter((r) => !r.revokedAt) })
}

export async function POST(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	// A scoped bearer token must not mint tokens (session or
	// full-access token only), and never broader than itself.
	if (userOrResp.viaToken && userOrResp.tokenScopes !== null) {
		return Response.json({ error: 'scoped tokens cannot create tokens' }, { status: 403 })
	}
	const body = (await readJsonCapped(req).catch((e) =>
		e instanceof BodyTooLargeError ? e : {},
	)) as {
		name?: string
		// Explicit "METHOD /path" scopes, or omit for a full-access (admin) token.
		scopes?: string[]
		expiresInDays?: number
	}
	if (body instanceof BodyTooLargeError) return bodyTooLargeResponse()
	const name = (body.name ?? 'untitled').trim().slice(0, 60)

	let scopes: string[] | null = null
	if (body.scopes !== undefined) {
		if (!Array.isArray(body.scopes) || !body.scopes.every((s) => typeof s === 'string' && isValidScope(s))) {
			return Response.json({ error: 'scopes must be "METHOD /path/pattern" strings' }, { status: 400 })
		}
		scopes = body.scopes
	}
	if (userOrResp.viaToken && !scopesWithinCaller(scopes, userOrResp.tokenScopes ?? null)) {
		return Response.json({ error: 'scopes exceed the calling token' }, { status: 403 })
	}
	let expiresAt: Date | null = null
	if (body.expiresInDays !== undefined) {
		const d = Number(body.expiresInDays)
		if (!Number.isFinite(d) || d <= 0 || d > 3650) {
			return Response.json({ error: 'expiresInDays must be 1..3650' }, { status: 400 })
		}
		expiresAt = new Date(Date.now() + d * 86_400_000)
	}

	// Token format: pwd_<24 random bytes hex> (8-char user-visible prefix)
	const raw = randomBytes(24).toString('hex')
	const fullToken = `pwd_${raw}`
	const prefix = `pwd_${raw.slice(0, 4)}`
	const id = createId(prefixes.userApiToken)

	await db.insert(userApiTokens).values({
		id,
		userId: userOrResp.id,
		name,
		prefix,
		hash: hashToken(fullToken),
		scopes,
		expiresAt,
	})

	// Return token ONCE — never persist plaintext.
	return Response.json({
		id,
		name,
		prefix,
		token: fullToken,
		scopes,
		expiresAt,
		warning:
			'Store this token now — it is shown only once. Use as `Authorization: Bearer <token>`.',
	})
}

// Revoke one of the caller's own tokens. Session or full-access
// token only; a scoped token cannot revoke.
export async function DELETE(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	if (userOrResp.viaToken && userOrResp.tokenScopes !== null) {
		return Response.json({ error: 'scoped tokens cannot revoke tokens' }, { status: 403 })
	}
	const id = new URL(req.url).searchParams.get('id')
	if (!id) return Response.json({ error: 'id required' }, { status: 400 })
	const revoked = await db
		.update(userApiTokens)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(userApiTokens.id, id),
				eq(userApiTokens.userId, userOrResp.id),
				isNull(userApiTokens.revokedAt),
			),
		)
		.returning({ id: userApiTokens.id })
	if (revoked.length === 0) return Response.json({ error: 'unknown token' }, { status: 404 })
	return Response.json({ ok: true })
}
