import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { describe, expect, it } from 'vitest'
import { betterAuthIpOptions, clientIpFromHeaders, trustedIpHeader } from '../client-ip'
import { SigninLockout, signinLockoutHooks } from '../signin-lockout'
import { webhookClientIp } from '../webhook-gate'

// configurable client-IP header + per-email sign-in lockout.

const H = (h: Record<string, string>) => new Headers(h)
const spoof = {
	'cf-connecting-ip': '6.6.6.6',
	'x-real-ip': '198.51.100.7',
	'x-forwarded-for': '6.6.6.7, 203.0.113.9',
}

describe('trusted client-IP header', () => {
	it('defaults to x-real-ip (safe without an origin lock) and parses the env', () => {
		expect(trustedIpHeader(undefined)).toBe('x-real-ip')
		expect(trustedIpHeader('')).toBe('x-real-ip')
		expect(trustedIpHeader('bogus')).toBe('x-real-ip')
		// unset: a client-sent cf-connecting-ip does not pick the bucket
		expect(clientIpFromHeaders(H(spoof))).toBe('198.51.100.7')
		expect(trustedIpHeader('cf-connecting-ip')).toBe('cf-connecting-ip')
		expect(trustedIpHeader(' X-Real-IP ')).toBe('x-real-ip')
		expect(trustedIpHeader('x-forwarded-for')).toBe('x-forwarded-for')
		expect(clientIpFromHeaders(H(spoof), 'cf-connecting-ip')).toBe('6.6.6.6')
		expect(betterAuthIpOptions('cf-connecting-ip').ipAddressHeaders[0]).toBe('cf-connecting-ip')
	})
	it('x-real-ip and x-forwarded-for modes ignore a client-sent cf-connecting-ip', () => {
		expect(clientIpFromHeaders(H(spoof), 'x-real-ip')).toBe('198.51.100.7')
		expect(clientIpFromHeaders(H(spoof), 'x-forwarded-for')).toBe('203.0.113.9')
		expect(clientIpFromHeaders(H({ 'cf-connecting-ip': '6.6.6.6' }), 'x-real-ip')).toBe('unknown')
		expect(betterAuthIpOptions('x-real-ip')).toEqual({ ipAddressHeaders: ['x-real-ip'] })
		expect(betterAuthIpOptions('x-forwarded-for').ipAddressHeaders).toEqual(['x-forwarded-for'])
	})
	it('webhookClientIp follows POWDER_TRUSTED_IP_HEADER', () => {
		const prev = process.env.POWDER_TRUSTED_IP_HEADER
		process.env.POWDER_TRUSTED_IP_HEADER = 'x-real-ip'
		try {
			expect(webhookClientIp(H(spoof))).toBe('198.51.100.7')
		} finally {
			process.env.POWDER_TRUSTED_IP_HEADER = prev ?? ''
		}
		// unset: x-real-ip, the spoofed cf-connecting-ip is ignored
		expect(webhookClientIp(H(spoof))).toBe('198.51.100.7')
	})
})

