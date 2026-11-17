// DELETE /api/admin/users/<id>: admin browser session only, never an admin id
// or the caller's own id; the proxy refuses a bearer token and a cross-site call.
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	caller: { id: 'u_admin', email: 'a@x', isAdmin: true, viaToken: false } as Record<string, unknown>,
	admins: new Set(['u_admin', 'u_other_admin']),
	rows: [] as Array<{ id: string; email: string }>,
	deleted: [] as string[],
}))

vi.mock('@/lib/access', () => ({ requireUser: async () => h.caller }))
vi.mock('@/lib/admin-ids', () => ({ isAdminUserId: (id: string) => h.admins.has(id) }))
vi.mock('@/lib/db', () => {
	const table = (name: string) => ({ __name: name, userId: `${name}.userId`, id: `${name}.id`, email: `${name}.email` })
	const tx = {
		select: () => ({ from: () => ({ where: () => ({ for: async () => h.rows }) }) }),
		delete: (t: { __name: string }) => ({ where: async () => void h.deleted.push(t.__name) }),
	}
	return {
		account: table('account'),
		session: table('session'),
		userApiTokens: table('user_api_tokens'),
		userIntegrations: table('user_integrations'),
		user: table('user'),
		eq: () => 0,
		db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
	}
})

import { DELETE } from '@/app/api/admin/users/[id]/route'
import { proxy } from '../../proxy'

const del = (id: string) => DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
	h.caller = { id: 'u_admin', email: 'a@x', isAdmin: true, viaToken: false }
	h.rows = []
	h.deleted = []
})

describe('DELETE /api/admin/users/<id>', () => {
	it('removes sessions, accounts, tokens, integrations, then the user', async () => {
		h.rows = [{ id: 'u_x', email: 'x@x' }]
		const r = await del('u_x')
		expect(r.status).toBe(200)
		expect(await r.json()).toEqual({ ok: true, removed: { id: 'u_x', email: 'x@x' } })
		expect(h.deleted).toEqual(['session', 'account', 'user_api_tokens', 'user_integrations', 'user'])
	})
	it('404 for an unknown id, nothing deleted', async () => {
		expect((await del('u_none')).status).toBe(404)
		expect(h.deleted).toEqual([])
	})
	it('refuses an admin id and the caller itself', async () => {
		h.rows = [{ id: 'u_other_admin', email: 'o@x' }]
		expect((await del('u_other_admin')).status).toBe(400)
		expect((await del('u_admin')).status).toBe(400)
		expect(h.deleted).toEqual([])
	})
	it('refuses a non-admin and a token caller', async () => {
		h.rows = [{ id: 'u_x', email: 'x@x' }]
		h.caller = { id: 'u_y', email: 'y@x', isAdmin: false, viaToken: false }
		expect((await del('u_x')).status).toBe(403)
		h.caller = { id: 'u_admin', email: 'a@x', isAdmin: true, viaToken: true }
		expect((await del('u_x')).status).toBe(403)
		expect(h.deleted).toEqual([])
	})
	it('the proxy refuses a bearer token and a cross-site session call', () => {
		const call = (headers: Record<string, string>) =>
			proxy(new NextRequest('https://powder.sh/api/admin/users/u_x', { method: 'DELETE', headers: { host: 'powder.sh', ...headers } }))
		expect(call({ authorization: 'Bearer pwd_x' }).status).toBe(403)
		expect(call({ cookie: 'session=1', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }).status).toBe(403)
		expect(call({ cookie: 'session=1', 'sec-fetch-site': 'same-origin' }).status).toBe(200)
	})
})
