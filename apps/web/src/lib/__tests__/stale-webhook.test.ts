// Guard: a GitHub hook posting to an unknown deploy token is removed only when the
// repo is one powder manages, the token is still unknown, and the hook's own URL is
// this powder's /api/webhooks/deploy/<that exact token>. One attempt per hook id per
// 10 minutes, whatever the flood.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const afterCalls: Array<() => unknown> = []
vi.mock('next/server', () => ({ after: (fn: () => unknown) => afterCalls.push(fn) }))
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
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ ok: true }) }))

import { POST } from '../../app/api/webhooks/deploy/[token]/route'
import {
	STALE_HOOK_MAX_PER_WINDOW,
	STALE_HOOK_WINDOW_MS,
	type StaleHookDeps,
	githubRepoUrlRegex,
	payloadFullName,
	removeStaleHook,
	resetStaleHookLimiter,
} from '../stale-webhook'

const TOKEN = '85a6bf51'.padEnd(32, 'x')
const OTHER = 'zzzzzzzz'.padEnd(32, 'y')
const REPO = { owner: 'acme', repo: 'shop' }
const MANAGED = [
	{ repoUrl: 'git@github.com:acme/shop.git', ownerUserId: 'u1' },
	{ repoUrl: 'https://github.com/someone/else', ownerUserId: 'u2' },
]

function deps(over: Partial<StaleHookDeps> & { hookUrl?: string; clock?: { t: number } } = {}) {
	const deleted: Array<[string, string, number]> = []
	const lines: string[] = []
	const clock = over.clock ?? { t: 1_000_000 }
	const d: StaleHookDeps = {
		// stands in for the SQL match: managed = the regex hits one of these stored URLs
		managedRepoOwner: async (owner, repo) => {
			const re = new RegExp(githubRepoUrlRegex(owner, repo), 'i')
			const hit = MANAGED.find((r) => re.test(r.repoUrl))
			return hit ? { ownerUserId: hit.ownerUserId } : null
		},
		tokenKnown: async () => false,
		githubToken: async () => 'gh-token',
		getHook: async () => ({
			config: { url: over.hookUrl ?? `https://powder.sh/api/webhooks/deploy/${TOKEN}` },
		}),
		deleteHook: async (_t, owner, repo, id) => {
			deleted.push([owner, repo, id])
		},
		ownOrigins: () => ['https://powder.sh', 'https://deploy.example.com'],
		now: () => clock.t,
		log: (l) => lines.push(l),
		...over,
	}
	return { d, deleted, lines, clock }
}

beforeEach(() => {
	resetStaleHookLimiter()
	afterCalls.length = 0
})

