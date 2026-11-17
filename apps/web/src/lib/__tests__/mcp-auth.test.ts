// Token auth as /api/mcp sees it: getCurrentUser with the method+path the
// proxy stamps ("POST /api/mcp"). Covers bad, revoked, expired and
// out-of-scope tokens, plus the scope presets the tokens page offers.
import { beforeEach, describe, expect, it, vi } from 'vitest'

let hdrs = new Headers()
let rows: unknown[] = []
const isNullCols: unknown[] = []
vi.mock('next/headers', () => ({ headers: async () => hdrs }))
vi.mock('../auth', () => ({
	auth: { api: { getSession: async () => ({ user: { id: 'sess', email: 'e', name: 'n' } }) } },
}))
vi.mock('../admin-ids', () => ({ isAdminUserId: () => true }))
vi.mock('../db', () => {
	const chain = () => {
		const c: Record<string, unknown> = {}
		for (const k of ['from', 'where', 'innerJoin']) c[k] = () => c
		c.limit = async () => rows
		return c
	}
	return {
		and: () => 0,
		eq: () => 0,
		isNull: (col: unknown) => {
			isNullCols.push(col)
			return 0
		},
		appRepos: {},
		previewDeploys: {},
		user: { id: 'user.id' },
		userApiTokens: { revokedAt: 'user_api_tokens.revoked_at' },
		db: {
			select: () => chain(),
			update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
		},
	}
})

import { getCurrentUser } from '../access'
import { MCP_READ_SCOPES, MCP_WRITE_SCOPES, isValidScope, tokenAllows } from '../token-scopes'

const row = (over: Record<string, unknown> = {}) => ({
	tokenId: 'tok_1',
	userId: 'u1',
	email: 'e',
	name: 'n',
	scopes: null,
	expiresAt: null,
	...over,
})

function mcpRequest(auth?: string) {
	hdrs = new Headers({
		'x-powder-request': 'POST /api/mcp',
		...(auth ? { authorization: auth } : {}),
	})
}

beforeEach(() => {
	rows = []
	isNullCols.length = 0
})

describe('MCP bearer auth (getCurrentUser)', () => {
	it('unknown token -> null, never falls back to the session', async () => {
		mcpRequest('Bearer pwd_nope')
		expect(await getCurrentUser()).toBeNull()
	})
	it('revoked tokens are filtered in the query (revoked_at IS NULL)', async () => {
		mcpRequest('Bearer pwd_x')
		await getCurrentUser()
		expect(isNullCols).toContain('user_api_tokens.revoked_at')
	})
	it('expired token -> null', async () => {
		mcpRequest('Bearer pwd_x')
		rows = [row({ expiresAt: new Date(Date.now() - 1000) })]
		expect(await getCurrentUser()).toBeNull()
	})
	it('scoped token without POST /api/mcp -> null', async () => {
		mcpRequest('Bearer pwd_x')
		rows = [row({ scopes: ['GET /api/projects'] })]
		expect(await getCurrentUser()).toBeNull()
	})
	it('full-access and MCP-preset tokens pass, with their scopes attached', async () => {
		mcpRequest('Bearer pwd_x')
		rows = [row()]
		expect(await getCurrentUser()).toMatchObject({ id: 'u1', viaToken: true, tokenScopes: null })
		rows = [row({ scopes: [...MCP_READ_SCOPES] })]
		expect(await getCurrentUser()).toMatchObject({ viaToken: true, tokenScopes: MCP_READ_SCOPES })
	})
})

describe('MCP scope presets', () => {
	it('are valid scope strings', () => {
		for (const s of MCP_WRITE_SCOPES) expect(isValidScope(s), s).toBe(true)
	})
	it('read preset allows reads and refuses every write route', () => {
		const r = [...MCP_READ_SCOPES]
		expect(tokenAllows(r, 'POST /api/mcp')).toBe(true)
		expect(tokenAllows(r, 'GET /api/projects/rep_1/context')).toBe(true)
		expect(tokenAllows(r, 'GET /api/deploys/dep_1')).toBe(true)
		expect(tokenAllows(r, 'POST /api/projects/rep_1/redeploy')).toBe(false)
		expect(tokenAllows(r, 'PUT /api/projects/rep_1/env')).toBe(false)
		expect(tokenAllows(r, 'DELETE /api/projects/rep_1/env/KEY')).toBe(false)
	})
	it('write preset adds exactly redeploy and env set/delete', () => {
		const w = [...MCP_WRITE_SCOPES]
		expect(tokenAllows(w, 'POST /api/projects/rep_1/redeploy')).toBe(true)
		expect(tokenAllows(w, 'PUT /api/projects/rep_1/env')).toBe(true)
		expect(tokenAllows(w, 'DELETE /api/projects/rep_1/env/KEY')).toBe(true)
		expect(tokenAllows(w, 'POST /api/projects/rep_1/env')).toBe(false)
		expect(tokenAllows(w, 'POST /api/tokens')).toBe(false)
		expect(tokenAllows(w, 'POST /api/servers/s/containers/c/restart')).toBe(false)
	})
})
