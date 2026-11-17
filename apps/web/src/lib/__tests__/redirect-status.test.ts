import { describe, expect, it, vi } from 'vitest'

vi.mock('../ssh', () => ({ runCommand: vi.fn() }))
vi.mock('../domain-ownership', () => ({ assertHostnamesOwned: vi.fn() }))

import { redirectStatus, renderNginxConfig } from '../domain-redirects'

describe('redirect status', () => {
	it('a string status cannot reach the nginx config', () => {
		const evil = '301; } server { server_name victim.example; location / { proxy_pass http://evil; } } #'
		const conf = renderNginxConfig(
			{
				hostname: 'a.example',
				wwwMode: 'none',
				custom: [{ from: '/x', to: '/y', status: evil as unknown as 301 }],
			},
			null,
		)
		expect(conf).toContain('return 301 "/y";')
		expect(conf).not.toContain('victim.example')
		expect(conf.match(/server\s*\{/g)).toHaveLength(1)
	})
	it('coerces to 301|302 only', () => {
		expect(redirectStatus(302)).toBe(302)
		expect(redirectStatus('302')).toBe(301)
		expect(redirectStatus(undefined)).toBe(301)
		expect(redirectStatus(307)).toBe(301)
	})
	it('escapes $ so nginx does not expand variables', () => {
		const conf = renderNginxConfig(
			{ hostname: 'a.example', wwwMode: 'none', custom: [{ from: '/x', to: 'https://e.com/$http_host' }] },
			null,
		)
		expect(conf).not.toContain('$http_host')
	})
})
