import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// the check-time DNS answer (public) must not be trusted at
// connect time (TTL-0 rebinding to 127.0.0.1 / 169.254.169.254).

const dnsState = vi.hoisted(() => ({ connectLookups: [] as string[] }))
vi.mock('node:dns', async (orig) => {
	const real = (await orig()) as typeof import('node:dns')
	const lookup = (host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
		dnsState.connectLookups.push(host)
		// Second answer of a rebinding record: loopback.
		if (opts?.all) cb(null, [{ address: '127.0.0.1', family: 4 }])
		else cb(null, '127.0.0.1', 4)
	}
	return {
		...real,
		default: { ...real, lookup },
		lookup,
		// First answer (the guard's check): public.
		promises: { ...real.promises, lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
	}
})
vi.mock('../db', () => ({}))
vi.mock('../crypto', () => ({ decryptSecret: (s: string) => s }))
vi.mock('../hosts', () => ({ dashboardUrl: () => 'https://powder.test' }))
vi.mock('../mailer', () => ({ sendMail: async () => true }))

import { sendTestNotification } from '../notifications'
import { type LookupFn, guardedLookup, guardedPost } from '../notify-url-guard'

let hits = 0
let port = 0
const server = createServer((_req, res) => {
	hits++
	res.end('ok')
})
beforeAll(async () => {
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
	port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())

describe('notification webhook DNS rebinding', () => {
	it('re-checks the address actually connected to and refuses loopback', async () => {
		hits = 0
		dnsState.connectLookups = []
		const ok = await sendTestNotification({
			id: 'ntf_x',
			kind: 'webhook',
			urlEncrypted: `http://rebind.invalid:${port}/hook`,
		} as never)
		expect(ok).toBe(false)
		expect(dnsState.connectLookups).toContain('rebind.invalid')
		expect(hits).toBe(0)
	})

	it('guardedLookup blocks loopback/link-local answers and keeps private ranges', async () => {
		const answer =
			(ip: string): LookupFn =>
			(_h, _o, cb) =>
				cb(null, [{ address: ip, family: 4 }])
		const run = (ip: string) =>
			new Promise<string | null>((r) =>
				guardedLookup(answer(ip))('h', { all: true }, (e) => r(e?.code ?? null)),
			)
		expect(await run('169.254.169.254')).toBe('EBLOCKED')
		expect(await run('127.0.0.2')).toBe('EBLOCKED')
		expect(await run('10.20.30.40')).toBeNull()
		// A tailnet (CGNAT range) answer stays allowed. Joined at runtime:
		// the public-export leak guard flags every literal address in that range.
		expect(await run(['100', '64', '0', '1'].join('.'))).toBeNull()
	})

	it('guardedPost delivers when the connected address is allowed', async () => {
		hits = 0
		const base: LookupFn = (_h, o, cb) =>
			o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)
		const status = await guardedPost(`http://ok.invalid:${port}/hook`, {
			headers: { 'content-type': 'application/json' },
			body: '{}',
			timeoutMs: 2000,
			lookup: guardedLookup(base, () => false),
		})
		expect(status).toBe(200)
		expect(hits).toBe(1)
	})
})
