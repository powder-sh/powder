// The ci tab's GitHub reads (lib/github-ci.ts): a failure is "could not read" (null),
// never an empty list, and is not cached; every call carries a time limit.
// Invented names only, no network (fetch is stubbed).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	CI_GH_TIMEOUT_MS,
	getCommitBySha,
	getRunFailureTail,
	listRunsForRepo,
	listWorkflowsForRepo,
} from '../github-ci'

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubFetch(...answers: (Response | Error)[]) {
	const calls: RequestInit[] = []
	const fn = vi.fn(async (_url: string, init: RequestInit) => {
		calls.push(init)
		const a = answers.shift()
		if (!a) throw new Error('no more answers')
		if (a instanceof Error) throw a
		return a
	})
	vi.stubGlobal('fetch', fn)
	return calls
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('listRunsForRepo', () => {
	it('a 403 / rate limit is null, not cached, and the next call reads again', async () => {
		const calls = stubFetch(
			json({ message: 'rate limited' }, 403),
			json({ workflow_runs: [{ id: 1 }] }),
		)
		expect(await listRunsForRepo('t', 'zorbco', 'runs-a', { branch: 'main' })).toBeNull()
		expect(await listRunsForRepo('t', 'zorbco', 'runs-a', { branch: 'main' })).toEqual([{ id: 1 }])
		expect(calls).toHaveLength(2)
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
	})
	it('a network error or timeout is null', async () => {
		stubFetch(new DOMException('timed out', 'TimeoutError') as unknown as Error)
		expect(await listRunsForRepo('t', 'zorbco', 'runs-b')).toBeNull()
	})
	it('an answer with no runs is an empty list', async () => {
		stubFetch(json({ workflow_runs: [] }))
		expect(await listRunsForRepo('t', 'zorbco', 'runs-c')).toEqual([])
	})
})

describe('listWorkflowsForRepo', () => {
	it('a failure is null and not cached; a success is cached', async () => {
		const calls = stubFetch(
			json({}, 500),
			json({ workflows: [{ id: 1, state: 'active', path: '.github/workflows/ci.yml' }] }),
		)
		expect(await listWorkflowsForRepo('t', 'zorbco', 'wf-a')).toBeNull()
		const ok = await listWorkflowsForRepo('t', 'zorbco', 'wf-a')
		expect(ok).toHaveLength(1)
		expect(await listWorkflowsForRepo('t', 'zorbco', 'wf-a')).toBe(ok)
		expect(calls).toHaveLength(2)
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
	})
})

describe('getCommitBySha', () => {
	it('with a time limit the call carries a signal; a timeout is not cached', async () => {
		const calls = stubFetch(
			new DOMException('timed out', 'TimeoutError') as unknown as Error,
			json({
				sha: 'abc',
				html_url: 'u',
				commit: { message: 'first line\nmore', author: null },
				author: null,
			}),
		)
		expect(
			await getCommitBySha('t', 'zorbco', 'c-a', 'abc', { timeoutMs: CI_GH_TIMEOUT_MS }),
		).toBeNull()
		const c = await getCommitBySha('t', 'zorbco', 'c-a', 'abc', { timeoutMs: CI_GH_TIMEOUT_MS })
		expect(c?.message).toBe('first line')
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
	})
	it('a missing commit (404) is remembered', async () => {
		const calls = stubFetch(json({}, 404))
		expect(await getCommitBySha('t', 'zorbco', 'c-b', 'def')).toBeNull()
		expect(await getCommitBySha('t', 'zorbco', 'c-b', 'def')).toBeNull()
		expect(calls).toHaveLength(1)
	})
})

describe('getRunFailureTail', () => {
	it('a non-ok /jobs answer (rate limit) is not cached', async () => {
		const calls = stubFetch(
			json({}, 403),
			json({ jobs: [{ id: 7, name: 'test', conclusion: 'failure' }] }),
			new Response('the log tail', { status: 200 }),
		)
		expect(await getRunFailureTail('t', 'zorbco', 'log-a', 99, 100)).toBe('(jobs api 403)')
		expect(await getRunFailureTail('t', 'zorbco', 'log-a', 99, 100)).toBe('the log tail')
		expect(calls).toHaveLength(3)
	})
	it('a non-ok /logs answer is not cached', async () => {
		stubFetch(
			json({ jobs: [{ id: 8, name: 'test', conclusion: 'failure' }] }),
			json({}, 502),
			json({ jobs: [{ id: 8, name: 'test', conclusion: 'failure' }] }),
			new Response('second try', { status: 200 }),
		)
		expect(await getRunFailureTail('t', 'zorbco', 'log-b', 98, 100)).toBe('(log api 502)')
		expect(await getRunFailureTail('t', 'zorbco', 'log-b', 98, 100)).toBe('second try')
	})
})

it('the time limit is a few seconds', () => {
	expect(CI_GH_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000)
	expect(CI_GH_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
})
