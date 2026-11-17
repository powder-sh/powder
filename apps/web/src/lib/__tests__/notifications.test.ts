import { afterEach, describe, expect, it, vi } from 'vitest'
import { redactSecrets as S } from '../secret-text'

vi.mock('../db', () => ({}))
import { notifyDeployFailed, sanitizeNotifyText } from '../notifications'

const repo = { containerName: 'web', serverId: 's1', branch: 'main' } as never

afterEach(() => {
	vi.unstubAllGlobals()
	delete process.env.POWDER_NOTIFY_WEBHOOK_URL
})

describe('notifications', () => {
	it('sanitizeNotifyText defuses mentions and strips <...>', () => {
		const out = sanitizeNotifyText('@everyone <!channel> <@123> <https://evil|click> ok@host')
		expect(out).not.toMatch(/@(?!​)/)
		expect(out).not.toContain('<')
		expect(out).toContain('ok')
	})
	it('webhook body carries allowed_mentions.parse = [] and sanitized text', async () => {
		process.env.POWDER_NOTIFY_WEBHOOK_URL = 'http://hook.test/x'
		const fetchMock = vi.fn(async (_u: string, _i: { body: string }) => new Response('ok'))
		vi.stubGlobal('fetch', fetchMock)
		await notifyDeployFailed(repo, { deployId: 'd', errorMessage: S('@everyone <!channel> boom'), gitSha: null, gitBranch: null })
		const init = fetchMock.mock.calls[0]?.[1]
		const body = JSON.parse(init.body)
		expect(body.allowed_mentions).toEqual({ parse: [] })
		expect(body.content).not.toMatch(/@(?!​)/)
		expect(body.content).not.toContain('<!channel>')
		expect(body.text).toBe(body.content)
	})
})
