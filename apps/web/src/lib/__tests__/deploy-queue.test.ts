// runOnServer: a work() that throws must reach the caller and nothing else. A
// cleanup of `void next.finally(...)` would leave its derived promise rejecting with
// the same error unhandled: one unhandledRejection per failed deploy, dumping the
// deploy's whole output into the worker log.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runOnServer } from '../deploy-queue'

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('runOnServer', () => {
	const seen: unknown[] = []
	const onUnhandled = (reason: unknown) => {
		seen.push(reason)
	}
	beforeEach(() => {
		seen.length = 0
		process.on('unhandledRejection', onUnhandled)
	})
	afterEach(() => {
		process.off('unhandledRejection', onUnhandled)
	})

	it('a throwing work() rejects for the caller, fires no unhandledRejection, and the next work still runs', async () => {
		const boom = new Error('deploy step failed')
		const failed = runOnServer('s-fail', async () => {
			throw boom
		})
		const after = runOnServer('s-fail', async () => 'next ran')
		await expect(failed).rejects.toBe(boom)
		await expect(after).resolves.toBe('next ran')
		await flush()
		expect(seen).toEqual([])
	})

	it('runs one work at a time per server, in order', async () => {
		const log: string[] = []
		let release!: () => void
		const gate = new Promise<void>((r) => {
			release = r
		})
		const a = runOnServer('s-order', async () => {
			log.push('a start')
			await gate
			log.push('a end')
		})
		const b = runOnServer('s-order', async () => {
			log.push('b')
		})
		await flush()
		expect(log).toEqual(['a start'])
		release()
		await Promise.all([a, b])
		expect(log).toEqual(['a start', 'a end', 'b'])
		await flush()
		expect(seen).toEqual([])
	})
})

describe('unhandledRejectionLogValue', () => {
	it('logs a DeployStepError as one line, not the whole deploy output', async () => {
		const { DeployStepError, unhandledRejectionLogValue } = await import('../deploy-failure')
		const output = `${'TAP line\n'.repeat(500)}ECONNREFUSED 127.0.0.1:5432\n`
		const err = new DeployStepError(output)
		const v = unhandledRejectionLogValue(err)
		expect(typeof v).toBe('string')
		expect(v as string).toMatch(/^DeployStepError failed_step=\S+ exit=\S+: /)
		expect(v as string).not.toContain('TAP line\nTAP line')
		const other = new Error('pool closed')
		expect(unhandledRejectionLogValue(other)).toBe(other)
	})
})
