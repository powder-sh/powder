// A success that lands after the watchdog reaped the row flips it back to success. The
// flip writes what the run knows (test gate result, built commit), so the row matches
// the GitHub statuses the runner posts from the same facts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
	sets: [] as Record<string, unknown>[],
	selects: [] as unknown[][],
}))

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const update = () => ({
		set: (v: Record<string, unknown>) => {
			H.sets.push(v)
			const done = Promise.resolve()
			return {
				where: () => Object.assign(done, { returning: async () => [] as unknown[] }),
			}
		},
	})
	const select = () => {
		const c = { from: () => c, where: () => c, limit: async () => H.selects.shift() ?? [] }
		return c
	}
	return { ...real, db: { update, select } }
})

import { finishDeploy } from '../deploys'
import { RUNNING_REAP_NOTE } from '../deploy-watchdog-reason'

const reaped = {
	id: 'dep_1',
	serverId: 's',
	containerName: 'web',
	status: 'failed',
	startedAt: new Date(0),
	// the exact note the reap writes (a bare [watchdog] prefix is not a reap)
	error: RUNNING_REAP_NOTE,
	output: 'log',
}

beforeEach(() => {
	H.sets = []
	H.selects = []
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('late success after a watchdog reap', () => {
	it('the flip to success writes the test gate result and the built commit', async () => {
		// 1: the reaped row, 2: no newer deploy of the app
		H.selects = [[reaped], []]
		const B = 'b'.repeat(40)
		await finishDeploy('dep_1', { status: 'success', output: 'x', gitSha: B, gitBranch: 'main', testGate: 'passed' })
		const flip = H.sets.at(-1)
		expect(flip).toMatchObject({ status: 'success', testGate: 'passed', gitSha: B, gitBranch: 'main', failedStep: null })
	})
	it('a newer deploy exists: only annotated, nothing else written', async () => {
		H.selects = [[reaped], [{ id: 'dep_2' }]]
		await finishDeploy('dep_1', { status: 'success', gitSha: 'b'.repeat(40), testGate: 'passed' })
		const last = H.sets.at(-1) ?? {}
		expect(last).not.toHaveProperty('status')
		expect(last).not.toHaveProperty('testGate')
		expect(String(last.error)).toContain('[late result]')
	})
	it('an unknown test gate value is not written', async () => {
		H.selects = [[reaped], []]
		await finishDeploy('dep_1', { status: 'success', testGate: 'bogus' as never })
		expect(H.sets.at(-1)).not.toHaveProperty('testGate')
	})
})
