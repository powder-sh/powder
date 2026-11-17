// HTTP crons and uptime probes check the address they connect to (no loopback,
// link-local or private), like the notification webhook guard.
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appTargetBlocked, guardedAppFetch, type LookupFn } from '../notify-url-guard'

describe('appTargetBlocked', () => {
	it('blocks loopback, link-local, 0/8, RFC 1918 and unique-local', () => {
		for (const ip of [
			'127.0.0.1',
			'169.254.169.254',
			'0.0.0.0',
			'10.1.2.3',
			'172.17.0.2',
			'172.31.255.255',
			'192.168.1.1',
			'::1',
			'fe80::1',
			'fd00::1',
			'fc00::1',
			'::ffff:10.0.0.1',
			'::ffff:ac11:2',
		])
			expect(appTargetBlocked(ip), ip).toBe(true)
	})
	it('passes public addresses', () => {
		for (const ip of ['8.8.8.8', '104.16.1.1', '172.15.0.1', '172.32.0.1', '2606:4700::1'])
			expect(appTargetBlocked(ip), ip).toBe(false)
	})
	it('passes the Tailscale ranges (100.64/10 and fd7a:115c:a1e0::/48), blocks other unique-local', () => {
		// Synthetic addresses, built in code: no literal tailnet address in the tree.
		const cgnat = [100, 64, 0, 1].join('.')
		const cgnatTop = [100, 127, 255, 254].join('.')
		const ts6 = ['fd7a', '115c', 'a1e0', '', '1'].join(':')
		const ts6long = ['fd7a', '115c', 'a1e0', '0', '0', '0', '0', '2'].join(':')
		for (const ip of [cgnat, cgnatTop, ts6, ts6long]) expect(appTargetBlocked(ip), ip).toBe(false)
		for (const ip of [['fd7a', '115c', 'a1e1', '', '1'].join(':'), 'fd00::1'])
			expect(appTargetBlocked(ip), ip).toBe(true)
	})
})

describe('guardedAppFetch', () => {
	let server: Server
	let port = 0
	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url === '/redirect') {
				res.writeHead(302, { location: 'http://169.254.169.254/' })
				return res.end()
			}
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end(`${req.method} ${req.headers.authorization ?? ''}`)
		})
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
		port = (server.address() as AddressInfo).port
	})
	afterAll(() => new Promise<void>((r) => server.close(() => r())))
	// a public-looking name that resolves to the local test server
	const toLocal: LookupFn = (_h, opts, cb) =>
		(opts as { all?: boolean }).all
			? cb(null, [{ address: '127.0.0.1', family: 4 }])
			: cb(null, '127.0.0.1', 4)

	it('refuses a name that resolves to loopback at connect time', async () => {
		await expect(
			guardedAppFetch(`http://app.example.com:${port}/`, { redirect: 'manual', lookup: toLocal }),
		).rejects.toThrow(/blocked address/)
	})
	it('refuses a private IP literal without connecting', async () => {
		await expect(guardedAppFetch('http://10.0.0.1/', { redirect: 'manual' })).rejects.toThrow(
			/private address/,
		)
	})
	it('returns a Response (method, headers, body) when the address is allowed', async () => {
		const res = await guardedAppFetch(`http://app.example.com:${port}/`, {
			method: 'POST',
			headers: { Authorization: 'Bearer t' },
			redirect: 'manual',
			lookup: toLocal,
			blocked: () => false,
		})
		expect(res.status).toBe(200)
		expect(res.ok).toBe(true)
		expect(await res.text()).toBe('POST Bearer t')
	})
	it('does not follow a redirect', async () => {
		const res = await guardedAppFetch(`http://app.example.com:${port}/redirect`, {
			redirect: 'manual',
			lookup: toLocal,
			blocked: () => false,
		})
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe('http://169.254.169.254/')
	})
	it('crons and uptime use it', () => {
		const dir = join(__dirname, '..')
		expect(readFileSync(join(dir, 'cron-scheduler.ts'), 'utf8')).toContain(
			'await guardedAppFetch(url, {',
		)
		expect(readFileSync(join(dir, 'uptime.ts'), 'utf8')).toContain('await guardedAppFetch(url, {')
		expect(readFileSync(join(dir, 'uptime.ts'), 'utf8')).not.toMatch(/await fetch\(url/)
	})
})
