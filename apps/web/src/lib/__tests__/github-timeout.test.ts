// Every GitHub API call carries a time limit, so a hung GitHub fails the call
// instead of hanging the page or route that waits on it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GH_TIMEOUT_MS, GithubTimeoutError, getViewer } from '../github'

function hangingFetch() {
	const seen: (AbortSignal | undefined)[] = []
	const fn = vi.fn((_url: string, init?: RequestInit) => {
		seen.push(init?.signal ?? undefined)
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
		})
	})
	return { fn, seen }
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('GitHub API time limit', () => {
	it('a call without a signal gets the default limit', async () => {
		const { fn, seen } = hangingFetch()
		vi.stubGlobal('fetch', fn)
		const timeout = vi.spyOn(AbortSignal, 'timeout')
		const p = getViewer('t')
		expect(timeout).toHaveBeenCalledWith(GH_TIMEOUT_MS)
		expect(seen[0]).toBeInstanceOf(AbortSignal)
		timeout.mockRestore()
		p.catch(() => {})
	})

	it('a hung GitHub fails with GithubTimeoutError after the override', async () => {
		const { fn } = hangingFetch()
		vi.stubGlobal('fetch', fn)
		const err = await getViewer('t', { timeoutMs: 20 }).catch((e) => e)
		expect(err).toBeInstanceOf(GithubTimeoutError)
		expect(String(err.message)).toContain('github timeout: no answer within 20 ms (/user)')
		expect(String(err.message)).not.toMatch(/^github 401/)
	})

	it('an answer within the limit is returned', async () => {
		vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ login: 'octo', id: 1 }), { status: 200 }))
		expect(await getViewer('t')).toMatchObject({ login: 'octo' })
	})
})
