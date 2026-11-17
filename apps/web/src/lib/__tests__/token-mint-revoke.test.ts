import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let caller: Record<string, unknown> = {}
const inserted = vi.fn()
const updated = vi.fn()
vi.mock('@/lib/access', () => ({
	requireUser: async () => caller,
	singleTenantBlocks: (id: string) => (id === 'blocked' ? Response.json({ error: 'single_tenant' }, { status: 403 }) : null),
}))
vi.mock('@/lib/db', () => ({
	and: () => 0, eq: () => 0, isNull: () => 0,
	createId: () => 'tok_1', prefixes: {}, userApiTokens: {},
	db: {
		insert: () => ({ values: async (v: unknown) => inserted(v) }),
		update: () => ({ set: (v: unknown) => ({ where: () => ({ returning: async () => {
		updated(v)
		return [{ id: 'tok_1' }]
	} }) }) }),
	},
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/auth', () => ({
	githubOAuthConfigured: false,
	auth: { api: { getSession: async () => ({ user: { id: 'blocked' } }) } },
}))
vi.mock('@/lib/integrations', () => ({
	deleteGithubIntegration: vi.fn(),
	getGithubIntegrationDisplay: vi.fn(),
	setGithubPat: vi.fn(),
}))

import { DELETE, POST } from '../../app/api/tokens/route'
import * as gh from '../../app/api/integrations/github/route'
import { config } from '../../proxy'
import { scopesWithinCaller } from '../token-scopes'

const post = (body: unknown) =>
	POST(new Request('http://x/api/tokens', { method: 'POST', body: JSON.stringify(body) }))

describe('token minting', () => {
	beforeEach(() => {
		inserted.mockReset()
		updated.mockReset()
	})
	it('scoped bearer token cannot mint', async () => {
		caller = { id: 'u', viaToken: true, tokenScopes: ['POST /api/**'] }
		expect((await post({})).status).toBe(403)
		expect(inserted).not.toHaveBeenCalled()
	})
	it('session can mint', async () => {
		caller = { id: 'u' }
		expect((await post({ scopes: ['GET /api/x'] })).status).toBe(200)
		expect(inserted).toHaveBeenCalled()
	})
	it('subset rule', () => {
		expect(scopesWithinCaller(['GET /a'], null)).toBe(true)
		expect(scopesWithinCaller(null, ['GET /a'])).toBe(false)
		expect(scopesWithinCaller(['GET /b'], ['GET /a'])).toBe(false)
		expect(scopesWithinCaller(['GET /a'], ['GET /a'])).toBe(true)
	})
})

describe('token revoke', () => {
	it('scoped token cannot revoke', async () => {
		caller = { id: 'u', viaToken: true, tokenScopes: ['DELETE /api/tokens'] }
		const r = await DELETE(new Request('http://x/api/tokens?id=tok_1', { method: 'DELETE' }))
		expect(r.status).toBe(403)
		expect(updated).not.toHaveBeenCalled()
	})
	it('session revokes own token by setting revokedAt', async () => {
		caller = { id: 'u' }
		const r = await DELETE(new Request('http://x/api/tokens?id=tok_1', { method: 'DELETE' }))
		expect(r.status).toBe(200)
		expect(updated.mock.calls[0]?.[0]).toHaveProperty('revokedAt')
	})
	it('missing id -> 400', async () => {
		caller = { id: 'u' }
		const r = await DELETE(new Request('http://x/api/tokens', { method: 'DELETE' }))
		expect(r.status).toBe(400)
	})
})

describe('github integration single-tenant gate', () => {
	it('POST and DELETE are blocked for a non-admin', async () => {
		const p = await gh.POST(new Request('http://x', { method: 'POST', body: '{"token":"t"}' }))
		const d = await gh.DELETE()
		expect(p.status).toBe(403)
		expect(d.status).toBe(403)
	})
})

describe('proxy matcher and temp passwords', () => {
	it('proxy matcher covers every path', () => {
		expect(config.matcher).toEqual(['/:path*'])
	})
	it('temp password does not use Math.random', () => {
		const src = readFileSync(join(__dirname, '../../app/api/admin/users/route.ts'), 'utf8')
		expect(src).not.toContain('Math.random')
	})
})