describe('removeStaleHook', () => {
	it('deletes only the hook whose URL is this powder plus the exact unknown token', async () => {
		const { d, deleted, lines } = deps()
		expect(await removeStaleHook({ token: TOKEN, hookId: '123456789', repository: REPO }, d)).toBe(
			'deleted',
		)
		expect(deleted).toEqual([['acme', 'shop', 123456789]])
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('removed stale GitHub hook 123456789 on acme/shop')
		expect(lines[0]).not.toContain(TOKEN)
	})

	it('matches the managed repo case-insensitively and across ssh/https URL forms', async () => {
		const { d, deleted } = deps()
		const r = await removeStaleHook(
			{ token: TOKEN, hookId: '1', repository: { owner: 'Acme', repo: 'Shop' } },
			d,
		)
		expect(r).toBe('deleted')
		expect(deleted).toEqual([['Acme', 'Shop', 1]])
	})

	it('skips a repo powder does not manage, without touching GitHub', async () => {
		const getHook = vi.fn()
		const { d, deleted } = deps({ getHook })
		const r = await removeStaleHook(
			{ token: TOKEN, hookId: '1', repository: { owner: 'stranger', repo: 'thing' } },
			d,
		)
		expect(r).toBe('unmanaged repo')
		expect(getHook).not.toHaveBeenCalled()
		expect(deleted).toEqual([])
	})

	it('skips a hook whose URL carries a different token', async () => {
		const { d, deleted } = deps({ hookUrl: `https://powder.sh/api/webhooks/deploy/${OTHER}` })
		expect(await removeStaleHook({ token: TOKEN, hookId: '1', repository: REPO }, d)).toBe(
			'url mismatch',
		)
		expect(deleted).toEqual([])
	})

	it('skips a hook on another host, or a URL that only contains the token', async () => {
		for (const hookUrl of [
			`https://evil.example/api/webhooks/deploy/${TOKEN}`,
			`http://powder.sh/api/webhooks/deploy/${TOKEN}`,
			`https://powder.sh/api/webhooks/deploy/${TOKEN}/x`,
			`https://powder.sh.evil.example/api/webhooks/deploy/${TOKEN}`,
		]) {
			resetStaleHookLimiter()
			const { d, deleted } = deps({ hookUrl })
			expect(await removeStaleHook({ token: TOKEN, hookId: '1', repository: REPO }, d)).toBe(
				'url mismatch',
			)
			expect(deleted).toEqual([])
		}
	})

	it('skips a known token, also when it becomes known between the GET and the delete', async () => {
		const known = deps({ tokenKnown: async () => true })
		expect(await removeStaleHook({ token: TOKEN, hookId: '1', repository: REPO }, known.d)).toBe(
			'token known',
		)
		expect(known.deleted).toEqual([])

		resetStaleHookLimiter()
		let calls = 0
		const race = deps({ tokenKnown: async () => ++calls > 1 })
		expect(await removeStaleHook({ token: TOKEN, hookId: '1', repository: REPO }, race.d)).toBe(
			'token known',
		)
		expect(race.deleted).toEqual([])
	})

	it('skips a hook GitHub no longer has, and bad hook ids', async () => {
		const { d, deleted } = deps({ getHook: async () => null })
		expect(await removeStaleHook({ token: TOKEN, hookId: '1', repository: REPO }, d)).toBe(
			'hook not found',
		)
		for (const hookId of [null, '', '-1', '1e3', '12345678901234567890']) {
			expect(await removeStaleHook({ token: TOKEN, hookId, repository: REPO }, d)).toBe('bad input')
		}
		expect(deleted).toEqual([])
	})

	it('rate-limits per hook id: one attempt per 10 minutes', async () => {
		const getHook = vi.fn(async () => ({
			config: { url: `https://powder.sh/api/webhooks/deploy/${OTHER}` },
		}))
		const { d, clock } = deps({ getHook })
		expect(await removeStaleHook({ token: TOKEN, hookId: '7', repository: REPO }, d)).toBe(
			'url mismatch',
		)
		for (let i = 0; i < 50; i++) {
			expect(await removeStaleHook({ token: TOKEN, hookId: '7', repository: REPO }, d)).toBe(
				'rate limited',
			)
		}
		expect(getHook).toHaveBeenCalledTimes(1)
		clock.t += STALE_HOOK_WINDOW_MS - 1
		expect(await removeStaleHook({ token: TOKEN, hookId: '7', repository: REPO }, d)).toBe(
			'rate limited',
		)
		clock.t += 1
		expect(await removeStaleHook({ token: TOKEN, hookId: '7', repository: REPO }, d)).toBe(
			'url mismatch',
		)
		expect(getHook).toHaveBeenCalledTimes(2)
	})

	it('caps attempts across all hook ids per window', async () => {
		const getHook = vi.fn(async () => null)
		const { d } = deps({ getHook })
		for (let i = 0; i < STALE_HOOK_MAX_PER_WINDOW + 20; i++) {
			await removeStaleHook({ token: TOKEN, hookId: String(1000 + i), repository: REPO }, d)
		}
		expect(getHook).toHaveBeenCalledTimes(STALE_HOOK_MAX_PER_WINDOW)
	})

	it('deliveries naming unmanaged repos do not use up the budget', async () => {
		const getHook = vi.fn(async () => null)
		const { d } = deps({ getHook })
		for (let i = 0; i < STALE_HOOK_MAX_PER_WINDOW + 20; i++) {
			expect(
				await removeStaleHook(
					{ token: TOKEN, hookId: String(5000 + i), repository: { owner: 'forged', repo: `r${i}` } },
					d,
				),
			).toBe('unmanaged repo')
		}
		expect(getHook).not.toHaveBeenCalled()
		expect(await removeStaleHook({ token: TOKEN, hookId: '5000', repository: REPO }, d)).toBe(
			'hook not found',
		)
		expect(getHook).toHaveBeenCalledTimes(1)
	})

	it('never throws: a GitHub error is reported as failed', async () => {
		const { d } = deps({
			deleteHook: async () => {
				throw new Error('github 403: Resource not accessible')
			},
		})
		const r = await removeStaleHook({ token: TOKEN, hookId: '1', repository: REPO }, d)
		expect(r).toMatch(/^failed: github 403/)
	})
})

describe('githubRepoUrlRegex', () => {
	it('matches every github.com URL form of exactly that owner/repo', () => {
		const re = new RegExp(githubRepoUrlRegex('a.b', 'c-d'), 'i')
		for (const u of [
			'git@github.com:a.b/c-d.git',
			'git@github.com:A.B/C-D',
			'ssh://git@github.com/a.b/c-d',
			'ssh://git@github.com:22/a.b/c-d.git',
			'https://github.com/a.b/c-d',
			'https://www.github.com/a.b/c-d.git',
			'http://github.com/a.b/c-d/',
		])
			expect(re.test(u), u).toBe(true)
		for (const u of [
			'git@github.com:axb/c-d.git',
			'git@github.com:a.b/c-de',
			'git@github.com:x/a.b/c-d',
			'https://tok@github.com/a.b/c-d',
			'https://gitlab.com/a.b/c-d',
			'https://github.com.evil/a.b/c-d',
		])
			expect(re.test(u), u).toBe(false)
		expect(() => githubRepoUrlRegex('a/b', 'c')).toThrow()
	})
})

describe('payloadFullName', () => {
	it('reads repository.full_name and refuses anything else', () => {
		expect(payloadFullName(JSON.stringify({ repository: { full_name: 'a/b' } }))).toEqual({
			owner: 'a',
			repo: 'b',
		})
		expect(payloadFullName(JSON.stringify({ repository: { full_name: 'a/b/c' } }))).toBeNull()
		expect(payloadFullName(JSON.stringify({ repository: { full_name: '../b' } }))).toBeNull()
		expect(payloadFullName(JSON.stringify({ repository: {} }))).toBeNull()
		expect(payloadFullName('not json')).toBeNull()
		expect(payloadFullName('null')).toBeNull()
	})
})

describe('deploy webhook route, unknown token', () => {
	const post = (headers: Record<string, string>) =>
		POST(
			new Request(`http://x/api/webhooks/deploy/${TOKEN}`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ repository: { full_name: 'acme/shop' } }),
			}),
			{ params: Promise.resolve({ token: TOKEN }) },
		)

	it('answers 401 like a bad signature and schedules cleanup after the response for a GitHub delivery', async () => {
		const r = await post({ 'x-github-event': 'push', 'x-github-hook-id': '123456789' })
		expect(r.status).toBe(401)
		expect(afterCalls).toHaveLength(1)
	})

	it('answers 401 like a bad signature and schedules nothing without the GitHub hook headers', async () => {
		const r = await post({})
		expect(r.status).toBe(401)
		expect(afterCalls).toHaveLength(0)
	})
})
