import { describe, expect, it } from 'vitest'
import {
	BUILDER_SCRIPT_RESERVE_SEC,
	DEPLOY_BUDGET_SEC,
	HARD_CAP_MIN,
	STUCK_AFTER_MIN,
	WORKER_STOP_GRACE_MIN,
	deployChainMaxSec,
	deployDeadlineAt,
	outerTimeoutSec,
	remainingBudgetSec,
	sshWallMs,
} from '../deploy-budget'

describe('deploy budget ordering', () => {
	it('the watchdog caps and the worker grace all exceed the full chain', () => {
		expect(HARD_CAP_MIN * 60).toBeGreaterThan(deployChainMaxSec())
		expect(STUCK_AFTER_MIN * 60).toBeGreaterThan(deployChainMaxSec())
		expect(WORKER_STOP_GRACE_MIN).toBeGreaterThan(HARD_CAP_MIN)
	})
	it('the SSH wall sits above the outer timeout', () => {
		expect(sshWallMs(DEPLOY_BUDGET_SEC)).toBeGreaterThan(outerTimeoutSec(DEPLOY_BUDGET_SEC) * 1000)
		expect(sshWallMs(DEPLOY_BUDGET_SEC)).toBe(deployChainMaxSec() * 1000)
	})
	it('builder phase + script share ONE deadline from claim time', () => {
		const claim = Date.parse('2026-01-01T00:00:00Z')
		const deadline = deployDeadlineAt(claim)
		expect(remainingBudgetSec(deadline, claim)).toBe(DEPLOY_BUDGET_SEC)
		// 40 minutes into the builder phase: the script only gets what is left
		expect(remainingBudgetSec(deadline, claim + 40 * 60_000)).toBe(DEPLOY_BUDGET_SEC - 40 * 60)
		// spent budget still yields a positive floor
		expect(remainingBudgetSec(deadline, claim + 2 * DEPLOY_BUDGET_SEC * 1000)).toBeGreaterThan(0)
		expect(BUILDER_SCRIPT_RESERVE_SEC).toBeLessThan(DEPLOY_BUDGET_SEC)
	})
})
