// The deploy webhook charges its per-token bucket only once the signature verified:
// unsigned or badly signed POSTs cost only the per-IP bucket, so they cannot use up
// a real delivery's budget. An unknown token still answers like a bad signature.
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const SECRET = 'hook-secret'
const APP_TOKEN = 'A'.repeat(32)
const GROUP_TOKEN = 'G'.repeat(32)

vi.mock('@/lib/repos', () => ({
	getRepoByToken: async (t: string) =>
		t === APP_TOKEN ? { id: 'rep_1', serverId: 's1', containerName: 'web', branch: 'main' } : null,
	decryptWebhookSecret: () => SECRET,
	setRepoGithubIds: async () => {},
}))
vi.mock('@/lib/repo-groups', () => ({
	getGroupByToken: async (t: string) => (t === GROUP_TOKEN ? { id: 'grp_1' } : null),
	decryptWebhookSecretForGroup: () => SECRET,
	listSubAppsForGroup: async () => [],
	setGroupGithubRepoId: async () => {},
}))

import { POST } from '../../app/api/webhooks/deploy/[token]/route'

const sign = (body: string, secret = SECRET) =>
	`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

function call(token: string, headers: Record<string, string>, body = '{}') {
	return POST(
		new Request(`http://x/api/webhooks/deploy/${token}`, { method: 'POST', body, headers }),
		{ params: Promise.resolve({ token }) },
	)
}

describe.each([
	['app token', APP_TOKEN],
	['group token', GROUP_TOKEN],
])('deploy webhook per-token bucket (%s)', (_label, token) => {
	it('unsigned and badly signed POSTs (no trusted IP, so no IP bucket) never starve a signed delivery', async () => {
		for (let i = 0; i < 60; i++) {
			const r = await call(token, { 'x-github-event': 'ping', 'x-hub-signature-256': i % 2 ? '' : sign('{}', 'wrong') })
			expect(r.status).toBe(401)
		}
		const ok = await call(token, { 'x-github-event': 'ping', 'x-hub-signature-256': sign('{}') })
		expect(ok.status).toBe(200)
		expect((await ok.json()).pong).toBe(true)
	})

	it('signed requests are charged: past 30 a minute the token is limited', async () => {
		// 1 signed ping above already used one slot of this token's bucket.
		const statuses: number[] = []
		for (let i = 0; i < 30; i++) {
			const r = await call(token, { 'x-github-event': 'ping', 'x-hub-signature-256': sign('{}') })
			statuses.push(r.status)
		}
		expect(statuses.slice(0, 29).every((s) => s === 200)).toBe(true)
		expect(statuses[29]).toBe(429)
	})
})

describe('deploy webhook per-IP bucket', () => {
	it('still charges unsigned requests per IP', async () => {
		const prev = process.env.POWDER_TRUSTED_IP_HEADER
		Reflect.deleteProperty(process.env, 'POWDER_TRUSTED_IP_HEADER')
		try {
			const statuses: number[] = []
			for (let i = 0; i < 61; i++) {
				const r = await call('U'.repeat(32), { 'x-real-ip': '203.0.113.9', 'x-hub-signature-256': '' })
				statuses.push(r.status)
			}
			expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true)
			expect(statuses[60]).toBe(429)
		} finally {
			if (prev !== undefined) process.env.POWDER_TRUSTED_IP_HEADER = prev
		}
	})

	it('an unknown token answers 401 bad signature, like a wrong signature on a real one', async () => {
		const unknown = await call('Z'.repeat(32), { 'x-github-event': 'push', 'x-hub-signature-256': sign('{}') })
		const bad = await call(APP_TOKEN, { 'x-github-event': 'push', 'x-hub-signature-256': sign('{}', 'nope') })
		expect(unknown.status).toBe(401)
		expect(await unknown.json()).toEqual(await bad.json())
	})
})
