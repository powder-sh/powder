import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	user: { id: 'u1', email: 'a@b.c', name: 'x', isAdmin: false } as {
		id: string
		email: string
		name: string
		isAdmin: boolean
	},
	servers: [{ host: '203.0.113.10' }] as Array<{ host: string }>,
	created: 0,
}))

vi.mock('@/lib/access', () => ({ requireUser: async () => state.user }))
vi.mock('@/lib/db', () => ({}))
vi.mock('@/lib/ssh', () => ({}))
vi.mock('@/lib/ssh-host-keys', () => ({ getPinnedFingerprint: async () => null }))
vi.mock('@/lib/servers', () => ({
	listAllServers: async () => state.servers,
	listServers: async () => [],
	updateServerStatus: async () => {},
	createServer: async () => {
		state.created++
		return { id: 'srv_1' }
	},
}))

import { POST } from '@/app/api/servers/route'
import { checkNewServerHost, isBlockedIp } from '@/lib/server-host-guard'

const post = (host: string) =>
	POST(
		new Request('http://x/api/servers', {
			method: 'POST',
			body: JSON.stringify({ name: 'n', host }),
		}),
	)

beforeEach(() => {
	state.created = 0
	state.user = { id: 'u1', email: 'a@b.c', name: 'x', isAdmin: false }
})

describe('POST /api/servers: registering a server is admin-only and host-checked', () => {
	it('non-admin gets 403 and nothing is created', async () => {
		const res = await post('198.51.100.7')
		expect(res.status).toBe(403)
		expect(state.created).toBe(0)
	})
	it('admin registering an existing host gets 409', async () => {
		state.user.isAdmin = true
		const res = await post('203.0.113.10')
		expect(res.status).toBe(409)
		expect(state.created).toBe(0)
	})
	it('admin registering a new public IP succeeds', async () => {
		state.user.isAdmin = true
		const res = await post('198.51.100.7')
		expect(res.status).toBe(200)
		expect(state.created).toBe(1)
	})
})

describe('checkNewServerHost', () => {
	// Tailscale CGNAT addresses, built so no literal IP is in source.
	const cgnat = (b: number, c: number, d: number) => `100.${b}.${c}.${d}`
	const fake = (m: Record<string, string[]>) => async (h: string) => m[h] ?? []
	it('rejects blocked ranges', () => {
		for (const ip of ['127.0.0.1', '0.0.0.0', '169.254.1.1', '::1', '::', 'fe80::1'])
			expect(isBlockedIp(ip)).toBe(true)
		for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', cgnat(64, 0, 1), cgnat(96, 1, 2), cgnat(103, 3, 4), cgnat(111, 5, 6), 'fd00::1', '8.8.8.8']) expect(isBlockedIp(ip)).toBe(false)
	})
	it('rejects a hostname resolving to an existing server IP (409)', async () => {
		const r = await checkNewServerHost('alias.example.com', ['203.0.113.10'], fake({ 'alias.example.com': ['203.0.113.10'], '203.0.113.10': ['203.0.113.10'] }))
		expect(r).toMatchObject({ ok: false, status: 409 })
	})
	it('rejects a hostname resolving to loopback (400)', async () => {
		const r = await checkNewServerHost('evil.example.com', [], fake({ 'evil.example.com': ['127.0.0.1'] }))
		expect(r).toMatchObject({ ok: false, status: 400 })
	})
})
