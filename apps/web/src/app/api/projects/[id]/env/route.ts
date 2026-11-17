// DB-backed env vars for a project. List + set/upsert via JSON body.
// Plaintext values are never returned — only keys, scopes, and short previews.
// Delete is a separate endpoint at /env/[key].

import { requireProjectAccess } from '@/lib/access'
import { EnvKeyDeniedError, deniedNote } from '@/lib/env-key-policy'
import { UNKNOWN_SCOPE_ERROR, parseEnvScope } from '@/lib/env-scope'
import {
	bulkImportFromText,
	envWriteCtx,
	listForProject,
	setForProject,
} from '@/lib/env-vars-db'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// requireProjectAccess (user, row, never powder's own container) for every method
async function loadProject(id: string) {
	const a = await requireProjectAccess(id)
	if (a instanceof Response) return { error: a }
	return { repo: a.repo, user: a.user }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	const r = await loadProject(id)
	if ('error' in r) return r.error

	const vars = await listForProject(id)
	return Response.json({ vars })
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	const r = await loadProject(id)
	if ('error' in r) return r.error
	const user = r.user

	let body: { key?: string; value?: string; scope?: string }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return Response.json({ error: 'invalid body' }, { status: 400 })
	}
	// `null`, an array or a scalar parses as JSON but is no body
	if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'invalid body' }, { status: 400 })
	if (!body.key || typeof body.key !== 'string') {
		return Response.json({ error: 'key required' }, { status: 400 })
	}
	if (typeof body.value !== 'string') {
		return Response.json({ error: 'value required (string)' }, { status: 400 })
	}
	// production only when scope is absent; an unknown one is a 400
	const scope = parseEnvScope(body.scope)
	if (!scope) return Response.json({ error: UNKNOWN_SCOPE_ERROR }, { status: 400 })

	try {
		const saved = await setForProject(id, body.key, body.value, scope, envWriteCtx(req, user))
		return Response.json({ ok: true, var: saved })
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'set failed', 'projects/:id/env') },
			{ status: err instanceof EnvKeyDeniedError ? 403 : 400 },
		)
	}
}

// Bulk paste-from-.env affordance. Body: { text: "KEY=val\nKEY2=val2", scope }.
// Returns counts so the UI can show "imported 18, skipped 2, existing 3 (overwritten)".
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	const r = await loadProject(id)
	if ('error' in r) return r.error
	const user = r.user

	let body: { text?: string; scope?: string; overwrite?: boolean }
	try {
		body = (await req.json()) as typeof body
	} catch {
		return Response.json({ error: 'invalid body' }, { status: 400 })
	}
	// `null`, an array or a scalar parses as JSON but is no body
	if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'invalid body' }, { status: 400 })
	if (typeof body.text !== 'string') {
		return Response.json({ error: 'text required' }, { status: 400 })
	}
	// production only when scope is absent; an unknown one is a 400
	const scope = parseEnvScope(body.scope)
	if (!scope) return Response.json({ error: UNKNOWN_SCOPE_ERROR }, { status: 400 })

	const result = await bulkImportFromText(id, body.text, scope, envWriteCtx(req, user), {
		overwrite: body.overwrite !== false,
	})
	return Response.json({ ok: true, ...result, ...deniedNote(result.deniedKeys) })
}
