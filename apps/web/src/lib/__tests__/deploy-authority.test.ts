import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Guard for the whole class "a deploy row reaches running but is not executed by
// executeDeploy": the only code allowed to call rebuildDeploy( is the runner.
// preview-deploys.ts is excepted until previews are folded into the runner.
const SRC = join(__dirname, '..', '..')
function walk(dir: string, out: string[] = []): string[] {
	for (const n of readdirSync(dir)) {
		if (n === 'node_modules' || n === '__tests__') continue
		const p = join(dir, n)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (/\.(ts|tsx)$/.test(n)) out.push(p)
	}
	return out
}

describe('single deploy execution authority', () => {
	it('only deploy-runner.ts and preview-deploys.ts call rebuildDeploy(', () => {
		const callers = walk(SRC)
			.filter((f) => /\brebuildDeploy\(/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(SRC, f).replace(/\\/g, '/'))
			// the definition itself
			.filter((f) => f !== 'lib/deploy/run.ts')
			.sort()
		expect(callers).toEqual(['lib/deploy-runner.ts', 'lib/preview-deploys.ts'])
	})
})

const runInWeb = vi.fn()
const startDeploy = vi.fn()
let workerOn = false
vi.mock('../deploy-runner', () => ({ runInWeb: (...a: unknown[]) => runInWeb(...a) }))
vi.mock('../deploys', () => {
	class DeployInFlightError extends Error {
		coalesced = false
	}
	return {
		DeployInFlightError,
		deployWorkerEnabled: () => workerOn,
		startDeploy: (...a: unknown[]) => startDeploy(...a),
	}
})
vi.mock('../hq', () => ({ reportDeployToHq: async () => {} }))

describe('pending-redeploy catch-up', () => {
	afterEach(() => {
		vi.useRealTimers()
		runInWeb.mockReset()
		startDeploy.mockReset()
	})
	async function runTick(on: boolean) {
		workerOn = on
		vi.useFakeTimers()
		const row = { id: 'dep_x' }
		startDeploy.mockResolvedValue(row)
		const { schedulePendingRedeploy } = await import('../pending-redeploy')
		schedulePendingRedeploy({ serverId: `s${on}`, containerName: 'a', triggeredBy: 't' })
		await vi.advanceTimersByTimeAsync(15_001)
		return row
	}
	it('in-web mode (POWDER_DEPLOY_WORKER off): runs the started row inline', async () => {
		const row = await runTick(false)
		expect(runInWeb).toHaveBeenCalledWith(row)
	})
	it('worker flag on: leaves the row to the worker', async () => {
		await runTick(true)
		expect(runInWeb).not.toHaveBeenCalled()
	})
})
