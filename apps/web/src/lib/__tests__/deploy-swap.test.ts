import { describe, expect, it } from 'vitest'
import { POST_SWAP_STEPS, failedBeforeSwap, rollbackChangesNothing } from '../deploy-swap'
import { shouldRestoreEnv, shouldRollbackAfterFailure } from '../deploy-runner'

// "Roll back to <sha>" offered the version already running after a failure before the
// swap. Whether a deploy swapped comes from the runner's own step knowledge (one list).
describe('failedBeforeSwap', () => {
	it('a known pre-swap step: yes; a swap step, a post-swap check, unknown or watchdog: no', () => {
		for (const s of ['build', 'test gate', 'db migrate', 'swap-check', 'preflight', 'superseded', 'queue']) expect(failedBeforeSwap(s), s).toBe(true)
		for (const s of [...POST_SWAP_STEPS, 'health check', 'image readback', 'watchdog', null]) expect(failedBeforeSwap(s), String(s)).toBe(false)
	})
	it('the runner reads the same list', () => {
		for (const s of POST_SWAP_STEPS) {
			expect(shouldRollbackAfterFailure(s, true)).toBe(true)
			expect(shouldRestoreEnv(s)).toBe(false)
		}
	})
})

describe('rollbackChangesNothing', () => {
	const good = { id: 'dep_good', status: 'success' }
	const failed = { id: 'dep_bad', status: 'failed', failedStep: 'build' }
	it('a pre-swap failure right after the last good deploy: the rollback would recreate what runs', () => {
		expect(rollbackChangesNothing(failed, good, [good, failed])).toBe(true)
		expect(rollbackChangesNothing(failed, good, [good, { id: 'dep_x', status: 'failed', failedStep: 'test gate' }, failed])).toBe(true)
	})
	it('offered when it would change what runs', () => {
		// the failure itself may have swapped
		expect(rollbackChangesNothing({ ...failed, failedStep: 'health check' }, good, [good])).toBe(false)
		expect(rollbackChangesNothing({ ...failed, failedStep: null }, good, [good])).toBe(false)
		// something since then changed what runs, or may have
		expect(rollbackChangesNothing(failed, good, [good, { id: 'dep_r', status: 'success' }, failed])).toBe(false)
		expect(rollbackChangesNothing(failed, good, [good, { id: 'dep_p', status: 'failed', failedStep: 'docker compose up' }, failed])).toBe(false)
		expect(rollbackChangesNothing(failed, good, [good, { id: 'dep_w', status: 'running' }])).toBe(false)
		// no target, or a list cut short
		expect(rollbackChangesNothing(failed, null, [])).toBe(false)
		expect(rollbackChangesNothing(failed, good, [good], false)).toBe(false)
	})
})
