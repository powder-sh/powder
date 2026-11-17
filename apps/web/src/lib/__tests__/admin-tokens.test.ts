// background GitHub calls (deployment statuses, DEPLOYMENT.md
// sync) only use tokens of CURRENT admins; a removed user's token is never used.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	process.env.POWDER_ADMIN_USER_IDS = 'admin1,admin2'
	return {
		accounts: [
			{ userId: 'removed', providerId: 'github', accessToken: 'tok-removed', scope: 'repo' },
			{ userId: 'admin2', providerId: 'github', accessToken: 'tok-admin2', scope: 'repo,user' },
		] as Array<Record<string, string>>,
		integrations: { removed: 'pat-removed', admin2: 'pat-admin2' } as Record<string, string>,
	}
})

vi.mock('../db', () => {
	type Cond = { and?: Cond[]; ids?: string[]; eq?: [string, string] }
	const userOf = (c: Cond): string | undefined =>
		c.and?.map((x) => (x.eq?.[0] === 'userId' ? x.eq[1] : undefined)).find(Boolean)
	const rowsFor = (table: string, c: Cond) => {
		if (table === 'account') {
			const ids = c.and?.find((x) => x.ids)?.ids
			const u = userOf(c)
			return h.accounts.filter((a) => (!ids || ids.includes(a.userId)) && (!u || a.userId === u))
		}
		const u = userOf(c)
		return u && h.integrations[u]
			? [{ userId: u, accessTokenEncrypted: h.integrations[u], username: u }]
			: []
	}
	return {
		account: { userId: 'userId', providerId: 'providerId', table: 'account' },
		userIntegrations: { userId: 'userId', provider: 'provider', table: 'ui' },
		and: (...a: unknown[]) => ({ and: a }),
		eq: (col: string, v: string) => ({ eq: [col, v] }),
		inArray: (_c: unknown, ids: string[]) => ({ ids }),
		createId: () => 'x',
		prefixes: {},
		db: {
			select: () => ({
				from: (t: { table: string }) => ({
					where: (c: Cond) => {
						const p = Promise.resolve(rowsFor(t.table, c))
						return Object.assign(p, { limit: () => p })
					},
				}),
			}),
		},
	}
})
vi.mock('../crypto', () => ({ decryptSecret: (s: string) => s, encryptSecret: (s: string) => s }))
vi.mock('../oauth-token', () => ({ readOAuthAccessToken: async (t: string) => t }))
vi.mock('../servers', () => ({ getServer: async () => null }))
vi.mock('../github', () => ({ getTokenScopes: vi.fn(), getViewer: vi.fn() }))

import { adminTokenCandidates } from '../admin-ids'
import { pickGithubToken } from '../sync-deployment-md'

describe('admin-only GitHub tokens', () => {
	it('candidates are admins only, the owner first when an admin', () => {
		expect(adminTokenCandidates('removed')).toEqual(['admin1', 'admin2'])
		expect(adminTokenCandidates('admin2')).toEqual(['admin2', 'admin1'])
		expect(adminTokenCandidates(null)).toEqual(['admin1', 'admin2'])
	})
	it('DEPLOYMENT.md sync never falls back to a removed user token', async () => {
		expect(await pickGithubToken('removed')).toBe('tok-admin2')
		h.accounts = h.accounts.filter((a) => a.userId !== 'admin2')
		expect(await pickGithubToken('removed')).toBeNull()
	})
	it('deployment statuses use an admin integration, never the removed owner', async () => {
		const { getAdminGithubIntegration } = await import('../integrations')
		// admin1 has nothing, admin2 has a PAT; the removed owner has both kinds.
		h.accounts = [
			{ userId: 'removed', providerId: 'github', accessToken: 'tok-removed', scope: 'repo' },
		]
		expect((await getAdminGithubIntegration('removed'))?.token).toBe('pat-admin2')
		h.integrations = { removed: 'pat-removed' }
		expect(await getAdminGithubIntegration('removed')).toBeNull()
	})
})
