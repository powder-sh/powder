import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { proxy } from '../../proxy'

// next/server encodes request-header overrides as x-middleware-request-<name> and lists
// the kept names in x-middleware-override-headers.
const forwarded = (res: Response) => (res.headers.get('x-middleware-override-headers') ?? '').split(',')

describe('/ingest rewrite strips credentials', () => {
	const headers = { cookie: 'session=abc', authorization: 'Bearer x', 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', 'user-agent': 'ua' }
	it('drops cookie, authorization and client IP headers for /ingest/*', () => {
		const res = proxy(new NextRequest('http://localhost/ingest/e', { method: 'POST', headers, body: '{}' }))
		const kept = forwarded(res)
		for (const h of ['cookie', 'authorization', 'x-forwarded-for', 'x-real-ip']) expect(kept).not.toContain(h)
		expect(res.headers.get('x-middleware-request-cookie')).toBeNull()
		expect(kept).toContain('user-agent')
	})
	it('keeps the cookie for normal paths', () => {
		const res = proxy(new NextRequest('http://localhost/api/env-vars', { headers }))
		expect(forwarded(res)).toContain('cookie')
	})
})
