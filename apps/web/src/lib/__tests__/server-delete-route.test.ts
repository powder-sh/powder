// DELETE /api/servers/[id] refuses while any app row points at the server: the
// browser hides the button, but the API is the authority (there is no foreign key).
// The check and the delete run in one transaction.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	server: true,
	apps: [] as string[],
	deleted: [] as { table: string; inTx: boolean }[],
	locked: [] as string[],
}))

vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u1', email: 'a@b.c', name: 'x', isAdmin: true }),
}))
vi.mock('@/lib/server-bootstrap-run', () => ({ cachedBootstrapCheck: () => null }))
vi.mock('@/lib/server-dns-check', () => ({ cachedDnsCheck: () => null }))
vi.mock('@/lib/ssh-host-keys', () => ({ getPinnedFingerprint: async () => null }))
vi.mock('@/lib/db', () => {
	const servers = { __t: 'servers', id: 'servers.id' }
	const appRepos = { __t: 'app_repos', serverId: 'app_repos.server_id', containerName: 'app_repos.container_name' }
	const handle = (inTx: boolean) => ({
		select: () => ({
			from: (t: { __t: string }) => ({
				where: () => ({
					for: async (mode: string) => {
						if (!inTx) throw new Error('read outside the transaction')
						state.locked.push(`${t.__t}:${mode}`)
						return t.__t === 'servers' ? (state.server ? [{ id: 's1' }] : []) : state.apps.map((name) => ({ name }))
					},
				}),
			}),
		}),
		delete: (t: { __t: string }) => ({
			where: async () => {
				state.deleted.push({ table: t.__t, inTx })
			},
		}),
	})
	return {
		db: { ...handle(false), transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(handle(true)) },
		servers,
		appRepos,
		eq: () => null,
		createId: () => 'id',
		prefixes: {},
	}
})

import { DELETE } from '@/app/api/servers/[id]/route'

const del = () =>
	DELETE(new Request('http://x/api/servers/s1', { method: 'DELETE' }), { params: Promise.resolve({ id: 's1' }) })

beforeEach(() => {
	state.server = true
	state.apps = []
	state.deleted = []
	state.locked = []
})

describe('DELETE /api/servers/[id]', () => {
	it('deletes a server with no apps, inside the transaction', async () => {
		const res = await del()
		expect(res.status).toBe(200)
		expect(state.deleted).toEqual([{ table: 'servers', inTx: true }])
		expect(state.locked).toEqual(['servers:update', 'app_repos:update'])
	})
	it('409 with the app names while an app is left; nothing is deleted', async () => {
		state.apps = ['shop', 'blog']
		const res = await del()
		expect(res.status).toBe(409)
		const body = (await res.json()) as { error: string; code: string; apps: string[] }
		expect(body.code).toBe('server_has_apps')
		expect(body.apps).toEqual(['shop', 'blog'])
		expect(body.error).toContain('2 apps (shop, blog): delete them first')
		expect(state.deleted).toEqual([])
	})
	it('404 for an unknown server', async () => {
		state.server = false
		expect((await del()).status).toBe(404)
		expect(state.deleted).toEqual([])
	})
})
