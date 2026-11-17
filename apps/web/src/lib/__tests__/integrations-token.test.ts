// The GitHub row reports whether GitHub still accepts the stored token: a 401 is
// `valid: false` (revoked or expired), any other failure is unknown (`null`).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	oauthToken: null as string | null,
	pat: null as null | { accessTokenEncrypted: string; username: string; scopes: string },
	viewer: (async () => ({ login: 'octo' })) as (t: string) => Promise<{ login: string }>,
}))

vi.mock('../db', () => {
	let table = ''
	const chain = {
		select: () => chain,
		from: (t: string) => {
			table = t
			return chain
		},
		where: () => chain,
		limit: async () => (table === 'account' ? [{ accessToken: 'enc' }] : state.pat ? [state.pat] : []),
	}
	return {
		db: chain,
		account: 'account',
		userIntegrations: 'user_integrations',
		and: () => null,
		eq: () => null,
		createId: () => 'id',
		prefixes: {},
	}
})
vi.mock('../oauth-token', () => ({ readOAuthAccessToken: async () => state.oauthToken }))
vi.mock('../crypto', () => ({ decryptSecret: (s: string) => `dec:${s}`, encryptSecret: (s: string) => s }))
vi.mock('../admin-ids', () => ({ adminTokenCandidates: () => [] }))
vi.mock('../github', () => ({
	getViewer: (t: string) => state.viewer(t),
	getTokenScopes: async () => [],
}))

const { checkGithubToken, clearGithubCheckCache, getGithubIntegrationDisplay, GITHUB_CHECK_TTL_MS } = await import('../integrations')

describe('checkGithubToken', () => {
	it('a token GitHub accepts is valid, with its login', async () => {
		expect(await checkGithubToken('t', async () => ({ login: 'octo' }))).toEqual({ valid: true, login: 'octo' })
	})
	it('a 401 is a rejected token', async () => {
		const r = await checkGithubToken('t', async () => {
			throw new Error('github 401: Bad credentials')
		})
		expect(r).toEqual({ valid: false, login: null })
	})
	it('a network error, rate limit or 5xx is unknown, not rejected', async () => {
		for (const msg of ['fetch failed', 'github 403: API rate limit exceeded', 'github 502: Bad Gateway', 'github 4010: x']) {
			const r = await checkGithubToken('t', async () => {
				throw new Error(msg)
			})
			expect(r, msg).toEqual({ valid: null, login: null })
		}
	})
	it('a timeout is unknown, not rejected', async () => {
		const r = await checkGithubToken('t', async () => {
			throw Object.assign(new Error('github timeout: no answer within 5000 ms (/user)'), { name: 'GithubTimeoutError' })
		})
		expect(r).toEqual({ valid: null, login: null })
	})
})

describe('getGithubIntegrationDisplay', () => {
	beforeEach(() => {
		state.oauthToken = null
		state.pat = null
		state.viewer = async () => ({ login: 'octo' })
		clearGithubCheckCache()
	})
	it('no token: not connected, GitHub not asked', async () => {
		const viewer = vi.fn()
		state.viewer = viewer
		expect(await getGithubIntegrationDisplay('u')).toEqual({ connected: false })
		expect(viewer).not.toHaveBeenCalled()
	})
	it('an OAuth token GitHub accepts: connected and valid', async () => {
		state.oauthToken = 'oauth-token-x'
		expect(await getGithubIntegrationDisplay('u')).toEqual({ connected: true, valid: true, username: 'octo', source: 'oauth' })
	})
	it('a revoked OAuth token: connected but valid false', async () => {
		state.oauthToken = 'oauth-token-x'
		state.viewer = async () => {
			throw new Error('github 401: Bad credentials')
		}
		expect(await getGithubIntegrationDisplay('u')).toEqual({ connected: true, valid: false, username: null, source: 'oauth' })
	})
	it('GitHub unreachable: valid unknown (null)', async () => {
		state.oauthToken = 'oauth-token-x'
		state.viewer = async () => {
			throw new Error('fetch failed')
		}
		expect(await getGithubIntegrationDisplay('u')).toMatchObject({ connected: true, valid: null })
	})
	it('a revoked personal access token is reported too', async () => {
		state.pat = { accessTokenEncrypted: 'e', username: 'patuser', scopes: 'repo,admin:repo_hook' }
		const seen: string[] = []
		state.viewer = async (t) => {
			seen.push(t)
			throw new Error('github 401: Bad credentials')
		}
		expect(await getGithubIntegrationDisplay('u')).toEqual({
			connected: true,
			valid: false,
			username: 'patuser',
			source: 'pat',
			scopes: ['repo', 'admin:repo_hook'],
		})
		expect(seen).toEqual(['dec:e'])
	})
	it('the result is reused per user for the TTL, and a new token or an expired entry asks GitHub again', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		try {
			state.oauthToken = 'oauth-token-x'
			const viewer = vi.fn(async () => ({ login: 'octo' }))
			state.viewer = viewer
			await getGithubIntegrationDisplay('u')
			await getGithubIntegrationDisplay('u')
			expect(viewer).toHaveBeenCalledTimes(1)
			await getGithubIntegrationDisplay('other-user')
			expect(viewer).toHaveBeenCalledTimes(2)
			state.oauthToken = 'oauth-token-y'
			await getGithubIntegrationDisplay('u')
			expect(viewer).toHaveBeenCalledTimes(3)
			vi.advanceTimersByTime(GITHUB_CHECK_TTL_MS)
			await getGithubIntegrationDisplay('u')
			expect(viewer).toHaveBeenCalledTimes(4)
		} finally {
			vi.useRealTimers()
		}
	})
})
