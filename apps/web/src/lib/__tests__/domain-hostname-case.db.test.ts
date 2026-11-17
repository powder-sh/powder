import { afterAll, describe, expect, it, vi } from 'vitest'

// PATCH saves the redirect row under the lowercased, trimmed hostname, the key GET
// reads it by (the URL host). A PATCH for "Example.com" then shows its mode in GET,
// and a second PATCH with other casing updates the same row.
//
// Needs a migrated scratch database (every file in packages/db/drizzle applied):
//   POWDER_TEST_DATABASE_URL=postgres:///powder_test pnpm -C apps/web test
// Skipped without it. Never point it at a real powder database: it writes rows.
const url = process.env.POWDER_TEST_DATABASE_URL
if (url) {
	process.env.DATABASE_URL = url
	process.env.POWDER_ENCRYPTION_KEY ??= 'ab'.repeat(32)
}

const h = vi.hoisted(() => ({
	serverId: `srv_case_${Math.random().toString(36).slice(2)}`,
}))
const server = { id: h.serverId, name: 'server', host: 'h', proxy: 'traefik' as const }

vi.mock('server-only', () => ({}))
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ user: { id: 'u1' }, server }),
	requireUser: async () => ({ id: 'u1', isAdmin: true }),
	visibleRepos: async () => [{ serverId: h.serverId, containerName: 'app' }],
}))
vi.mock('@/lib/domain-ownership', () => ({
	hostnameOwnedByApp: async () => true,
	siblingHostAllowedForApp: async () => true,
	SIBLING_TAKEN: 'belongs to another app',
}))
vi.mock('@/lib/servers', () => ({
	getServer: async () => server,
	listAllServers: async () => [server],
}))
vi.mock('@/lib/managed-containers', () => ({ managedContainerNames: async () => ['app'] }))
vi.mock('@/lib/ssh', () => ({
	listContainers: async () => [{ name: 'app', ports: '127.0.0.1:3000->3000/tcp' }],
	getNginxRoutes: async () => [{ host: '127.0.0.1', port: 3000, urls: ['https://example.com'] }],
	getContainerHostNetInfo: async () => new Map(),
	extractHostPorts: () => [3000],
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
}))

describe.skipIf(!url)('domain redirect hostname casing', () => {
	afterAll(async () => {
		const { db, domainRedirects, eq } = await import('@/lib/db')
		await db.delete(domainRedirects).where(eq(domainRedirects.serverId, h.serverId))
	})

	const patch = async (hostname: string, wwwMode: string) => {
		const { PATCH } = await import('@/app/api/domains/[serverId]/[name]/[hostname]/route')
		return PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ wwwMode }) }), {
			params: Promise.resolve({ serverId: h.serverId, name: 'app', hostname: encodeURIComponent(hostname) }),
		})
	}

	it('PATCH Example.com then GET shows the mode, one row', async () => {
		expect((await patch(' Example.com ', 'apex')).status).toBe(200)
		expect((await patch('EXAMPLE.com', 'www')).status).toBe(200)

		const { db, domainRedirects, eq } = await import('@/lib/db')
		const rows = await db.select().from(domainRedirects).where(eq(domainRedirects.serverId, h.serverId))
		expect(rows.map((r) => [r.hostname, r.wwwMode])).toEqual([['example.com', 'www']])

		const { GET } = await import('@/app/api/domains/route')
		const body = (await (await GET(new Request('http://x/api/domains?app=app'))).json()) as {
			domains: { hostname: string; wwwMode: string }[]
		}
		expect(body.domains.map((d) => [d.hostname, d.wwwMode])).toEqual([['example.com', 'www']])
	})
})
