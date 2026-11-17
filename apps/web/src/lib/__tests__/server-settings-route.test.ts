import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	user: { id: 'u1', email: 'a@b.c', name: 'x', isAdmin: true },
	updates: [] as unknown[],
	exists: true,
	storedBuildHost: null as string | null,
	buildHostChecks: [] as string[],
}))

vi.mock('@/lib/access', () => ({
	requireUser: async () => state.user,
	requireServerForUser: async () => ({ id: 'server' }),
}))
vi.mock('@/lib/db', () => ({}))
vi.mock('@/lib/server-bootstrap-run', () => ({ cachedBootstrapCheck: () => null }))
vi.mock('@/lib/server-host-guard', async (orig) => {
	const real = await orig<typeof import('@/lib/server-host-guard')>()
	return {
		...real,
		// No network in tests: a name "resolves" only if it is an IP literal.
		checkBuildHost: async (host: string) => {
			state.buildHostChecks.push(host)
			return real.checkBuildHost(host, async (h) => (/^[\d.]+$/.test(h) ? [h] : []))
		},
	}
})
vi.mock('@/lib/server-dns-check', () => ({ cachedDnsCheck: () => null }))
vi.mock('@/lib/servers', () => ({
	getServer: async () => undefined,
	deleteServer: async () => {},
	getServerSettings: async () =>
		state.exists ? { proxy: 'nginx', buildHost: state.storedBuildHost } : undefined,
	updateServerSettings: async (_id: string, patch: unknown) => {
		state.updates.push(patch)
		return patch
	},
}))

import { POST as BOOTSTRAP } from '@/app/api/servers/[id]/bootstrap/route'
import { PATCH } from '@/app/api/servers/[id]/route'

const ctx = { params: Promise.resolve({ id: 'server' }) }
const patch = (body: unknown) =>
	PATCH(
		new Request('http://x/api/servers/server', { method: 'PATCH', body: JSON.stringify(body) }),
		ctx,
	)

beforeEach(() => {
	state.user = { id: 'u1', email: 'a@b.c', name: 'x', isAdmin: true }
	state.updates = []
	state.exists = true
	state.storedBuildHost = null
	state.buildHostChecks = []
})

describe('PATCH /api/servers/[id]', () => {
	it('non-admin gets 403 and nothing is written', async () => {
		state.user = { ...state.user, isAdmin: false }
		expect((await patch({ proxy: 'traefik' })).status).toBe(403)
		expect(state.updates).toEqual([])
	})
	it('invalid base_domain is a 400', async () => {
		const res = await patch({ baseDomain: '*.apps.example.com' })
		expect(res.status).toBe(400)
		expect(state.updates).toEqual([])
	})
	it('unknown server is a 404', async () => {
		state.exists = false
		expect((await patch({ proxy: 'traefik' })).status).toBe(404)
	})
	it('writes the validated patch', async () => {
		const res = await patch({
			proxy: 'nginx-container',
			baseDomain: 'apps.example.com',
			ingressIp: '',
		})
		expect(res.status).toBe(200)
		expect(state.updates).toEqual([
			{ proxy: 'nginx-container', baseDomain: 'apps.example.com', ingressIp: null },
		])
	})
})

describe('PATCH /api/servers/[id] buildHost', () => {
	it('writes a build host (an IP literal resolves to itself, no DNS)', async () => {
		const res = await patch({ buildHost: ' 203.0.113.7 ' })
		expect(res.status).toBe(200)
		expect(state.updates).toEqual([{ buildHost: '203.0.113.7' }])
	})
	it('empty clears it', async () => {
		expect((await patch({ buildHost: '' })).status).toBe(200)
		expect(state.updates).toEqual([{ buildHost: null }])
	})
	it('a loopback, a URL or a user@host is a 400 and nothing is written', async () => {
		for (const buildHost of ['127.0.0.1', 'ssh://builder.example.com', 'root@builder.example.com', 7]) {
			expect((await patch({ buildHost })).status).toBe(400)
		}
		expect(state.updates).toEqual([])
	})
	it('re-sending the stored build host skips the DNS check', async () => {
		state.storedBuildHost = 'builder.example.com'
		const res = await patch({ proxy: 'traefik', buildHost: 'builder.example.com' })
		expect(res.status).toBe(200)
		expect(state.buildHostChecks).toEqual([])
		expect(state.updates).toEqual([{ proxy: 'traefik', buildHost: 'builder.example.com' }])
	})
	it('a changed build host is still DNS-checked', async () => {
		state.storedBuildHost = 'builder.example.com'
		const res = await patch({ buildHost: 'other.example.com' })
		expect(res.status).toBe(400)
		expect(state.buildHostChecks).toEqual(['other.example.com'])
		expect(state.updates).toEqual([])
	})
	it('non-admin gets 403', async () => {
		state.user = { ...state.user, isAdmin: false }
		expect((await patch({ buildHost: '203.0.113.7' })).status).toBe(403)
		expect(state.updates).toEqual([])
	})
})

describe('POST /api/servers/[id]/bootstrap', () => {
	it('is admin-only', async () => {
		state.user = { ...state.user, isAdmin: false }
		const res = await BOOTSTRAP(
			new Request('http://x', { method: 'POST', body: JSON.stringify({ mode: 'check' }) }),
			ctx,
		)
		expect(res.status).toBe(403)
	})
	it('apply without confirmed steps is a 400', async () => {
		const res = await BOOTSTRAP(
			new Request('http://x', {
				method: 'POST',
				body: JSON.stringify({ mode: 'apply', steps: ['rm -rf /'] }),
			}),
			ctx,
		)
		expect(res.status).toBe(400)
	})
})

describe('changedSettings (server settings form)', () => {
	const saved = { proxy: 'traefik', tlsMode: 'acme', baseDomain: 'apps.example.com', ingressIp: null, buildHost: 'b.example.com' }
	const form = { proxy: 'traefik', tlsMode: 'acme', baseDomain: 'apps.example.com', ingressIp: '', buildHost: 'b.example.com' }
	it('sends only the changed fields', async () => {
		const { changedSettings } = await import('@/lib/server-settings-diff')
		expect(changedSettings(saved, form)).toEqual({})
		expect(changedSettings(saved, { ...form, proxy: 'nginx' })).toEqual({ proxy: 'nginx' })
		expect(changedSettings(saved, { ...form, buildHost: '' })).toEqual({ buildHost: '' })
		expect(changedSettings(saved, { ...form, ingressIp: ' 203.0.113.1 ' })).toEqual({ ingressIp: ' 203.0.113.1 ' })
	})
})
