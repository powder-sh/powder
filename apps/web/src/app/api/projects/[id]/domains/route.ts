// Per-project custom-domain endpoints (TXT-challenge path).
//
// GET:    list app_domains rows for the project (with TXT challenge inline so
//          the UI can show "add `_powder-verify.<host>` TXT = <challenge>")
// POST:   { hostname }: addDomain() (insert pending row + challenge)
// DELETE: { hostname }: remove the row. Does NOT scrub live Traefik labels:
//          a row that was 'live' keeps its host in the compose labels until
//          the next applyDomainsToCompose run rewrites them.
//
// All gated by requireProjectAccess. POST and DELETE are session-only
// (lib/session-only.ts): no API token adds or removes a domain.

import { requireProjectAccess } from '@/lib/access'
import { HostnameTakenError, addDomain, listDomainsForRepo } from '@/lib/app-domains'
import { NO_BASE_DOMAIN_MESSAGE, defaultHostFor } from '@/lib/app-hosts'
import { and, appDomains, db, eq } from '@/lib/db'
import { getServer } from '@/lib/servers'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// requireProjectAccess (user, row, never powder's own container)
async function loadOwnedRepo(id: string, selfRead = false) {
	const a = await requireProjectAccess(id, { selfRead })
	if (a instanceof Response) return { resp: a }
	return { repo: a.repo }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const access = await loadOwnedRepo(id, true)
	if ('resp' in access) return access.resp
	const { repo } = access

	const domains = await listDomainsForRepo(repo.id)
	const server = await getServer(repo.serverId)
	const autoAssigned = server ? defaultHostFor(server, repo.containerName) : null
	return Response.json({
		autoAssigned,
		// The A record target the domains tab shows for an apex or a server without a base domain.
		ingressIp: server?.ingressIp ?? null,
		...(autoAssigned ? {} : { note: NO_BASE_DOMAIN_MESSAGE }),
		domains,
	})
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const access = await loadOwnedRepo(id)
	if ('resp' in access) return access.resp
	const { repo } = access

	const body = (await req.json().catch(() => ({}))) as { hostname?: string }
	const hostname = (body.hostname ?? '').trim().toLowerCase()
	if (!hostname) {
		return Response.json({ error: 'hostname required' }, { status: 400 })
	}

	try {
		const row = await addDomain({ repoId: repo.id, hostname })
		return Response.json({ domain: row })
	} catch (err) {
		const msg = clientErrorMessage(err, 'failed to add domain', 'projects/:id/domains')
		return Response.json({ error: msg }, { status: err instanceof HostnameTakenError ? 409 : 400 })
	}
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const access = await loadOwnedRepo(id)
	if ('resp' in access) return access.resp
	const { repo } = access

	// hostname comes either in the body or as ?hostname=
	const url = new URL(req.url)
	let hostname = url.searchParams.get('hostname')?.toLowerCase() ?? ''
	if (!hostname) {
		const body = (await req.json().catch(() => ({}))) as { hostname?: string }
		hostname = (body.hostname ?? '').trim().toLowerCase()
	}
	if (!hostname) {
		return Response.json({ error: 'hostname required' }, { status: 400 })
	}

	await db
		.delete(appDomains)
		.where(and(eq(appDomains.appRepoId, repo.id), eq(appDomains.hostname, hostname)))
	return Response.json({ ok: true })
}
