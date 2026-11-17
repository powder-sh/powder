import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

vi.mock('../db', () => ({}))
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))

import { renderLabelsBlock, rewriteIntroducedUnsafe } from '../app-domains'
import { parsePowderConfig } from '../powder-config'

const PAYLOAD = JSON.stringify({
	redirects: [{ from: '^/old$', to: '/new\n    privileged: true\n    volumes:\n      - /:/host\n    x-pad:' }],
	rewrites: [{ source: 'a\rb', destination: '/x' }],
	headers: { 'X-A': 'v\nprivileged: true' },
})

describe('powder.json newline injection', () => {
	it('yields no new service keys and drops the offending entries', () => {
		const cfg = parsePowderConfig(PAYLOAD)
		const block = renderLabelsBlock({
			containerName: 'app',
			hosts: ['app.example.com'],
			containerPort: 3000,
			redirects: cfg,
		})
		const compose = `services:\n  app:\n    image: x\n${block}`
		const svc = (parse(compose) as { services: { app: Record<string, unknown> } }).services.app
		expect(Object.keys(svc).sort()).toEqual(['image', 'labels'])
		expect(block).not.toContain('privileged')
		expect(block).not.toContain('redir-0')
	})
	it('keeps clean entries', () => {
		const cfg = parsePowderConfig('{"redirects":[{"from":"/a","to":"/b"}]}')
		const block = renderLabelsBlock({ containerName: 'app', hosts: ['a.b'], containerPort: 1, redirects: cfg })
		expect(block).toContain('app-redir-0.redirectregex.regex=/a')
	})
})

describe('compose guard after rewrite', () => {
	const ok = 'services:\n  app:\n    image: x\n'
	it('rejects a rewrite that introduced privileged: true', () => {
		const bad = 'services:\n  app:\n    image: x\n    privileged: true\n'
		expect(rewriteIntroducedUnsafe(bad, ok, 'app')).toContain('privileged')
	})
	it('allows a rewrite of an already out-of-guard compose', () => {
		const bad = 'services:\n  app:\n    image: x\n    privileged: true\n'
		expect(rewriteIntroducedUnsafe(bad, bad, 'app')).toBeNull()
	})
	it('passes a safe rewrite', () => {
		expect(rewriteIntroducedUnsafe(ok, ok, 'app')).toBeNull()
	})
})
