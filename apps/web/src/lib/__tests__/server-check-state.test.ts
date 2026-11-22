import { describe, expect, it } from 'vitest'
import { isRoutedDomain } from '../app-hosts'
import { DYNAMIC_DIR_MISSING } from '../server-bootstrap'
import { CHECK_STALE_MS, checkIsStale, lastCheckGreen, lastCheckResult } from '../server-bootstrap-run'

const now = Date.parse('2026-11-11T12:00:00Z')
const WEB = { id: 'traefik-network', label: 'network web', detail: 'missing: x' }
type Stored = { green: boolean; proxy: 'nginx' | 'traefik'; at: Date; missing?: Array<{ id: string; label: string; detail: string }> | null }
// missing defaults to what a current check saves: [] when green.
const srv = (lastCheck: Stored | null) => ({
	id: `never-cached-${Math.random()}`,
	proxy: 'traefik' as const,
	lastCheck: lastCheck ? { ...lastCheck, missing: lastCheck.missing === undefined ? (lastCheck.green ? [] : [WEB]) : lastCheck.missing } : null,
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
	it('a persisted result carries its missing pieces', () => {
		expect(lastCheckResult(srv({ green: false, proxy: 'traefik', at: new Date(now) }))).toEqual({ green: false, missing: [WEB] })
		expect(lastCheckResult(srv({ green: true, proxy: 'traefik', at: new Date(now) }))).toEqual({ green: true, missing: [] })
	})
	it('a red result saved before check_missing existed counts as not checked and is stale; a green one stays green', () => {
		const oldRed = srv({ green: false, proxy: 'traefik', at: new Date(now), missing: null })
		expect(lastCheckResult(oldRed)).toBeNull()
		expect(lastCheckGreen(oldRed)).toBeNull()
		expect(checkIsStale(oldRed, now)).toBe(true)
		const oldGreen = srv({ green: true, proxy: 'traefik', at: new Date(now), missing: null })
		expect(lastCheckResult(oldGreen)).toEqual({ green: true, missing: [] })
		expect(checkIsStale(oldGreen, now)).toBe(false)
	})
	it('a red result naming a piece only the older rule required counts as not checked and is stale', () => {
		const older = [
			{ id: 'network-web', label: 'network web', detail: 'missing: Traefik and the apps, previews and snapshots it routes run on it' },
			{ id: 'dynamic-dir', label: '/opt/infra/traefik/dynamic', detail: 'missing: powder writes the Traefik rules for domain redirects here' },
			{ id: 'traefik-file-provider', label: 'traefik file provider', detail: 'no watched file provider on /opt/infra/traefik/dynamic (add providers.file.directory + watch and mount it)' },
		]
		for (const m of older) {
			const s = srv({ green: false, proxy: 'traefik', at: new Date(now), missing: [m] })
			expect(lastCheckResult(s), m.id).toBeNull()
			expect(checkIsStale(s, now), m.id).toBe(true)
		}
		// what the current rule saves stays usable
		const current = srv({ green: false, proxy: 'traefik', at: new Date(now), missing: [{ id: 'dynamic-dir', label: '/opt/infra/traefik/dynamic', detail: DYNAMIC_DIR_MISSING }] })
		expect(lastCheckResult(current)?.green).toBe(false)
		expect(checkIsStale(current, now)).toBe(false)
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
