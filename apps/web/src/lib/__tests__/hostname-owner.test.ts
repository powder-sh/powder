import { beforeEach, describe, expect, it, vi } from 'vitest'

const owned = vi.fn()
const siblingOk = vi.fn(async () => true)
const dbTouched = vi.fn()
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ user: { id: 'u1' }, server: { id: 's1', proxy: 'traefik' } }),
}))
vi.mock('@/lib/app-domains', () => ({ isValidHostname: () => true }))
vi.mock('@/lib/domain-ownership', () => ({
	hostnameOwnedByApp: (...a: unknown[]) => owned(...a),
	siblingHostAllowedForApp: (...a: unknown[]) => siblingOk(...(a as [])),
	SIBLING_TAKEN: 'belongs to another app',
}))
vi.mock('@/lib/domain-redirects', () => ({
	applyToNginxContainer: vi.fn(),
	applyToNginxHost: vi.fn(),
	applyToTraefik: vi.fn(),
	detectProxyKind: () => 'traefik',
	wwwRedirectHost: (i: { hostname: string; wwwMode: string }) => (i.wwwMode === 'apex' ? `www.${i.hostname}` : null),
}))
vi.mock('@/lib/db', () => {
	const touch = () => {
		dbTouched()
		return chain
	}
	const chain: unknown = new Proxy(() => {}, {
		get: (_t, k) => (k === 'then' ? (res: (v: unknown) => unknown) => res([]) : touch()),
		apply: () => chain,
	})
	return { and: () => 1, eq: () => 1, createId: () => 'x', prefixes: {}, domainRedirects: {}, db: chain }
})

import { PATCH } from '../../app/api/domains/[serverId]/[name]/[hostname]/route'

const call = (hostname: string) =>
	PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ wwwMode: 'apex', apply: true }) }), {
		params: Promise.resolve({ serverId: 's1', name: 'app', hostname }),
	})

describe('hostname ownership', () => {
	beforeEach(() => {
		owned.mockReset()
		dbTouched.mockReset()
	})
	it('foreign hostname -> 403 and nothing is written', async () => {
		owned.mockResolvedValue(false)
		const res = await call('www.victim.example')
		expect(res.status).toBe(403)
		expect(dbTouched).not.toHaveBeenCalled()
	})
	it('own hostname passes the gate', async () => {
		owned.mockResolvedValue(true)
		const res = await call('mine.example')
		expect(res.status).not.toBe(403)
	})
	it('a www sibling that belongs to another app -> 403 before anything is saved', async () => {
		owned.mockResolvedValue(true)
		siblingOk.mockResolvedValueOnce(false)
		const res = await call('shop.example')
		expect(res.status).toBe(403)
		expect(((await res.json()) as { error: string }).error).toContain('www.shop.example belongs to another app')
		expect(dbTouched).not.toHaveBeenCalled()
	})
	it('domainRowOwnedBy needs same repo and verified/live', async () => {
		const { domainRowOwnedBy } = await vi.importActual<typeof import('../domain-ownership')>('../domain-ownership')
		expect(domainRowOwnedBy({ appRepoId: 'r1', status: 'live' }, 'r1')).toBe(true)
		expect(domainRowOwnedBy({ appRepoId: 'r1', status: 'verified' }, 'r1')).toBe(true)
		expect(domainRowOwnedBy({ appRepoId: 'r1', status: 'pending' }, 'r1')).toBe(false)
		expect(domainRowOwnedBy({ appRepoId: 'r2', status: 'live' }, 'r1')).toBe(false)
		expect(domainRowOwnedBy(null, 'r1')).toBe(false)
	})
})
