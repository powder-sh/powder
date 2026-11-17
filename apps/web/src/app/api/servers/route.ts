import { requireUser } from '@/lib/access'
import { checkNewServerHost } from '@/lib/server-host-guard'
import { buildServerList } from '@/lib/server-list'
import { DEFAULT_NEW_SERVER_PROXY, isServerProxy } from '@/lib/server-settings'
import { createServer, listAllServers } from '@/lib/servers'
import { getPinnedFingerprint } from '@/lib/ssh-host-keys'
import { isPgError } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET is side-effect free (Lax cookies ride same-site GETs). The writes
// (server status, discovered domains, reconcile rows) only run for
// POST /api/servers/sync, which the proxy CSRF check covers.
export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	return buildServerList(false)
}

// POST registers a server, nothing else. Token scopes match METHOD + path only
// (lib/token-scopes.ts), so every other action lives on its own path (sync:
// POST /api/servers/sync) and `POST /api/servers` never covers more than this.
export async function POST(req: Request) {
	if (new URL(req.url).searchParams.has('action')) {
		return Response.json({ error: 'unknown action (sync moved to POST /api/servers/sync)' }, { status: 400 })
	}
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	// Registering a server hands out root SSH via the master key.
	if (!userOrResp.isAdmin) {
		return Response.json({ error: 'forbidden' }, { status: 403 })
	}

	const body = (await req.json()) as {
		name?: string
		host?: string
		user?: string
		port?: number
		kind?: 'compose' | 'raw-docker'
		proxy?: unknown
	}
	if (!body.name || !body.host) {
		return Response.json({ error: 'name and host required' }, { status: 400 })
	}
	// New servers default to Traefik; nginx / nginx-container are accepted too.
	if (body.proxy !== undefined && !isServerProxy(body.proxy)) {
		return Response.json({ error: 'invalid proxy' }, { status: 400 })
	}
	const proxy = isServerProxy(body.proxy) ? body.proxy : DEFAULT_NEW_SERVER_PROXY
	const host = body.host.trim()
	const existing = await listAllServers()
	const check = await checkNewServerHost(
		host,
		existing.map((s) => s.host),
	)
	if (!check.ok) return Response.json({ error: check.error }, { status: check.status })
	let created: Awaited<ReturnType<typeof createServer>>
	try {
		created = await createServer({
			name: body.name,
			host,
			user: body.user,
			port: body.port,
			kind: body.kind,
			proxy,
			ownerUserId: userOrResp.id,
		})
	} catch (err) {
		// unique index servers_host_unique (race with a concurrent insert)
		if (isPgError(err, '23505') || (err instanceof Error && /servers_host_unique|duplicate key/i.test(err.message))) {
			return Response.json({ error: 'host is already registered' }, { status: 409 })
		}
		throw err
	}
	// null until the first connection pins the server's key; the servers page
	// then shows the fingerprint so the operator can confirm it.
	return Response.json({ server: { ...created, hostKeyFingerprint: await getPinnedFingerprint(created.host, created.port) } })
}
