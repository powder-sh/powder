import { describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('../auth', () => ({ auth: { api: { getSession: async () => ({ user: { id: 'a', email: 'a', name: 'a' } }) } } }))
vi.mock('../admin-ids', () => ({ isAdminUserId: () => true }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 'srv' }) }))
vi.mock('../db', () => {
	const c: Record<string, unknown> = {}
	for (const k of ['from', 'where', 'innerJoin', 'limit']) c[k] = () => c
	c.then = (res: (v: unknown) => unknown) => res([])
	return { and: () => 0, eq: () => 0, isNull: () => 0, appRepos: {}, previewDeploys: {}, user: {}, userApiTokens: {}, db: { select: () => c } }
})
vi.mock('@/lib/access', async () => await vi.importActual('../access'))
vi.mock('@/lib/repos', () => ({ getRepoFor: async () => null, createRepo: vi.fn(), deleteRepo: vi.fn() }))
vi.mock('@/lib/ssh', () => ({ inspectContainer: vi.fn(), runCommand: vi.fn() }))
vi.mock('@/lib/github', () => ({}))
vi.mock('@/lib/integrations', () => ({}))
vi.mock('@/lib/keygen', () => ({}))
vi.mock('@/lib/env-vars-db', () => ({}))
vi.mock('@/lib/github-bootstrap', () => ({}))

import { requireContainerAccess } from '../access'
import { GET } from '../../app/api/servers/[id]/containers/[name]/repo/route'

describe('connect flow still works for an unmanaged container', () => {
	it('strict access: unconnected container -> 404', async () => {
		const r = await requireContainerAccess('srv', 'newapp')
		expect(r instanceof Response && r.status).toBe(404)
	})
	it('allowUnmanaged still validates the name', async () => {
		const r = await requireContainerAccess('srv', 'x/../y', { allowUnmanaged: true })
		expect(r instanceof Response && r.status).toBe(400)
	})
	it('GET /repo on an unconnected container -> {connected:false}', async () => {
		const res = await GET(new Request('http://x') as never, { params: Promise.resolve({ id: 'srv', name: 'newapp' }) })
		expect(await res.json()).toEqual({ connected: false })
	})
})
