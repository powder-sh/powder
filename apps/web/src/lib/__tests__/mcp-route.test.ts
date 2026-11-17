// /api/mcp transport + auth gate. requireUser is mocked here (its token
// checks are covered in mcp-auth.test.ts); this file checks what the route
// does with each outcome, and that a session cookie alone never gets in.
import { beforeEach, describe, expect, it, vi } from 'vitest'

let current: unknown = null
const requireUser = vi.fn(async () => current)
vi.mock('@/lib/access', () => ({ requireUser: () => requireUser() }))
const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
vi.mock('@/lib/mcp/tools', () => ({
	listTools: () => [],
	callTool: (...a: unknown[]) => callTool(...(a as [])),
}))

import { DELETE, GET, POST } from '../../app/api/mcp/route'

let n = 0
function post(body: unknown, headers: Record<string, string> = {}) {
	return POST(
		new Request('https://dash.example/api/mcp', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-real-ip': `10.0.0.${n++ % 250}`,
				...headers,
			},
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
	)
}
const bearer = { authorization: 'Bearer pwd_abc' }
const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }

beforeEach(() => {
	requireUser.mockClear()
	callTool.mockClear()
	current = { id: 'u1', viaToken: true, tokenId: `tok_${n}`, tokenScopes: null }
	vi.stubEnv('BETTER_AUTH_URL', 'https://dash.example')
})

describe('/api/mcp auth', () => {
	it('no token -> 401 and requireUser is never asked (session cookie ignored)', async () => {
		const r = await post(ping, { cookie: 'better-auth.session_token=abc' })
		expect(r.status).toBe(401)
		expect(r.headers.get('www-authenticate')).toContain('Bearer')
		expect(requireUser).not.toHaveBeenCalled()
	})
	it('empty bearer -> 401', async () => {
		expect((await post(ping, { authorization: 'Bearer ' })).status).toBe(401)
	})
	it('bad, revoked, expired or out-of-scope token (requireUser 401) -> 401', async () => {
		current = Response.json({ error: 'unauthorized' }, { status: 401 })
		const r = await post(ping, bearer)
		expect(r.status).toBe(401)
		const body = await r.json()
		expect(body.error.message).toMatch(/invalid, revoked or expired/)
	})
	it('non-admin (single tenant) -> 403', async () => {
		current = Response.json({ error: 'single_tenant' }, { status: 403 })
		expect((await post(ping, bearer)).status).toBe(403)
	})
	it('a session user (not via token) is refused even if requireUser passes', async () => {
		current = { id: 'u1' }
		expect((await post(ping, bearer)).status).toBe(401)
	})
	it('valid token -> ping answers', async () => {
		const r = await post(ping, bearer)
		expect(r.status).toBe(200)
		expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})
})

describe('/api/mcp transport', () => {
	it('GET and DELETE are 405 with Allow: POST', async () => {
		for (const r of [await GET(), await DELETE()]) {
			expect(r.status).toBe(405)
			expect(r.headers.get('allow')).toBe('POST')
		}
	})
	it('foreign Origin -> 403, dashboard Origin passes', async () => {
		expect((await post(ping, { ...bearer, origin: 'https://evil.example' })).status).toBe(403)
		expect((await post(ping, { ...bearer, origin: 'https://dash.example' })).status).toBe(200)
	})
	it('non-JSON -> 400 parse error; batch -> 400 invalid request', async () => {
		const p = await post('{nope', bearer)
		expect(p.status).toBe(400)
		expect((await p.json()).error.code).toBe(-32700)
		const b = await post([ping], bearer)
		expect(b.status).toBe(400)
		expect((await b.json()).error.code).toBe(-32600)
	})
	it('notification -> 202 with no body', async () => {
		const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, bearer)
		expect(r.status).toBe(202)
		expect(await r.text()).toBe('')
	})
	it('oversized body -> 413', async () => {
		const r = await post(
			{ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(300 * 1024) },
			bearer,
		)
		expect(r.status).toBe(413)
	})
	it('tools/call reaches the tool layer with the authenticated user', async () => {
		const r = await post(
			{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_apps', arguments: {} } },
			bearer,
		)
		expect(r.status).toBe(200)
		expect(callTool).toHaveBeenCalledTimes(1)
		const [, , ctx] = callTool.mock.calls[0] as unknown as [
			string,
			unknown,
			{ user: { id: string }; origin: string },
		]
		expect(ctx.user.id).toBe('u1')
		expect(ctx.origin).toBe('https://dash.example')
	})
	it('per-token rate limit -> 429 with Retry-After', async () => {
		current = { id: 'u1', viaToken: true, tokenId: 'tok_ratelimit', tokenScopes: null }
		let last: Response | null = null
		for (let i = 0; i < 121; i++) last = await post(ping, bearer)
		expect(last?.status).toBe(429)
		expect(last?.headers.get('retry-after')).toBeTruthy()
	})
})
