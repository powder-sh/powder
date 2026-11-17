import { describe, expect, it } from 'vitest'
import nextConfig from '../../../next.config'

describe('security headers', () => {
	it('every route gets the five headers, and no full CSP', async () => {
		const rules = (await nextConfig.headers?.()) ?? []
		const all = rules.find((r) => r.source === '/:path*')
		if (!all) throw new Error('no /:path* header rule')
		const h = Object.fromEntries(all.headers.map((x) => [x.key, x.value]))
		expect(h['X-Frame-Options']).toBe('DENY')
		expect(h['Content-Security-Policy']).toBe(
			"frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
		)
		expect(h['Content-Security-Policy']).not.toMatch(/script-src|default-src/)
		expect(h['Permissions-Policy']).toMatch(/camera=\(\), microphone=\(\), geolocation=\(\)/)
		expect(h['X-Content-Type-Options']).toBe('nosniff')
		expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
		expect(h['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains')
	})
	it('API answers are no-store, and keep no-transform for the SSE streams', async () => {
		const rules = (await nextConfig.headers?.()) ?? []
		const api = rules.find((r) => r.source === '/api/:path*')
		if (!api) throw new Error('no /api/:path* header rule')
		expect(api.headers).toEqual([{ key: 'Cache-Control', value: 'no-store, no-transform' }])
		// the page rule does not set Cache-Control (Next decides it for pages)
		const all = rules.find((r) => r.source === '/:path*')
		if (!all) throw new Error('no /:path* header rule')
		expect(all.headers.some((x) => x.key.toLowerCase() === 'cache-control')).toBe(false)
	})
	it('no X-Powered-By', () => {
		expect(nextConfig.poweredByHeader).toBe(false)
	})
})