describe('per-email sign-in lockout', () => {
	it('locks an address after the failure budget and clears on success', () => {
		const l = new SigninLockout(3, 60_000, 120_000)
		l.recordFailure('A@x.test', 0)
		l.recordFailure('a@x.test', 1)
		expect(l.lockedFor('a@x.test', 2)).toBe(0)
		l.recordFailure('a@x.test', 2)
		expect(l.lockedFor('a@x.test', 3)).toBeGreaterThan(0)
		expect(l.lockedFor('a@x.test', 200_000)).toBe(0)
		l.recordFailure('b@x.test', 0)
		l.recordSuccess('b@x.test')
		l.recordFailure('b@x.test', 1)
		l.recordFailure('b@x.test', 2)
		expect(l.lockedFor('b@x.test', 3)).toBe(0)
		// failures outside the window do not count
		const w = new SigninLockout(2, 10, 100)
		w.recordFailure('c@x.test', 0)
		w.recordFailure('c@x.test', 50)
		expect(w.lockedFor('c@x.test', 51)).toBe(0)
	})

	it('a real better-auth instance refuses the right password once the email is locked, whatever the client IP', async () => {
		const lock = new SigninLockout(3, 60_000, 60_000)
		const store: Record<string, unknown[]> = {
			user: [],
			session: [],
			account: [],
			verification: [],
			rateLimit: [],
		}
		const auth = betterAuth({
			baseURL: 'http://localhost:3000',
			secret: 'x'.repeat(40),
			database: memoryAdapter(store as never),
			emailAndPassword: { enabled: true },
			rateLimit: { enabled: false },
			hooks: signinLockoutHooks(lock),
		})
		await auth.api.signUpEmail({
			body: { email: 'admin@x.test', password: 'correct-horse', name: 'a' },
		})
		const signIn = (password: string, ip: string) =>
			auth.handler(
				new Request('http://localhost:3000/api/auth/sign-in/email', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						origin: 'http://localhost:3000',
						'cf-connecting-ip': ip,
					},
					body: JSON.stringify({ email: 'admin@x.test', password }),
				}),
			)
		expect((await signIn('correct-horse', '10.0.0.98')).status).toBe(200)
		for (let i = 0; i < 3; i++)
			expect((await signIn('wrong-password', `10.0.0.${i}`)).status).toBe(401)
		expect((await signIn('correct-horse', '10.0.0.99')).status).toBe(429)
	})
})

describe('the lockout map never evicts a lock to make room', () => {
	it('a flood of new addresses cannot unlock a locked one', () => {
		const l = new SigninLockout(2, 60_000, 600_000, 3)
		l.recordFailure('victim@x', 0)
		l.recordFailure('victim@x', 1)
		expect(l.lockedFor('victim@x', 2)).toBeGreaterThan(0)
		for (let i = 0; i < 50; i++) l.recordFailure(`spam${i}@x`, 10 + i)
		expect(l.lockedFor('victim@x', 100)).toBeGreaterThan(0)
		expect(l.size).toBe(3)
	})
	it('drops only entries that hold nothing (lock over, no recent failure) when full', () => {
		const l = new SigninLockout(5, 1_000, 1_000, 2)
		l.recordFailure('old@x', 0)
		l.recordFailure('recent@x', 5_000)
		l.recordFailure('new@x', 5_500) // old@x's failure left the window: swept
		expect(l.size).toBe(2)
		l.recordFailure('another@x', 5_600) // both recent: the cap evicts the oldest one-failure entry
		expect(l.size).toBe(2)
		l.recordFailure('another@x', 5_700) // the new address is tracked and counts
		expect(l.size).toBe(2)
	})
})

describe('a full lockout map cannot exempt a target', () => {
	it('a new target address is tracked and locks even after a flood filled the map', () => {
		const l = new SigninLockout(3, 60_000, 600_000, 5)
		for (let i = 0; i < 50; i++) l.recordFailure(`spam${i}@x`, i)
		expect(l.size).toBe(5)
		l.recordFailure('target@x', 100)
		l.recordFailure('target@x', 101)
		l.recordFailure('target@x', 102)
		expect(l.lockedFor('target@x', 103)).toBeGreaterThan(0)
		expect(l.size).toBe(5)
	})
	it('a flood of one-failure addresses does not evict a target that holds more failures', () => {
		const l = new SigninLockout(3, 60_000, 600_000, 5)
		l.recordFailure('target@x', 0)
		l.recordFailure('target@x', 1)
		for (let i = 0; i < 50; i++) l.recordFailure(`spam${i}@x`, 10 + i)
		l.recordFailure('target@x', 100)
		expect(l.lockedFor('target@x', 101)).toBeGreaterThan(0)
	})
	it('never evicts a lock: when every entry is locked the new address is not tracked', () => {
		const l = new SigninLockout(1, 60_000, 600_000, 2)
		l.recordFailure('a@x', 0)
		l.recordFailure('b@x', 1)
		l.recordFailure('c@x', 2)
		expect(l.lockedFor('a@x', 3)).toBeGreaterThan(0)
		expect(l.lockedFor('b@x', 3)).toBeGreaterThan(0)
		expect(l.lockedFor('c@x', 3)).toBe(0)
		expect(l.size).toBe(2)
	})
})
