import { beforeEach, describe, expect, it, vi } from 'vitest'

// finishDeploy tells the runner who owns a late failure's event: a row the watchdog reaped
// ('reaped': the reap sent it) or a row that already holds this run's own result
// ('already-recorded': its earlier write landed and only the reply was lost). Decided from
// the row recordLateResult reads anyway; no extra statement.
const H = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, updates: 0 }))

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const update = () => {
		const c = {
			set: () => c,
			where: () => c,
			// the result UPDATE matches nothing: the row is terminal already
			returning: async () => [],
			then: (ok: (v: unknown) => unknown) => {
				H.updates++
				return ok(undefined)
			},
		}
		return c
	}
	const select = () => {
		const c = { from: () => c, where: () => c, limit: async () => (H.row ? [H.row] : []) }
		return c
	}
	return { ...real, db: { update, select } }
})

import { finishDeploy, reapedByWatchdog } from '../deploys'
import { QUEUED_REAP_NOTE, RUNNING_REAP_NOTE } from '../deploy-watchdog-reason'

const row = (extra: Record<string, unknown>) => ({
	id: 'dep_1',
	serverId: 'srv-1',
	containerName: 'shop',
	status: 'failed',
	startedAt: new Date(),
	output: '',
	error: 'boom',
	failedStep: 'build',
	...extra,
})

beforeEach(() => {
	H.row = null
	H.updates = 0
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('finishDeploy on a terminal row', () => {
	it('its own earlier failed result: already-recorded, nothing written', async () => {
		H.row = row({})
		await expect(finishDeploy('dep_1', { status: 'failed', error: 'boom' })).resolves.toBe('already-recorded')
		expect(H.updates).toBe(0)
	})
	it('reaped by the watchdog (its note): reaped, annotated', async () => {
		H.row = row({ error: RUNNING_REAP_NOTE, failedStep: null })
		await expect(finishDeploy('dep_1', { status: 'failed', error: 'boom' })).resolves.toBe('reaped')
		expect(H.updates).toBe(1)
	})
	it('reaped, the note annotated already: still reaped', async () => {
		H.row = row({ error: `${QUEUED_REAP_NOTE}\n[late result] the executor finished with 'failed' at t`, failedStep: 'queue' })
		await expect(finishDeploy('dep_1', { status: 'failed', error: 'boom' })).resolves.toBe('reaped')
	})
	it("the run's own write whose script marker named the watchdog's step: already-recorded, no note", async () => {
		H.row = row({ error: 'x\n__POWDER_FAIL__ step=watchdog code=1', failedStep: 'watchdog' })
		await expect(finishDeploy('dep_1', { status: 'failed', error: 'boom' })).resolves.toBe('already-recorded')
		expect(H.updates).toBe(0)
		H.row = row({ error: 'x', failedStep: 'queue' })
		await expect(finishDeploy('dep_1', { status: 'failed', error: 'boom' })).resolves.toBe('already-recorded')
	})
	it('an app that prints a fake reap note: its own landed write is already-recorded (the event is sent)', async () => {
		// a step failure stores the end of the app's log in error; the app printed the note
		const forged = `${RUNNING_REAP_NOTE}\nmore app output\n__POWDER_FAIL__ step=build code=1`
		H.row = row({ error: forged, failedStep: 'build' })
		await expect(finishDeploy('dep_1', { status: 'failed', error: forged })).resolves.toBe('already-recorded')
		expect(H.updates).toBe(0)
		// a bare prefix, as before, is not a reap either
		H.row = row({ error: '[watchdog] deploy stuck in running (fake)', failedStep: 'build' })
		await expect(finishDeploy('dep_1', { status: 'failed', error: 'something else' })).resolves.toBe('already-recorded')
	})
	it("only the exact reap notes decide, after this run's own result", () => {
		expect(reapedByWatchdog({ status: 'failed', error: QUEUED_REAP_NOTE })).toBe(true)
		expect(reapedByWatchdog({ status: 'failed', error: `${RUNNING_REAP_NOTE}\n[late result] x` })).toBe(true)
		expect(reapedByWatchdog({ status: 'failed', error: '[watchdog] deploy stuck in queued' })).toBe(false)
		expect(reapedByWatchdog({ status: 'failed', error: 'x' })).toBe(false)
		expect(reapedByWatchdog({ status: 'success', error: RUNNING_REAP_NOTE })).toBe(false)
		// the row holds what this run sent: its own write, whatever the text says
		expect(reapedByWatchdog({ status: 'failed', error: QUEUED_REAP_NOTE }, { status: 'failed', error: QUEUED_REAP_NOTE })).toBe(false)
	})
})
