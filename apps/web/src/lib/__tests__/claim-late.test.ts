import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimWithLateDispatch } from '../claim-late'

afterEach(() => vi.useRealTimers())

describe('claimWithLateDispatch', () => {
	it('a claim that resolves after the timeout is still dispatched', async () => {
		vi.useFakeTimers()
		const dispatch = vi.fn()
		const claim = new Promise<{ id: string } | null>((r) => setTimeout(() => r({ id: 'dep_1' }), 31_000))
		const p = claimWithLateDispatch(claim, 30_000, 'claimNextQueuedDeploy', dispatch)
		const assertion = expect(p).rejects.toThrow(/timed out/)
		await vi.advanceTimersByTimeAsync(30_000)
		await assertion
		expect(dispatch).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1_500)
		expect(dispatch).toHaveBeenCalledWith({ id: 'dep_1' })
	})

	it('a claim inside the timeout is returned and NOT dispatched twice', async () => {
		const dispatch = vi.fn()
		const row = await claimWithLateDispatch(Promise.resolve({ id: 'dep_2' }), 30_000, 'c', dispatch)
		expect(row).toEqual({ id: 'dep_2' })
		await Promise.resolve()
		expect(dispatch).not.toHaveBeenCalled()
	})

	it('a late null claim dispatches nothing', async () => {
		vi.useFakeTimers()
		const dispatch = vi.fn()
		const claim = new Promise<null>((r) => setTimeout(() => r(null), 40_000))
		const p = claimWithLateDispatch(claim, 30_000, 'c', dispatch).catch(() => 'timeout')
		await vi.advanceTimersByTimeAsync(41_000)
		expect(await p).toBe('timeout')
		expect(dispatch).not.toHaveBeenCalled()
	})
})
