import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	process.env.POWDER_ADMIN_USER_IDS = 'admin1'
	return { userId: 'tenant1' }
})

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('../auth', () => ({
	auth: {
		api: {
			getSession: async () => ({ user: { id: h.userId, email: 'e', name: 'n' } }),
		},
	},
}))
vi.mock('../db', () => ({
	and: () => 0, eq: () => 0, isNull: () => 0,
	appRepos: {}, servers: {}, user: {}, userApiTokens: {},
	db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
}))
vi.mock('../servers', () => ({
	getServerForUser: async () => undefined,
	listAllServers: async () => [],
	listServers: async () => [],
}))
vi.mock('@/lib/db', () => ({}))
vi.mock('@/lib/ssh', () => ({}))

delete process.env.POWDER_SINGLE_TENANT

import { GET as projectGet } from '@/app/api/projects/[id]/domains/route'
import { GET as serversGet } from '@/app/api/servers/route'
import { singleTenantBlocks } from '../access'
import { ignoredEnvNotes } from '../startup-checks'

beforeEach(() => {
	h.userId = 'tenant1'
	delete process.env.POWDER_SINGLE_TENANT
})

describe('single-tenant gate', () => {
	it('blocks a non-admin id', () => expect(singleTenantBlocks('tenant1')?.status).toBe(403))
	it('lets an admin id through', () => expect(singleTenantBlocks('admin1')).toBeNull())
	it('non-admin gets 403 single_tenant on GET /api/servers', async () => {
		const res = await serversGet()
		expect(res.status).toBe(403)
		expect(await res.json()).toEqual({ error: 'single_tenant' })
	})
	it('non-admin gets 403 on a project route', async () => {
		const res = (await projectGet(new Request('http://x'), {
			params: Promise.resolve({ id: 'p' }),
		})) as Response
		expect(res.status).toBe(403)
		expect(await res.json()).toEqual({ error: 'single_tenant' })
	})
	it('admin passes the gate', async () => {
		h.userId = 'admin1'
		const res = await serversGet()
		expect(res.status).toBe(200)
	})
	it('POWDER_SINGLE_TENANT=false does not switch it off', async () => {
		process.env.POWDER_SINGLE_TENANT = 'false'
		expect(singleTenantBlocks('tenant1')?.status).toBe(403)
		const res = await serversGet()
		expect(res.status).toBe(403)
		expect(ignoredEnvNotes()[0]).toMatch(/POWDER_SINGLE_TENANT is ignored/)
	})
	it('no note when the env is unset', () => expect(ignoredEnvNotes({} as NodeJS.ProcessEnv)).toEqual([]))
})
