import { beforeEach, describe, expect, it, vi } from 'vitest'

// The post-swap health gate reads health_url from powder's own DB. When that DB is slow
// (statement timeout), the gate must neither throw (that failed a live deploy) nor quietly
// fall back to a weaker probe: it uses the probe read before the swap, else the default
// probe with a warning line.
let selectThrows = 0
const healthCheckContainer = vi.fn(async (..._a: unknown[]) => ({ healthy: true, skipped: false, output: 'probe ok\n' }))

function statementTimeout(): Error {
	const cause = Object.assign(new Error('canceling statement due to statement timeout'), { name: 'PostgresError', code: '57014' })
	return Object.assign(new Error('Failed query: select "id", "health_url" from "app_repos"\nparams: s,app,1'), { cause })
}

vi.mock('../db', () => {
	const chain: Record<string, unknown> = {}
	for (const k of ['from', 'where', 'orderBy', 'innerJoin']) chain[k] = () => chain
	chain.limit = async () => {
		if (selectThrows-- > 0) throw statementTimeout()
		return [{ id: 'repo_1', healthUrl: '/api/health' }]
	}
	return {
		and: () => null,
		asc: () => null,
		desc: () => null,
		eq: () => null,
		isNotNull: () => null,
		isNull: () => null,
		notInArray: () => null,
		sql: () => null,
		createId: () => 'x',
		appDomains: {},
		appRepos: {},
		deploys: {},
		powderMeta: {},
		prefixes: {},
		db: { select: () => chain },
	}
})
vi.mock('../ssh', () => ({
	healthCheckContainer: (...a: unknown[]) => healthCheckContainer(...a),
	livenessCheckContainer: async () => ({ alive: true, output: '' }),
	composeFileArgs: () => '',
	envFileCandidatesFor: async () => [],
	inspectContainer: async () => ({}),
	restoreEnvSnapshot: async () => ({ output: '' }),
	rollbackToImage: async () => ({}),
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
	shellQuote: (s: string) => s,
}))
vi.mock('../deploy-bookkeeping', async (orig) => {
	const real = await orig<typeof import('../deploy-bookkeeping')>()
	return {
		...real,
		recordAfterSwap: (id: string, label: string, write: () => Promise<unknown>, opts?: object) =>
			real.recordAfterSwap(id, label, write, { ...opts, sleep: async () => {}, log: () => {} }),
	}
})

import { runHealthGate } from '../deploys'

const base = { server: { id: 's' } as never, serverId: 's', containerName: 'app', currentDeployId: 'dep_1' }
const probeOpts = () => healthCheckContainer.mock.calls.at(-1)?.[2] as { healthPath?: string; hostHeader?: string }

describe('runHealthGate when powder DB is slow', () => {
	beforeEach(() => {
		selectThrows = 0
		healthCheckContainer.mockClear()
	})
	it('a timeout that clears on retry uses the fresh health_url, no warning', async () => {
		selectThrows = 1
		const r = await runHealthGate(base)
		expect(r.healthy).toBe(true)
		expect(probeOpts().healthPath).toBe('/api/health')
		expect(r.output).not.toContain('warning')
	})
	it('a persistent timeout uses the probe read before the swap, with a warning, and does not throw', async () => {
		selectThrows = 99
		const r = await runHealthGate({ ...base, preSwapProbe: { path: '/healthz', host: 'app.example.com' } })
		expect(r.healthy).toBe(true)
		expect(probeOpts()).toMatchObject({ healthPath: '/healthz', hostHeader: 'app.example.com' })
		expect(r.output).toContain('using the one read before the swap (/healthz)')
	})
	it('with no pre-swap probe, the default probe runs and the output says the gate is weaker', async () => {
		selectThrows = 99
		const r = await runHealthGate(base)
		expect(healthCheckContainer).toHaveBeenCalledTimes(1)
		expect(probeOpts().healthPath).toBeUndefined()
		expect(r.output).toContain('could not read health_url')
		expect(r.output).toContain('weaker than a configured health_url')
	})
	it('an unhealthy container is still unhealthy', async () => {
		selectThrows = 99
		healthCheckContainer.mockResolvedValueOnce({ healthy: false, skipped: false, output: 'HTTP 500\n' })
		const r = await runHealthGate({ ...base, preSwapProbe: null })
		expect(r.healthy).toBe(false)
	})
})
