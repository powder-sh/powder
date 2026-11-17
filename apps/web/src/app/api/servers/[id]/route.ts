import { requireUser } from '@/lib/access'
import { db, eq, servers } from '@/lib/db'
import { readJsonCapped } from '@/lib/http-limits'
import { cachedBootstrapCheck } from '@/lib/server-bootstrap-run'
import { cachedDnsCheck } from '@/lib/server-dns-check'
import { validateServerSettings } from '@/lib/server-settings'
import { deleteServer, getServer, getServerSettings, updateServerSettings } from '@/lib/servers'
import { getPinnedFingerprint } from '@/lib/ssh-host-keys'
import { checkBuildHost } from '@/lib/server-host-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Server detail: identity, editable settings (raw column values) and the last
// cached bootstrap/DNS results. No SSH here.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp

	const [row] = await db.select().from(servers).where(eq(servers.id, id))
	const config = await getServer(id)
	if (!row || !config) return Response.json({ error: 'unknown server' }, { status: 404 })
	return Response.json({
		server: {
			id: row.id,
			name: row.name,
			host: row.host,
			sshUser: row.sshUser,
			sshPort: row.sshPort,
			kind: row.kind,
			status: row.status,
			lastSeenAt: row.lastSeenAt,
			lastError: row.lastError,
			// Shown once, on the server page: the SSH host key pinned on first connect.
			hostKeyFingerprint: await getPinnedFingerprint(config.host, config.port),
			settings: {
				proxy: row.proxy,
				tlsMode: row.tlsMode,
				baseDomain: row.baseDomain ?? null,
				ingressIp: row.ingressIp ?? null,
				buildHost: row.buildHost ?? null,
			},
			// What powder actually uses (validated, plus the one-release fallback).
			effectiveBaseDomain: config.baseDomain ?? null,
		},
		check: cachedBootstrapCheck(id, row.proxy),
		dns: cachedDnsCheck(id, config.baseDomain ?? null),
	})
}

// Admin-only: edit proxy / tls_mode / base_domain / ingress_ip / build_host. CSRF is
// enforced for every mutating /api request in proxy.ts.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	if (!userOrResp.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })

	// Tiny JSON body; anything unreadable (too large, not JSON) is a 400.
	const body = await readJsonCapped(req, 16 * 1024).catch(() => null)
	const v = validateServerSettings(body)
	if (!v.ok) return Response.json({ error: v.error }, { status: 400 })
	const current = await getServerSettings(id)
	if (!current) return Response.json({ error: 'unknown server' }, { status: 404 })
	// Only a new build_host is DNS-checked: re-sending the stored value (the form
	// saving another field) must not fail because the builder is unreachable now.
	if (v.value.buildHost && v.value.buildHost !== current.buildHost) {
		const hc = await checkBuildHost(v.value.buildHost)
		if (!hc.ok) return Response.json({ error: hc.error }, { status: 400 })
	}
	const settings = await updateServerSettings(id, v.value)
	return Response.json({ settings })
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp

	const res = await deleteServer(id)
	if (!res.ok && res.reason === 'unknown') return Response.json({ error: 'unknown server' }, { status: 404 })
	if (!res.ok && res.reason === 'apps') {
		const n = res.apps.length
		return Response.json(
			{
				error: `this server still has ${n} app${n === 1 ? '' : 's'} (${res.apps.join(', ')}): delete ${n === 1 ? 'it' : 'them'} first`,
				code: 'server_has_apps',
				apps: res.apps,
			},
			{ status: 409 },
		)
	}
	return Response.json({ ok: true })
}
