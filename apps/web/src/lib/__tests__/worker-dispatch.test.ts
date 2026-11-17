import { describe, expect, it, vi } from 'vitest'
import { makeDispatch } from '../worker-dispatch'

const deploy = { id: 'dep_1', serverId: 's1', containerName: 'app' } as never

function setup(draining: boolean) {
	const execute = vi.fn(async () => {})
	const requeue = vi.fn(async () => 'requeued')
	const inFlightServers = new Set<string>()
	const inFlightDeploys = new Set<Promise<void>>()
	const dispatch = makeDispatch({ isDraining: () => draining, execute, requeue, inFlightServers, inFlightDeploys })
	return { execute, requeue, inFlightServers, inFlightDeploys, dispatch }
}

describe('worker dispatch', () => {
	it('running normally: executes the claimed deploy and tracks the server', async () => {
		const t = setup(false)
		t.dispatch(deploy)
		expect(t.execute).toHaveBeenCalledWith(deploy)
		expect(t.requeue).not.toHaveBeenCalled()
		expect(t.inFlightServers.has('s1')).toBe(true)
		await Promise.all([...t.inFlightDeploys])
		expect(t.inFlightServers.size).toBe(0)
		expect(t.inFlightDeploys.size).toBe(0)
	})
	it('draining: flips the row back to queued instead of running it, and the drain waits for the flip', async () => {
		const t = setup(true)
		t.dispatch(deploy)
		expect(t.execute).not.toHaveBeenCalled()
		expect(t.requeue).toHaveBeenCalledWith('dep_1')
		expect(t.inFlightServers.size).toBe(0)
		expect(t.inFlightDeploys.size).toBe(1) // shutdown awaits it before process.exit
		await Promise.all([...t.inFlightDeploys])
		expect(t.inFlightDeploys.size).toBe(0)
	})
	it('a failing requeue is logged, never thrown', async () => {
		const t = setup(true)
		t.requeue.mockRejectedValueOnce(new Error('db down'))
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		t.dispatch(deploy)
		await Promise.all([...t.inFlightDeploys])
		expect(err).toHaveBeenCalled()
		err.mockRestore()
	})
})
