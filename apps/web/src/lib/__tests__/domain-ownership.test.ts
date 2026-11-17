import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	rows: {} as Record<string, unknown[]>,
	inserted: [] as unknown[],
	updates: [] as Array<Record<string, unknown>>,
	otherLive: null as unknown,
	txtOk: false,
}))

vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ user: { id: 'u', isAdmin: false }, server: {} }),
}))
vi.mock('@/lib/traefik-servers', () => ({ isTraefikServer: async (id: string) => id === 'traefik-1' }))
vi.mock('@/lib/app-domains', () => ({
	findDomainByHostname: async () => h.otherLive,
	ingressTargetFor: () => null,
	isUniqueViolation: () => false,
	isValidHostname: () => true,
	listDomainsForRepo: async () => [],
	newVerifyToken: () => 'tok',
	VERIFY_TXT_PREFIX: '_powder-verify.',
	applyDomainsToCompose: async () => {},
	applyPreviewDomainsToCompose: async () => {},
	verifyDns: async () => ({ ok: true }),
	verifyTxtChallenge: async () => (h.txtOk ? { ok: true } : { ok: false, reason: 'no TXT' }),
}))
vi.mock('@/lib/db', () => {
	const tbl = (n: string) => ({ __t: n })
	const appDomains = tbl('appDomains')
	const appRepos = tbl('appRepos')
	const previewDeploys = tbl('previewDeploys')
	const chain = (name: string) => {
		const c: Record<string, unknown> = {}
		c.where = () => c
		c.limit = () => c
		c.then = (res: (v: unknown) => unknown) => res(h.rows[name] ?? [])
		return c
	}
	return {
		and: () => 0,
		eq: () => 0,
		createId: () => 'dom_new',
		prefixes: { appDomain: 'dom' },
		appDomains,
		appRepos,
		previewDeploys,
		db: {
			select: () => ({ from: (t: { __t: string }) => chain(t.__t) }),
			insert: () => ({ values: async (v: unknown) => void h.inserted.push(v) }),
			update: () => ({
				set: (v: Record<string, unknown>) => {
					h.updates.push(v)
					return { where: async () => {} }
				},
			}),
		},
	}
})

import { POST as addRoute } from '@/app/api/servers/[id]/containers/[name]/domains/route'
import { POST as verifyRoute } from '@/app/api/servers/[id]/containers/[name]/domains/[domainId]/route'

const repo = { id: 'repo_a', serverId: 'traefik-1', containerName: 'a' }
const ctx = { params: Promise.resolve({ id: 'traefik-1', name: 'a' }) }
const req = (body: unknown) =>
	new Request('http://x', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
	h.rows = { appRepos: [repo], appDomains: [], previewDeploys: [] }
	h.inserted = []
	h.updates = []
	h.otherLive = null
	h.txtOk = false
})

describe('add domain: a hostname belongs to one app', () => {
	it('returns 409 for a hostname already live on another app', async () => {
		h.otherLive = { appRepoId: 'repo_b', status: 'live', hostname: 'x.com' }
		const res = await addRoute(req({ hostname: 'x.com' }), ctx)
		expect(res.status).toBe(409)
		expect(h.inserted).toHaveLength(0)
	})
	it('rejects a previewId belonging to another app', async () => {
		h.rows.previewDeploys = [{ id: 'pv1', appRepoId: 'repo_b' }]
		const res = await addRoute(req({ hostname: 'new.com', previewId: 'pv1' }), ctx)
		expect(res.status).toBe(400)
		expect(h.inserted).toHaveLength(0)
	})
	it('inserts a pending row with a challenge token', async () => {
		const res = await addRoute(req({ hostname: 'new.com' }), ctx)
		expect(res.status).toBe(200)
		expect(h.inserted[0]).toMatchObject({ status: 'pending', verifyChallenge: 'tok' })
	})
})

describe('verify: DNS alone is not ownership', () => {
	const vctx = { params: Promise.resolve({ id: 'traefik-1', name: 'a', domainId: 'd1' }) }
	it('does not go live without the TXT record', async () => {
		h.rows.appDomains = [{ id: 'd1', appRepoId: 'repo_a', hostname: 'new.com', status: 'pending', verifyChallenge: 'tok' }]
		const res = await verifyRoute(req({}), vctx)
		const json = (await res.json()) as { ok: boolean }
		expect(json.ok).toBe(false)
		expect(h.updates.some((u) => u.status === 'live')).toBe(false)
	})
	it('goes live when the TXT record matches', async () => {
		h.txtOk = true
		h.rows.appDomains = [{ id: 'd1', appRepoId: 'repo_a', hostname: 'new.com', status: 'pending', verifyChallenge: 'tok' }]
		const res = await verifyRoute(req({}), vctx)
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
		expect(h.updates.some((u) => u.status === 'live')).toBe(true)
	})
})
