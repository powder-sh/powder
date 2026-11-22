// The ci tab's own checks: the stored test gate result (deploys.test_gate) as the tab
// shows it, the failed-stage words and the 30-day summary line.
import { describe, expect, it } from 'vitest'
import {
	type CiTestGate,
	checksSummaryLine,
	ciTestGate,
	failedStage,
	gateDisplay,
	isSuperseded,
	lacksTestGate,
} from '../ci-checks'

describe('ciTestGate', () => {
	it('a git deploy shows the stored value; NULL is unknown', () => {
		expect(ciTestGate('git_deploy', 'passed')).toBe('passed')
		expect(ciTestGate('git_deploy', 'failed')).toBe('failed')
		expect(ciTestGate('git_deploy', 'none')).toBe('none')
		expect(ciTestGate('git_deploy', null)).toBe('unknown')
		expect(ciTestGate('git_deploy', undefined)).toBe('unknown')
	})
	it('a rollback runs no gate: always unknown', () => {
		expect(ciTestGate('rollback', null)).toBe('unknown')
		expect(ciTestGate('rollback', 'passed')).toBe('unknown')
	})
})

describe('gateDisplay: every combination of failed_step and test_gate', () => {
	const show = (
		status: string,
		failedStep: string | null,
		testGate: CiTestGate,
		superseded = false,
	) => gateDisplay({ status, superseded, failedStep, testGate })

	it('a successful deploy shows its recorded gate, nothing when unknown', () => {
		expect(show('success', null, 'passed')).toEqual({ badge: 'passed', failedAt: null })
		expect(show('success', null, 'none')).toEqual({ badge: 'none', failedAt: null })
		expect(show('success', null, 'unknown')).toEqual({ badge: null, failedAt: null })
		// not written by the runner for a success; shown as recorded, never hidden
		expect(show('success', null, 'failed')).toEqual({ badge: 'failed', failedAt: null })
	})
	it('failed at the test gate and recorded failed: the failure line says it, no badge', () => {
		expect(show('failed', 'test gate', 'failed')).toEqual({ badge: null, failedAt: 'test gate' })
	})
	it('failed_step test gate with nothing recorded: the step line only, no badge', () => {
		expect(show('failed', 'test gate', 'unknown')).toEqual({ badge: null, failedAt: 'test gate' })
	})
	it('recorded failed with another failed_step: both facts', () => {
		expect(show('failed', 'health check', 'failed')).toEqual({
			badge: 'failed',
			failedAt: 'health check',
		})
	})
	it('recorded failed with no failed_step: the line names the test gate, no badge', () => {
		expect(show('failed', null, 'failed')).toEqual({ badge: null, failedAt: 'test gate' })
		expect(show('failed', '', 'failed')).toEqual({ badge: null, failedAt: 'test gate' })
	})
	it('passed the gate, then failed at a later step: both facts', () => {
		expect(show('failed', 'db migrate', 'passed')).toEqual({
			badge: 'passed',
			failedAt: 'db migrate',
		})
		expect(show('failed', null, 'passed')).toEqual({
			badge: 'passed',
			failedAt: 'an unrecorded step',
		})
	})
	it('no test gate, then failed: both facts', () => {
		expect(show('failed', 'health check', 'none')).toEqual({
			badge: 'none',
			failedAt: 'health check',
		})
	})
	it('nothing recorded and failed before the gate: the step line only', () => {
		expect(show('failed', 'docker compose build', 'unknown')).toEqual({
			badge: null,
			failedAt: 'docker compose build',
		})
		expect(show('failed', null, 'unknown')).toEqual({ badge: null, failedAt: 'an unrecorded step' })
	})
	it('a superseded row did nothing: no badge, not a failure', () => {
		expect(show('failed', 'superseded', 'unknown', true)).toEqual({ badge: null, failedAt: null })
		expect(show('failed', 'superseded', 'passed', true)).toEqual({ badge: null, failedAt: null })
	})
	it('a running or queued row shows the gate once it is recorded', () => {
		expect(show('running', null, 'unknown')).toEqual({ badge: null, failedAt: null })
		expect(show('running', null, 'passed')).toEqual({ badge: 'passed', failedAt: null })
	})
})

