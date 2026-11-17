import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../notifications', () => ({ notifyAppDown: async () => ({ notified: false }), notifyAppUp: async () => ({ notified: false }) }))

import { needsDownNotice, needsUpNotice, resolveUrl } from '../uptime'

const t = (s: number) => new Date(1_700_000_000_000 + s * 1000)

describe('needsDownNotice', () => {
	it('up: never', () => {
		expect(needsDownNotice({ isUp: true, lastDownAt: null, lastNotifiedAt: null })).toBe(false)
	})
	it('down and never notified: yes, on the transition tick and on every later tick until it lands', () => {
		expect(needsDownNotice({ isUp: false, lastDownAt: t(0), lastNotifiedAt: null })).toBe(true)
		expect(needsDownNotice({ isUp: false, lastDownAt: t(0), lastNotifiedAt: null })).toBe(true)
	})
	it('down and already notified for this outage: no', () => {
		expect(needsDownNotice({ isUp: false, lastDownAt: t(0), lastNotifiedAt: t(0) })).toBe(false)
		expect(needsDownNotice({ isUp: false, lastDownAt: t(0), lastNotifiedAt: t(60) })).toBe(false)
	})
	it('a new outage after a recovery needs a new notice', () => {
		expect(needsDownNotice({ isUp: false, lastDownAt: t(600), lastNotifiedAt: t(0) })).toBe(true)
	})
})

describe('resolveUrl', () => {
	const srv = { id: 's1', baseDomain: 'apps.example.com' }
	const repo = (healthUrl: string | null) => ({ containerName: 'web', healthUrl })
	it('path health_url joins the live hostname', () => {
		expect(resolveUrl(repo('/api/health'), 'x.com', srv)).toBe('https://x.com/api/health')
		expect(resolveUrl(repo('/'), 'x.com', srv)).toBe('https://x.com/')
	})
	it('path health_url without hostname uses the server default host', () => {
		expect(resolveUrl(repo('/api/health'), null, srv)).toBe('https://web.apps.example.com/api/health')
	})
	it('path health_url with no host at all: null', () => {
		expect(resolveUrl(repo('/api/health'), null, { id: 's1', baseDomain: null })).toBeNull()
	})
	it('absolute URL unchanged', () => {
		expect(resolveUrl(repo('https://y.com/h?x=1'), 'x.com', srv)).toBe('https://y.com/h?x=1')
		expect(resolveUrl(repo('http://127.0.0.1:3000/h'), null, srv)).toBe('http://127.0.0.1:3000/h')
	})
	it('relative garbage is treated as a path', () => {
		expect(resolveUrl(repo('api/health'), 'x.com', srv)).toBe('https://x.com/api/health')
		expect(resolveUrl(repo('ftp://z'), 'x.com', srv)).toBe('https://x.com/ftp://z')
	})
	it('no health_url: live hostname root, else default host', () => {
		expect(resolveUrl(repo(null), 'x.com', srv)).toBe('https://x.com/')
		expect(resolveUrl(repo(null), null, srv)).toBe('https://web.apps.example.com/')
	})
})

describe('needsUpNotice', () => {
	it('recovery after an alerted outage: yes', () => {
		expect(needsUpNotice({ isUp: false, lastDownAt: t(0), lastNotifiedAt: t(5) }, true)).toBe(true)
	})
	it('recovery without an alert, still down, or already up: no', () => {
		expect(needsUpNotice({ isUp: false, lastDownAt: t(10), lastNotifiedAt: t(0) }, true)).toBe(false)
		expect(needsUpNotice({ isUp: false, lastDownAt: t(0), lastNotifiedAt: null }, true)).toBe(false)
		expect(needsUpNotice({ isUp: false, lastDownAt: t(0), lastNotifiedAt: t(5) }, false)).toBe(false)
		expect(needsUpNotice({ isUp: true, lastDownAt: null, lastNotifiedAt: t(5) }, true)).toBe(false)
		expect(needsUpNotice(null, true)).toBe(false)
	})
})
