import { describe, expect, it } from 'vitest'
import { isRoutedDomain } from '../app-hosts'
import { CHECK_STALE_MS, checkIsStale, lastCheckGreen } from '../server-bootstrap-run'

const now = Date.parse('2026-11-11T12:00:00Z')
const srv = (lastCheck: { green: boolean; proxy: 'nginx' | 'traefik'; at: Date } | null) => ({
	id: `never-cached-${Math.random()}`,
	proxy: 'traefik' as const,
	lastCheck,
})

describe('persisted server check', () => {
	it('a persisted result counts after a restart (empty in-process cache)', () => {
		expect(lastCheckGreen(srv({ green: true, proxy: 'traefik', at: new Date(now) }))).toBe(true)
		expect(lastCheckGreen(srv({ green: false, proxy: 'traefik', at: new Date(now) }))).toBe(false)
	})
	it('never checked, or checked under another proxy, is unknown', () => {
		expect(lastCheckGreen(srv(null))).toBeNull()
		expect(lastCheckGreen(srv({ green: true, proxy: 'nginx', at: new Date(now) }))).toBeNull()
	})
	it('stale after a day, or when never checked or the proxy changed', () => {
		const fresh = srv({ green: true, proxy: 'traefik', at: new Date(now - 1000) })
		const old = srv({ green: true, proxy: 'traefik', at: new Date(now - CHECK_STALE_MS - 1) })
		expect(checkIsStale(fresh, now)).toBe(false)
		expect(checkIsStale(old, now)).toBe(true)
		expect(checkIsStale(srv(null), now)).toBe(true)
		expect(checkIsStale(srv({ green: true, proxy: 'nginx', at: new Date(now) }), now)).toBe(true)
	})
})

describe('isRoutedDomain', () => {
	it('only live rows on the app itself are routed', () => {
		expect(isRoutedDomain({ status: 'live', previewDeployId: null })).toBe(true)
		expect(isRoutedDomain({ status: 'live', previewDeployId: 'pd_1' })).toBe(false)
		for (const status of ['pending', 'verified', 'verify_failed', 'apply_failed']) {
			expect(isRoutedDomain({ status, previewDeployId: null }), status).toBe(false)
		}
	})
})
