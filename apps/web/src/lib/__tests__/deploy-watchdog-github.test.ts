// A reaped deploy never reaches the runner's own exit: the watchdog closes its
// GitHub Deployment and, for a claimed git deploy, its commit status, so nothing
// is left in progress / pending forever. A GitHub or lookup failure never throws.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
	reaped: [] as Record<string, unknown>[][],
	events: [] as string[],
	hang: false,
	finished: [] as { id: string; state: string; check: unknown }[],
	repoMissing: false,
	throwOnNotify: false,
}))

vi.mock('../hq', () => ({ reportSwapCheckLeftoverToHq: async () => {} }))
vi.mock('../servers', () => ({ listAllServers: async () => [] }))
vi.mock('../ssh', () => ({ runCommand: async () => ({}) }))
vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const update = () => {
		const c = {
			set: () => c,
			where: () => c,
			returning: async () => {
				H.events.push('reap')
				return H.reaped.shift() ?? []
			},
		}
		return c
	}
	return { ...real, db: { update } }
})
vi.mock('../repos', () => ({
	getRepoFor: async () => (H.repoMissing ? null : { id: 'app_1', ownerUserId: 'u', repoUrl: 'git@github.com:a/b.git' }),
}))
vi.mock('../github-deployments', () => ({
	notifyDeploymentFinished: async (_repo: unknown, id: string, state: string, _d: unknown, check?: unknown) => {
		H.events.push(`notify:${id}`)
		if (H.throwOnNotify) throw new Error('boom')
		if (H.hang) await new Promise(() => {})
		H.finished.push({ id, state, check })
	},
}))

import { closeOnGithub, reapStuckDeploys } from '../deploy-watchdog'

const SHA = 'd'.repeat(40)
const row = (id: string) => ({ id, serverId: 's', containerName: 'web', kind: 'git_deploy', gitSha: null, requestedSha: SHA })

beforeEach(() => {
	H.reaped = []
	H.events = []
	H.hang = false
	H.finished = []
	H.repoMissing = false
	H.throwOnNotify = false
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('watchdog closes GitHub statuses of reaped deploys', () => {
	it('a reaped running deploy gets failure with commit facts; a reaped queued one only the Deployment', async () => {
		H.reaped = [[row('dep_run')], [row('dep_q')]]
		await reapStuckDeploys()
		expect(H.finished).toHaveLength(2)
		expect(H.finished.find((f) => f.id === 'dep_run')).toMatchObject({ state: 'failure', check: { kind: 'git_deploy', requestedSha: SHA, failedStep: null, testGate: null } })
		expect(H.finished.find((f) => f.id === 'dep_q')).toMatchObject({ state: 'failure', check: undefined })
	})
	it('both reaps are written before any GitHub call', async () => {
		H.reaped = [[row('dep_run')], [row('dep_q')]]
		await reapStuckDeploys()
		expect(H.events.slice(0, 2)).toEqual(['reap', 'reap'])
		expect(H.events.slice(2).sort()).toEqual(['notify:dep_q', 'notify:dep_run'])
	})
	it('a hung GitHub does not hold the watchdog past the overall limit; rows run in parallel', async () => {
		H.hang = true
		vi.useFakeTimers()
		try {
			const done = closeOnGithub(
				[
					{ ...row('dep_1'), claimed: true },
					{ ...row('dep_2'), claimed: true },
				],
				1_000,
			)
			await vi.advanceTimersByTimeAsync(1_001)
			await expect(done).resolves.toBeUndefined()
			// both started at once, neither waited for the other
			expect(H.events.filter((e) => e.startsWith('notify:')).sort()).toEqual(['notify:dep_1', 'notify:dep_2'])
		} finally {
			vi.useRealTimers()
		}
	})
	it('nothing reaped: nothing sent', async () => {
		await reapStuckDeploys()
		expect(H.finished).toHaveLength(0)
	})
	it('an app with no repo row is skipped; a throwing notifier never fails the reap', async () => {
		H.reaped = [[row('dep_a')], []]
		H.repoMissing = true
		await expect(reapStuckDeploys()).resolves.toBeUndefined()
		H.reaped = [[row('dep_b')], []]
		H.repoMissing = false
		H.throwOnNotify = true
		await expect(reapStuckDeploys()).resolves.toBeUndefined()
		expect(H.finished).toHaveLength(0)
	})
})
