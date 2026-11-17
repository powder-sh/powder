import { describe, expect, it } from 'vitest'
import { hostOf, isOfflineHost } from './no-live-network'

describe('no live network in tests', () => {
	it('lets loopback and reserved test names through', () => {
		for (const h of [
			'localhost',
			'127.0.0.1',
			'[::1]',
			'::1',
			'0:0:0:0:0:0:0:1',
			'::ffff:127.0.0.1',
			'hook.test',
			'dash.example',
			'example.invalid',
			'deploy.example.com',
			'app.localhost',
		]) {
			expect(isOfflineHost(h), h).toBe(true)
		}
	})

	it('treats every public host as live', () => {
		for (const h of [
			'github.com',
			'api.github.com',
			'powder.sh',
			'x.com',
			'169.254.169.254',
			'203.0.113.5',
			'example.com.evil.io',
			'hq',
			'x',
			'printer.local',
			'db.internal',
			'::ffff:192.0.2.1',
			'2001:db8::1',
		]) {
			expect(isOfflineHost(h), h).toBe(false)
		}
	})

	it('reads the host of an http.request options object', () => {
		expect(hostOf({ host: '::1', port: 80 })).toBe('::1')
		expect(isOfflineHost(hostOf({ host: '::1' }) ?? '')).toBe(true)
		expect(hostOf({ host: 'api.github.com:443' })).toBe('api.github.com')
		expect(hostOf({ hostname: 'hook.test', host: 'ignored' })).toBe('hook.test')
		expect(hostOf({})).toBe('localhost')
	})

	it('refuses a real fetch to a public host without touching the network', async () => {
		await expect(
			fetch('https://ops-hub.invalid-tld-for-test.io/api/ingest/cron', { method: 'POST' }),
		).rejects.toThrow(/live host/)
		// the guard would fail this test in afterEach; take the recorded attempt back out
		const mod = await import('./no-live-network')
		mod.takeAttemptsForTest()
	})
})
