// behind a proxy that sets no trusted IP header every request is 'unknown'.
// No limiter may then put all of them in ONE shared pre-auth bucket (one client could
// 429 every GitHub webhook or lock everyone out of sign-in), and powder warns once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/repos', () => ({
	getRepoByToken: async () => null,
	decryptWebhookSecret: () => 's',
	setRepoGithubIds: async () => {},
}))
vi.mock('@/lib/repo-groups', () => ({
	getGroupByToken: async () => null,
	decryptWebhookSecretForGroup: () => 's',
	listSubAppsForGroup: async () => [],
	setGroupGithubRepoId: async () => {},
}))

import { POST } from '../../app/api/webhooks/deploy/[token]/route'
import {
	betterAuthRateLimitRules,
	clientIpFromHeaders,
	knownClientIp,
	resetMissingIpWarning,
} from '../client-ip'
import { webhookLimitKeys } from '../webhook-gate'

const TOKEN = 'A'.repeat(32)

describe('client IP unknown', () => {
	beforeEach(() => resetMissingIpWarning())
	afterEach(() => vi.restoreAllMocks())

	it('webhookLimitKeys: no per-IP key for an unknown IP; malformed tokens refused', () => {
		expect(webhookLimitKeys('unknown', TOKEN)).toEqual({
			ipKey: null,
			tokenKey: `webhook:token:${TOKEN}`,
		})
		expect(webhookLimitKeys('1.2.3.4', TOKEN)?.ipKey).toBe('webhook:ip:1.2.3.4')
		expect(webhookLimitKeys('unknown', 'x'.repeat(129))).toBeNull()
		expect(webhookLimitKeys('unknown', 'a/b'.repeat(10))).toBeNull()
	})

	it('a flood of headerless webhook requests does not 429 another token', async () => {
		const call = (token: string) =>
			POST(new Request(`http://x/api/webhooks/deploy/${token}`, { method: 'POST', body: '{}' }), {
				params: Promise.resolve({ token }),
			})
		// one client sprays 100 requests with random well-formed tokens, no IP header
		for (let i = 0; i < 100; i++) await call(`${String(i).padStart(4, '0')}${'B'.repeat(28)}`)
		// a real GitHub delivery for another app still gets through the limiter (401 = past it,
		// the token lookup found nothing and it was answered like a bad signature)
		const r = await call(TOKEN)
		expect(r.status).toBe(401)
	})

	it('better-auth skips its per-IP limiter for requests without an IP, keeps it otherwise', () => {
		const rule = betterAuthRateLimitRules('x-real-ip')['/**']
		const cur = { window: 10, max: 3 }
		expect(rule?.(new Request('http://x/api/auth/sign-in/email'), cur)).toBe(false)
		expect(
			rule?.(new Request('http://x', { headers: { 'x-real-ip': '198.51.100.7' } }), cur),
		).toEqual(cur)
		expect(knownClientIp(new Headers({ 'x-real-ip': 'garbage' }), 'x-real-ip')).toBeNull()
	})

	it('warns once when the trusted header is missing', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		clientIpFromHeaders(new Headers(), 'x-real-ip')
		clientIpFromHeaders(new Headers(), 'x-real-ip')
		const lines = warn.mock.calls
			.map((c) => String(c[0]))
			.filter((l) => l.includes('[client-ip] WARN'))
		expect(lines).toHaveLength(1)
		expect(lines[0]).toMatch(/proxy_set_header X-Real-IP \$remote_addr/)
		expect(lines[0]).toMatch(/header_up X-Real-IP \{remote_host\}/)
	})
})
