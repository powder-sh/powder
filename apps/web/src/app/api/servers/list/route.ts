import { requireUser } from '@/lib/access'
import { listAllServers } from '@/lib/servers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Cheap server list straight from the DB (no SSH). Same visibility rules as /api/servers.
export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const all = await listAllServers()
	return Response.json({
		servers: all.map((s) => ({
			id: s.id,
			name: s.name,
			host: s.host,
			kind: s.kind,
			status: s.status,
			traefik: s.proxy === 'traefik',
			proxy: s.proxy,
			tlsMode: s.tlsMode,
			baseDomain: s.baseDomain ?? null,
		})),
	})
}
