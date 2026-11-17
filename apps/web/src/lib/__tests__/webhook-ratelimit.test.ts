import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkRateLimit, rateLimitBucketCount } from '../rate-limit'
import { unknownTokenResponse, webhookClientIp, webhookEventGate } from '../webhook-gate'

const sign = (body: string, secret: string) =>
	`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('rate limiter memory bound', () => {
	it('never holds more than 10k keys', () => {
		for (let i = 0; i < 25_000; i++) checkRateLimit(`webhook:token:probe-${i}`, 30, 60_000)
		expect(rateLimitBucketCount()).toBeLessThanOrEqual(10_000)
	})
	it('still limits a repeated key', () => {
		for (let i = 0; i < 5; i++) checkRateLimit('k-repeat', 5, 60_000)
		expect(checkRateLimit('k-repeat', 5, 60_000).ok).toBe(false)
	})
})

describe('client ip', () => {
	const withMode = (mode: string, f: () => void) => {
		const prev = process.env.POWDER_TRUSTED_IP_HEADER
		process.env.POWDER_TRUSTED_IP_HEADER = mode
		try {
			f()
		} finally {
			if (prev === undefined) Reflect.deleteProperty(process.env, 'POWDER_TRUSTED_IP_HEADER')
			else process.env.POWDER_TRUSTED_IP_HEADER = prev
		}
	}
	it('ignores a spoofed left-most x-forwarded-for', () => {
		const h = new Headers({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' })
		withMode('cf-connecting-ip', () => expect(webhookClientIp(h)).toBe('9.9.9.9'))
		withMode('x-forwarded-for', () => expect(webhookClientIp(h)).toBe('9.9.9.9'))
	})
	it('cf-connecting-ip mode prefers cf-connecting-ip, then x-real-ip', () => {
		withMode('cf-connecting-ip', () => {
			expect(webhookClientIp(new Headers({ 'cf-connecting-ip': '5.5.5.5', 'x-forwarded-for': '1.1.1.1' }))).toBe('5.5.5.5')
			expect(webhookClientIp(new Headers({ 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '1.1.1.1' }))).toBe('6.6.6.6')
		})
	})
	it('the default (x-real-ip) ignores a client-sent cf-connecting-ip', () => {
		withMode('', () => {
			expect(webhookClientIp(new Headers({ 'cf-connecting-ip': '5.5.5.5', 'x-real-ip': '6.6.6.6' }))).toBe('6.6.6.6')
		})
	})
})

describe('replay hardening', () => {
	it('a signed push without X-GitHub-Delivery is rejected', () => {
		const b = '{}'
		expect(webhookEventGate('push', b, sign(b, 's'), 's', {})?.status).toBe(400)
	})
})

describe('signature before event reply', () => {
	it('unsigned non-push event gets 401, not 200 ignored', () => {
		expect(webhookEventGate('issues', '{}', '', 's3cret')?.status).toBe(401)
	})
	it('signed non-push is ignored, signed ping pongs, signed push passes', async () => {
		const b = '{}'
		const sig = sign(b, 's3cret')
		expect(await webhookEventGate('issues', b, sig, 's3cret')?.json()).toEqual({ ignored: 'issues' })
		expect((await webhookEventGate('ping', b, sig, 's3cret')?.json())?.pong).toBe(true)
		expect(webhookEventGate('push', b, sig, 's3cret', { delivery: 'd1' })).toBeNull()
	})
})

describe('unknown token', () => {
	it('answers exactly like a bad signature on a valid token', async () => {
		const b = '{"ref":"refs/heads/main"}'
		const unknown = unknownTokenResponse(b, sign(b, 'anything'))
		const bad = webhookEventGate('push', b, sign(b, 'wrong'), 's3cret', { delivery: 'd1' })
		expect(unknown.status).toBe(401)
		expect(bad?.status).toBe(401)
		expect(await unknown.json()).toEqual(await bad?.json())
	})
})
