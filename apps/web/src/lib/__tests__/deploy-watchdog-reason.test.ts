// A deploy the watchdog ends says why (failed step + one-line summary, which the deploy
// page's failure banner needs) and raises the same failure event a normal failure does,
// once per reaped row. Closing GitHub state still never delays the reaps.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
	reaped: [] as Record<string, unknown>[][],
	events: [] as string[],
	sets: [] as Record<string, unknown>[],
	hq: [] as Record<string, unknown>[],
	gh: [] as { id: string; summary: string }[],
}))

vi.mock('../hq', () => ({
	reportSwapCheckLeftoverToHq: async () => {},
	reportDeployToHq: async (e: Record<string, unknown>) => {
		H.events.push('hq')
		H.hq.push(e)
	},
}))
vi.mock('../servers', () => ({ listAllServers: async () => [] }))
vi.mock('../ssh', () => ({ runCommand: async () => ({}) }))
vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const update = () => {
		const c = {
			set: (v: Record<string, unknown>) => {
				if ('failedStep' in v) {
					H.events.push('reason')
					H.sets.push(v)
				}
				return c
			},
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
vi.mock('../repos', () => ({ getRepoFor: async () => ({ id: 'app_1', ownerUserId: 'u', repoUrl: 'git@github.com:a/b.git' }) }))
vi.mock('../github-deployments', () => ({
	notifyDeploymentFinished: async (_repo: unknown, id: string, _state: string, summary: string) => {
		H.events.push('github')
		H.gh.push({ id, summary })
	},
}))

import { reapStuckDeploys } from '../deploy-watchdog'
import { NEVER_CLAIMED_STEP, WATCHDOG_STOPPED_STEP, watchdogReapReason } from '../deploy-watchdog-reason'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000)
const SHA = 'c'.repeat(40)

describe('watchdogReapReason', () => {
	it('a stale heartbeat names the minutes since the last one', () => {
		const r = watchdogReapReason({ queued: false, heartbeatAt: ago(7), startedAt: ago(20), hadOutput: true }, NOW)
		expect(r.failedStep).toBe(WATCHDOG_STOPPED_STEP)
		expect(r.summary).toBe('stopped by the watchdog: no heartbeat for 7 minutes (the process running it died or its SSH session hung)')
	})
	it('the hard cap, no heartbeat at all, and no output', () => {
		expect(watchdogReapReason({ queued: false, heartbeatAt: ago(0), startedAt: ago(80), hadOutput: true }, NOW).summary).toMatch(
			/^stopped by the watchdog: it ran for 80 minutes, past the 75-minute limit, and was stopped$/,
		)
		// the heartbeat was fresh: no "died or hung" cause for the hard cap
		expect(watchdogReapReason({ queued: false, heartbeatAt: ago(0), startedAt: ago(80), hadOutput: true }, NOW).summary).not.toMatch(/died|hung/)
		expect(watchdogReapReason({ queued: false, heartbeatAt: null, startedAt: ago(61), hadOutput: true }, NOW).summary).toMatch(
			/no heartbeat and no result after 61 minutes/,
		)
		expect(watchdogReapReason({ queued: false, heartbeatAt: ago(1), startedAt: ago(6), hadOutput: false }, NOW).summary).toMatch(
			/no output for 6 minutes \(the process running it died or its SSH session hung\)$/,
		)
	})
	it('a queued deploy nobody claimed says it never started', () => {
		const r = watchdogReapReason({ queued: true, queuedAt: ago(181) }, NOW)
		expect(r.failedStep).toBe(NEVER_CLAIMED_STEP)
		expect(r.summary).toMatch(/^never started: queued for 181 minutes and no deploy worker claimed it/)
	})
})

const row = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	serverId: 'srv-1',
	containerName: 'shop',
	kind: 'git_deploy',
	gitSha: null,
	builtSha: null,
	gitBranch: null,
	requestedSha: SHA,
	heartbeatAt: new Date(Date.now() - 10 * 60_000),
	startedAt: new Date(Date.now() - 30 * 60_000),
	queuedAt: new Date(Date.now() - 30 * 60_000),
	hadOutput: true,
	...extra,
})

beforeEach(() => {
	H.reaped = []
	H.events = []
	H.sets = []
	H.hq = []
	H.gh = []
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('reapStuckDeploys records why and reports once', () => {
	it('each reaped row gets its step and summary, one failure event, and GitHub its own summary', async () => {
		H.reaped = [[row('dep_run')], [row('dep_q', { heartbeatAt: null, queuedAt: new Date(Date.now() - 200 * 60_000) })]]
		await reapStuckDeploys()
		await new Promise((r) => setTimeout(r, 0))
		expect(H.sets).toHaveLength(2)
		expect(H.sets[0]).toMatchObject({ failedStep: 'watchdog' })
		expect(String(H.sets[0]?.errorSummary)).toMatch(/^stopped by the watchdog: no heartbeat for 10 minutes/)
		expect(H.sets[1]).toMatchObject({ failedStep: 'queue' })
		expect(H.hq).toHaveLength(2)
		expect(H.hq[0]).toMatchObject({ status: 'failure', deployId: 'dep_run', sha: SHA, shaSource: 'requested' })
		expect(String(H.hq[0]?.error)).toMatch(/^failed during: watchdog · stopped by the watchdog/)
		expect(H.hq[0]).toMatchObject({ failedStep: 'watchdog', exitCode: null })
		expect(String(H.hq[1]?.error)).toMatch(/^failed during: queue · never started/)
		expect(H.hq[1]).toMatchObject({ failedStep: 'queue', exitCode: null })
		expect(H.gh.find((g) => g.id === 'dep_q')?.summary).toMatch(/^never started/)
		// both reaps first: nothing slow sits in front of the lock release
		expect(H.events.slice(0, 2)).toEqual(['reap', 'reap'])
	})
	it('no reaped rows: no event', async () => {
		H.reaped = [[], []]
		await reapStuckDeploys()
		expect(H.hq).toHaveLength(0)
		expect(H.sets).toHaveLength(0)
	})
})
