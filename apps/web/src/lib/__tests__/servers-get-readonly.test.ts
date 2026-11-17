import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateStatus = vi.fn()
vi.mock('@/lib/access', () => ({ requireUser: async () => ({ id: 'a', isAdmin: true }) }))
vi.mock('@/lib/db', () => ({
	and: () => 0, appDomains: {}, appRepos: {}, createId: () => 'x', db: { select: () => ({ from: () => ({ where: async () => [] }) }) }, deploys: {}, desc: () => 0, eq: () => 0, prefixes: {}, sql: () => 0,
}))
vi.mock('@/lib/app-domains', () => ({ isValidHostname: () => true, newChallenge: () => 'c' }))
vi.mock('@/lib/server-host-guard', () => ({ checkNewServerHost: () => null }))
vi.mock('@/lib/servers', () => ({
	createServer: vi.fn(),
	listAllServers: async () => [{ id: 's1', name: 's', host: 'h', kind: 'compose', status: 'pending' }],
	updateServerStatus: (...a: unknown[]) => updateStatus(...a),
}))
vi.mock('@/lib/ssh', () => ({
	extractHostPorts: () => [],
	getContainerHostNetInfo: vi.fn(),
	getNginxRoutes: vi.fn(),
	listContainers: async () => {
		throw new Error('unreachable server')
	},
}))

import { GET, POST } from '../../app/api/servers/route'
import { POST as SYNC } from '../../app/api/servers/sync/route'
import { tokenAllows } from '../token-scopes'

describe('GET /api/servers is side-effect free', () => {
	beforeEach(() => updateStatus.mockReset())
	it('GET writes nothing', async () => {
		const r = await GET()
		expect(r.status).toBe(200)
		expect(updateStatus).not.toHaveBeenCalled()
	})
	it('POST /api/servers/sync performs the writes', async () => {
		await SYNC()
		expect(updateStatus).toHaveBeenCalledWith('s1', 'unreachable', 'unreachable server')
	})
	it('POST /api/servers?action=sync does not sync (scope POST /api/servers = register only)', async () => {
		const r = await POST(new Request('http://x/api/servers?action=sync', { method: 'POST' }))
		expect(r.status).toBe(400)
		expect(updateStatus).not.toHaveBeenCalled()
	})
	it('register and sync need separate scopes', () => {
		expect(tokenAllows(['POST /api/servers'], 'POST /api/servers/sync')).toBe(false)
		expect(tokenAllows(['POST /api/servers/sync'], 'POST /api/servers')).toBe(false)
	})
})
