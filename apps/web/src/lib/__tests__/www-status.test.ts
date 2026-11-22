// The www check on the domains tab: which rows get one, how a probe outcome is
// classified, and the line shown. Cases: redirect to the apex, 200 on www, HTTP 520,
// 404, redirect to another host, no DNS record, TLS / connect failure. Invented names only.
import { describe, expect, it } from 'vitest'
import { classifyWwwProbe, wwwSibling, wwwStatusLine } from '../www-status'

const APEX = 'example.com'
const WWW = 'www.example.com'

function line(outcome: Parameters<typeof classifyWwwProbe>[0], hostname = APEX, sibling = WWW) {
	return wwwStatusLine({ sibling, status: classifyWwwProbe(outcome, hostname, sibling) })
}

describe('wwwSibling', () => {
	it('an apex gets www, a www host gets its apex, other subdomains get nothing', () => {
		expect(wwwSibling('example.com')).toBe('www.example.com')
		expect(wwwSibling('Example.COM.')).toBe('www.example.com')
		expect(wwwSibling('www.example.com')).toBe('example.com')
		expect(wwwSibling('app.example.com')).toBeNull()
		expect(wwwSibling('www.app.example.com')).toBeNull()
		expect(wwwSibling('localhost')).toBeNull()
		expect(wwwSibling('www.localhost')).toBeNull()
		expect(wwwSibling('')).toBeNull()
		expect(wwwSibling('example.com:8080')).toBeNull()
	})
})

describe('classifyWwwProbe', () => {
	it('1. a redirect to the apex: fine', () => {
		expect(classifyWwwProbe({ status: 301, location: 'https://example.com/' }, APEX, WWW)).toEqual({
			kind: 'redirects_here',
		})
		// scheme, path, case and a trailing dot do not matter
		expect(
			classifyWwwProbe({ status: 308, location: 'http://EXAMPLE.com./a?b=1' }, APEX, WWW).kind,
		).toBe('redirects_here')
		expect(line({ status: 301, location: 'https://example.com/' })).toEqual({
			text: 'www.example.com redirects here',
			tone: 'success',
		})
	})

	it('2. a page on www (200): served twice, no redirect', () => {
		expect(classifyWwwProbe({ status: 200, location: null }, APEX, WWW)).toEqual({ kind: 'serves' })
		// a redirect that stays on www (to a path) is the same thing
		expect(classifyWwwProbe({ status: 302, location: '/en/' }, APEX, WWW).kind).toBe('serves')
		expect(line({ status: 200, location: null })).toEqual({
			text: 'www.example.com does not redirect here',
			tone: 'warning',
		})
		expect(line({ status: 302, location: '/en/' }).text).toBe('www.example.com does not redirect here')
	})

	it('3. HTTP 520: broken', () => {
		expect(classifyWwwProbe({ status: 520, location: null }, APEX, WWW)).toEqual({
			kind: 'broken',
			status: 520,
		})
		expect(line({ status: 520, location: null })).toEqual({
			text: 'www.example.com is broken: HTTP 520',
			tone: 'destructive',
		})
	})

	it('4. HTTP 404: broken', () => {
		expect(line({ status: 404, location: null })).toEqual({
			text: 'www.example.com is broken: HTTP 404',
			tone: 'destructive',
		})
		// a 3xx without a Location, or with one that names no host, goes nowhere
		expect(classifyWwwProbe({ status: 301, location: null }, APEX, WWW)).toEqual({
			kind: 'broken',
			status: 301,
		})
		for (const location of ['', 'javascript:alert(1)', 'mailto:a@example.com', 'data:text/plain,x'])
			expect(classifyWwwProbe({ status: 302, location }, APEX, WWW), location).toEqual({
				kind: 'broken',
				status: 302,
			})
		expect(line({ status: 302, location: 'mailto:a@example.com' }).text).toBe(
			'www.example.com is broken: HTTP 302',
		)
	})

	it('5. a redirect to a different host', () => {
		expect(
			classifyWwwProbe({ status: 301, location: 'https://other.example.org/x' }, APEX, WWW),
		).toEqual({ kind: 'redirects_elsewhere', to: 'other.example.org' })
		expect(line({ status: 301, location: 'https://other.example.org/x' })).toEqual({
			text: 'www.example.com redirects to other.example.org',
			tone: 'warning',
		})
	})

	it('6. no DNS record for www', () => {
		for (const code of ['ENOTFOUND', 'ENODATA'])
			expect(classifyWwwProbe({ error: code }, APEX, WWW)).toEqual({ kind: 'no_dns' })
		expect(line({ error: 'ENOTFOUND' })).toEqual({
			text: 'www.example.com has no DNS record',
			tone: 'warning',
		})
	})

	it('7. a TLS or connection failure', () => {
		for (const code of [
			'ERR_TLS_CERT_ALTNAME_INVALID',
			'CERT_HAS_EXPIRED',
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			'EPROTO',
		])
			expect(classifyWwwProbe({ error: code }, APEX, WWW), code).toEqual({
				kind: 'unreachable',
				reason: 'tls',
			})
		expect(classifyWwwProbe({ error: 'ECONNREFUSED' }, APEX, WWW)).toEqual({
			kind: 'unreachable',
			reason: 'connection',
		})
		expect(classifyWwwProbe({ error: 'ABORT_ERR' }, APEX, WWW)).toEqual({
			kind: 'unreachable',
			reason: 'timeout',
		})
		expect(line({ error: 'CERT_HAS_EXPIRED' })).toEqual({
			text: 'www.example.com is broken: TLS error',
			tone: 'destructive',
		})
		expect(line({ error: 'ECONNRESET' }).text).toBe('www.example.com is broken: connection error')
		expect(line({ error: 'ABORT_ERR' }).text).toBe('www.example.com is broken: no answer within 5 s')
	})

	it('a private address is refused, an unknown failure is "could not check"', () => {
		expect(line({ error: 'EBLOCKED' })).toEqual({
			text: 'www.example.com points at a private address, powder does not check it',
			tone: 'neutral',
		})
		expect(line({ error: 'UNKNOWN' })).toEqual({
			text: 'could not check www.example.com',
			tone: 'neutral',
		})
	})

	it('a www row checks its apex the same way', () => {
		expect(line({ status: 301, location: 'https://www.example.com/' }, WWW, APEX)).toEqual({
			text: 'example.com redirects here',
			tone: 'success',
		})
		expect(line({ error: 'ENOTFOUND' }, WWW, APEX).text).toBe('example.com has no DNS record')
	})
})
