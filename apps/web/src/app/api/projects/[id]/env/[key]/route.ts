// Delete a single env var by key + scope. Scope defaults to production when absent;
// an unknown scope or an invalid key is a 400.

import { requireProjectAccess } from '@/lib/access'
import { EnvKeyDeniedError } from '@/lib/env-key-policy'
import { ENV_KEY_RE } from '@/lib/env-parse'
import { UNKNOWN_SCOPE_ERROR, parseEnvScope } from '@/lib/env-scope'
import { deleteForProject, envWriteCtx } from '@/lib/env-vars-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
	const { id, key } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const { user } = access

	const url = new URL(req.url)
	// a present but unknown scope is refused, not read as production
	const scope = parseEnvScope(url.searchParams.get('scope'))
	if (!scope) return Response.json({ error: UNKNOWN_SCOPE_ERROR }, { status: 400 })
	// Next already decoded the route param; a second decodeURIComponent read
	// `%25xx` as another key (or threw on a bare %). The key must be an env key.
	if (!ENV_KEY_RE.test(key) || key.length > 200) return Response.json({ error: 'invalid env key' }, { status: 400 })

	try {
		const result = await deleteForProject(id, key, scope, envWriteCtx(req, user))
		return Response.json(result)
	} catch (err) {
		// a token may delete only the keys it may write
		if (err instanceof EnvKeyDeniedError) return Response.json({ error: err.message }, { status: 403 })
		throw err
	}
}
