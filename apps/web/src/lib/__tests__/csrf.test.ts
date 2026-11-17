import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../../proxy'

const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
	proxy(new NextRequest(`https://powder.sh${path}`, { method: init.method ?? 'POST', headers: { host: 'powder.sh', cookie: 'session=1', ...init.headers } }))

describe('CSRF gate', () => {
	it('cross-origin text/plain POST with a session cookie -> 403', async () => {
		const r = call('/api/tokens', { headers: { origin: 'https://evil.example', 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' } })
		expect(r.status).toBe(403)
		expect(await r.json()).toEqual({ error: 'cross-site request blocked' })
	})
	it('POST with no origin signals -> 403', () => {
		expect(call('/api/tokens').status).toBe(403)
	})
	it('same-origin passes', () => {
		expect(call('/api/tokens', { headers: { 'sec-fetch-site': 'same-origin' } }).status).toBe(200)
		expect(call('/api/tokens', { headers: { origin: 'https://powder.sh' } }).status).toBe(200)
	})
	it('bearer passes', () => {
		// /api/tokens is session-only (lib/session-only.ts); a token route
		expect(call('/api/projects/p1/redeploy', { headers: { authorization: 'Bearer pwd_x', 'sec-fetch-site': 'cross-site' } }).status).toBe(200)
	})
	it('webhook and auth routes pass', () => {
		expect(call('/api/webhooks/deploy/abc', { headers: { 'sec-fetch-site': 'cross-site' } }).status).toBe(200)
		expect(call('/api/auth/sign-in/email', { headers: { 'sec-fetch-site': 'cross-site' } }).status).toBe(200)
	})
	it('Origin: null with a cookie -> 403', () => {
		expect(call('/api/tokens', { headers: { origin: 'null' } }).status).toBe(403)
	})
	it('same-site sibling subdomain Origin -> 403', () => {
		expect(call('/api/tokens', { headers: { origin: 'http://evil.apps.example.com', 'sec-fetch-site': 'same-site' } }).status).toBe(403)
	})
	it('no cookie, no headers: not a CSRF case, passes to the route', () => {
		const r = proxy(new NextRequest('https://powder.sh/api/tokens', { method: 'POST' }))
		expect(r.status).toBe(200)
	})
	it('GET is never blocked', () => {
		expect(call('/api/tokens', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }).status).toBe(200)
	})
})