describe('failedStage', () => {
	it('groups the recorded steps into stage words', () => {
		expect(failedStage('docker compose build')).toBe('build')
		expect(failedStage('docker compose build (local build)')).toBe('build')
		expect(failedStage('build')).toBe('build')
		expect(failedStage('test gate')).toBe('test gate')
		expect(failedStage('preflight')).toBe('preflight')
		expect(failedStage('preflight pages-test-files')).toBe('preflight')
		expect(failedStage('preflight git auth')).toBe('preflight')
		expect(failedStage('compose guard (pre-up)')).toBe('compose guard')
		expect(failedStage('db migrate')).toBe('migrate')
		expect(failedStage('health check')).toBe('health check')
		expect(failedStage('env render')).toBe('env render')
		expect(failedStage(null)).toBe('no step recorded')
	})
})

describe('checksSummaryLine', () => {
	it('counts finished deploys and names the failed stages, most first', () => {
		expect(
			checksSummaryLine([
				{ status: 'success', failedStep: null, count: 39 },
				{ status: 'failed', failedStep: 'docker compose build', count: 1 },
				{ status: 'failed', failedStep: 'test gate', count: 1 },
				{ status: 'running', failedStep: null, count: 1 },
			]),
		).toBe('30 days: 41 deploys, 2 failed (1 build, 1 test gate)')
	})
	it('merges steps of one stage', () => {
		expect(
			checksSummaryLine([
				{ status: 'failed', failedStep: 'preflight', count: 2 },
				{ status: 'failed', failedStep: 'preflight git auth', count: 1 },
				{ status: 'failed', failedStep: null, count: 1 },
			]),
		).toBe('30 days: 4 deploys, 4 failed (3 preflight, 1 no step recorded)')
	})
	it('superseded deploys are neither deploys nor failures', () => {
		expect(isSuperseded({ status: 'failed', failedStep: 'superseded' })).toBe(true)
		expect(isSuperseded({ status: 'failed', failedStep: 'test gate' })).toBe(false)
		expect(isSuperseded({ status: 'success', failedStep: null })).toBe(false)
		expect(
			checksSummaryLine([
				{ status: 'success', failedStep: null, count: 5 },
				{ status: 'failed', failedStep: 'superseded', count: 3 },
				{ status: 'failed', failedStep: 'db migrate', count: 1 },
			]),
		).toBe('30 days: 6 deploys, 1 failed (1 migrate)')
		expect(checksSummaryLine([{ status: 'failed', failedStep: 'superseded', count: 2 }])).toBe(
			'30 days: no deploys',
		)
	})
	it('a failed deploy with no failed_step and a recorded failed gate counts as test gate', () => {
		expect(
			checksSummaryLine([
				{ status: 'failed', failedStep: null, testGate: 'failed', count: 1 },
				{ status: 'failed', failedStep: null, testGate: null, count: 1 },
				{ status: 'failed', failedStep: 'health check', testGate: 'failed', count: 1 },
			]),
		).toBe('30 days: 3 deploys, 3 failed (1 health check, 1 no step recorded, 1 test gate)')
	})
	it('no failures and no deploys read plainly', () => {
		expect(checksSummaryLine([{ status: 'success', failedStep: null, count: 1 }])).toBe(
			'30 days: 1 deploy, none failed',
		)
		expect(checksSummaryLine([])).toBe('30 days: no deploys')
	})
})

describe('lacksTestGate', () => {
	it('is true only when the newest successful git deploy is recorded as none', () => {
		expect(
			lacksTestGate([
				{ kind: 'git_deploy', status: 'failed', testGate: 'failed' },
				{ kind: 'rollback', status: 'success', testGate: 'unknown' },
				{ kind: 'git_deploy', status: 'success', testGate: 'none' },
			]),
		).toBe(true)
		expect(
			lacksTestGate([
				{ kind: 'git_deploy', status: 'success', testGate: 'passed' },
				{ kind: 'git_deploy', status: 'success', testGate: 'none' },
			]),
		).toBe(false)
	})
	it('unknown (NULL) or no deploy is no notice', () => {
		expect(lacksTestGate([{ kind: 'git_deploy', status: 'success', testGate: 'unknown' }])).toBe(
			false,
		)
		expect(
			lacksTestGate([
				{ kind: 'git_deploy', status: 'success', testGate: 'unknown' },
				{ kind: 'git_deploy', status: 'success', testGate: 'none' },
			]),
		).toBe(false)
		expect(lacksTestGate([])).toBe(false)
	})
})
