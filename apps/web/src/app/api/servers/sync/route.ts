import { requireUser } from '@/lib/access'
import { buildServerList } from '@/lib/server-list'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The servers page calls this on load and refresh: lists every server and
// persists what it found (server status, discovered domains as pending,
// stale-failure reconcile rows). Own path so a token scoped to
// `POST /api/servers` (register a server) does not also cover the sync, and
// `POST /api/servers/sync` does not cover registering a server.
export async function POST() {
	const u = await requireUser()
	if (u instanceof Response) return u
	return buildServerList(true)
}
