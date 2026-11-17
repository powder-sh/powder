import { describe, expect, it, vi } from 'vitest'

// hostnames from the DB / discovery are re-validated before they
// reach a Traefik Host(`...`) rule.

const state = vi.hoisted(() => ({ inserted: [] as string[], queried: 0 }))
vi.mock('../db', () => {
	const chain = (rows: unknown[]) => ({
		from: () =>
			Object.assign(Promise.resolve(rows), {
				where: () => Object.assign(Promise.resolve([]), { limit: async () => [] }),
			}),
	})
	return {
		db: {
			select: () => {
				state.queried++
				return chain([{ id: 'rep_1', containerName: 'web', hostname: 'Taken.example.com' }])
			},
			insert: () => ({
				values: (v: { hostname: string }) => {
					state.inserted.push(v.hostname)
					return { onConflictDoNothing: async () => undefined }
				},
			}),
			update: () => ({ set: () => ({ where: async () => undefined }) }),
		},
		and: () => null,
		eq: () => null,
		appDomains: {},
		appRepos: {},
		deploys: {},
		desc: () => null,
		sql: () => null,
		createId: () => 'dom_x',
		prefixes: { appDomain: 'dom' },
	}
})
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))

import { applyDomain, isValidHostname, renderLabelsBlock, verifyDomain } from '../app-domains'
import { persistDiscoveredDomains } from '../server-list'

const EVIL = 'a`) || Host(`victim.com'

describe('hostname revalidation', () => {
	it('isValidHostname refuses rule/shell metacharacters and over-long labels', () => {
		for (const h of [
			'a`b.example.com',
			'a$(x).example.com',
			'a&b.example.com',
			"a'b.example.com",
			'a;b.example.com',
			'a"b.example.com',
			EVIL,
			`${'a'.repeat(64)}.com`,
		]) {
			expect(isValidHostname(h)).toBe(false)
		}
		expect(isValidHostname('app.example.com')).toBe(true)
	})
	it('renderLabelsBlock skips an invalid DB hostname instead of rendering it', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const b = renderLabelsBlock({
			containerName: 'web',
			hosts: ['web.apps.example.com', EVIL],
			containerPort: 3000,
			redirects: { redirects: [], rewrites: [], headers: {} },
		})
		expect(b).toContain('rule=Host(`web.apps.example.com`)\n')
		expect(b).not.toContain('victim.com')
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})
	it('keeps an underscore default host (container names may carry one)', () => {
		const b = renderLabelsBlock({
			containerName: 'my_app',
			hosts: ['my_app.apps.example.com'],
			containerPort: 3000,
			redirects: { redirects: [], rewrites: [], headers: {} },
		})
		expect(b).toContain('Host(`my_app.apps.example.com`)')
	})
	it('verifyDomain and applyDomain refuse an invalid hostname before touching the DB', async () => {
		state.queried = 0
		expect(await verifyDomain('rep_1', EVIL)).toEqual({
			verified: false,
			error: 'invalid hostname',
		})
		expect(await applyDomain('rep_1', EVIL)).toEqual({ applied: false, error: 'invalid hostname' })
		expect(state.queried).toBe(0)
	})
	it('discovery inserts only valid hostnames', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		state.inserted = []
		await persistDiscoveredDomains([
			{
				name: 'web',
				repo: null,
				persistUrls: [
					'https://ok.example.com/',
					'http://a`b$(x).example.com/',
					'https://*.wild.example.com/',
				],
			},
		])
		expect(state.inserted).toEqual(['ok.example.com'])
		warn.mockRestore()
	})
	it('discovery never persists Traefik-label-only hosts or a hostname another row holds', async () => {
		state.inserted = []
		await persistDiscoveredDomains([
			// urls = display list (labels included); only persistUrls may be written
			{ name: 'web', repo: null, urls: ['https://label-only.example.com'], persistUrls: [] } as never,
			{ name: 'web', repo: null, persistUrls: ['https://taken.example.com', 'https://free.example.com'] },
		])
		expect(state.inserted).toEqual(['free.example.com'])
	})
})
