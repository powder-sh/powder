// "Found nothing" must not look like "has nothing": a powder app with a live domain
// whose container discovery found no URL for shows the recorded domains, marked, and
// the servers list counts such apps (liveAppsWithoutUrl).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countLiveAppsWithoutUrl, liveHostsByApp, rowUrls } from '../server-url-gaps'

describe('rowUrls', () => {
	it('discovered URLs win and are shown as found', () => {
		expect(rowUrls({ discovered: ['https://a.example.com'], isApp: true, liveHosts: ['b.example.com'] })).toEqual({
			urls: ['https://a.example.com'],
			urlSource: 'proxy',
		})
	})
	it('a powder app with live domains and nothing discovered shows its domains, marked', () => {
		expect(rowUrls({ discovered: [], isApp: true, liveHosts: ['B.example.com', 'a.example.com', 'b.example.com'] })).toEqual({
			urls: ['https://a.example.com', 'https://b.example.com'],
			urlSource: 'app-domains',
		})
	})
	it('no app row, or no live domain: the dash', () => {
		expect(rowUrls({ discovered: [], isApp: false, liveHosts: ['a.example.com'] })).toEqual({ urls: [], urlSource: 'none' })
		expect(rowUrls({ discovered: [], isApp: true, liveHosts: [] })).toEqual({ urls: [], urlSource: 'none' })
	})
})

describe('liveHostsByApp', () => {
	it('keeps routed rows only (live, not a preview)', () => {
		const m = liveHostsByApp([
			{ appRepoId: 'r1', hostname: 'a.example.com', status: 'live', previewDeployId: null },
			{ appRepoId: 'r1', hostname: 'p.example.com', status: 'live', previewDeployId: 'pd1' },
			{ appRepoId: 'r1', hostname: 'q.example.com', status: 'pending', previewDeployId: null },
			{ appRepoId: 'r2', hostname: 'c.example.com', status: 'live', previewDeployId: null },
		])
		expect(Object.fromEntries(m)).toEqual({ r1: ['a.example.com'], r2: ['c.example.com'] })
	})
})

describe('countLiveAppsWithoutUrl', () => {
	it('counts the rows that fell back to the domain record', () => {
		expect(
			countLiveAppsWithoutUrl([
				{ urlSource: 'proxy' },
				{ urlSource: 'app-domains' },
				{ urlSource: 'none' },
				{ urlSource: 'app-domains' },
			]),
		).toBe(2)
		expect(countLiveAppsWithoutUrl([])).toBe(0)
	})
	it('the servers list returns it per server and in total, and never persists the fallback URLs', () => {
		const src = readFileSync(join(__dirname, '../server-list.ts'), 'utf8')
		expect(src).toContain('liveAppsWithoutUrl: countLiveAppsWithoutUrl(containersWithUrls)')
		expect(src).toContain('liveAppsWithoutUrl: results.reduce((n, s) => n + s.liveAppsWithoutUrl, 0)')
		// persistDiscoveredDomains reads persistUrls, built from discovery before the fallback
		expect(src).toContain('const persistable = [...urls]')
		expect(src).toContain('persistUrls: dedupeWwwVariants(persistable)')
	})
	it('a host config skipped for app space reaches the page', () => {
		const src = readFileSync(join(__dirname, '../server-list.ts'), 'utf8')
		expect(src).toContain("nginxRoutes.hostSkipped === 'app-space' || nginxRoutes.hostSkipped === 'unverifiable'")
		expect(src).toContain('proxyConfigTooLarge: nginxRoutes.tooLarge === true')
		const page = readFileSync(join(__dirname, '../../app/(dashboard)/servers/page.tsx'), 'utf8')
		expect(page).toContain("server.hostProxyConfig === 'app-space'")
		expect(page).toContain('host proxy config includes files from app space; routes not read')
		expect(page).toContain('host proxy config names a file that could not be checked; routes not read')
		expect(page).toContain('proxy config too large; some routes not read')
	})
})
