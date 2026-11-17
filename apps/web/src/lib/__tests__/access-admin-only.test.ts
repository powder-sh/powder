import { describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('../auth', () => ({ auth: { api: { getSession: async () => null } } }))
vi.mock('../db', () => ({
	and: () => 0, eq: () => 0, isNull: () => 0,
	appRepos: {}, user: {}, userApiTokens: {},
	db: {
		select: () => ({
			from: async () => [
				{ id: 'r1', ownerUserId: 'someone', containerName: 'shop' },
				{ id: 'r2', ownerUserId: 'someone', containerName: 'powder' },
			],
		}),
	},
}))
vi.mock('../servers', () => ({
	getServer: async (id: string) => (id === 'srv' ? { id: 'srv' } : undefined),
}))

import { requireServerForUser, visibleRepos } from '../access'

describe('access (single-tenant: every caller is an admin)', () => {
	it('requireServerForUser: server or 404', async () => {
		expect(await requireServerForUser('srv')).toEqual({ id: 'srv' })
		const missing = await requireServerForUser('nope')
		expect(missing instanceof Response && missing.status).toBe(404)
	})

	it('visibleRepos: every app row; powder\'s own row only to an admin session', async () => {
		const session = { isAdmin: true, viaToken: false }
		const token = { isAdmin: true, viaToken: true }
		expect(await visibleRepos(session, 'admin-session')).toHaveLength(2)
		expect((await visibleRepos(token, 'admin-session')).map((r) => r.containerName)).toEqual(['shop'])
		expect((await visibleRepos(session, 'never')).map((r) => r.containerName)).toEqual(['shop'])
	})
})
