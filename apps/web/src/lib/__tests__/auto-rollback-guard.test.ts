// auto-rollback must get its approval from checkComposeForRecreate (after
// the env snapshot restore), and a refusal must stop the recreate.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
const state = { refuse: false }
const rollbackToImage = vi.fn(async (..._a: unknown[]) => {
	order.push('rollback')
	throw new Error('stop after capture')
})
vi.mock('../db', () => {
	const chain: Record<string, unknown> = {}
	for (const k of ['from', 'where', 'orderBy']) chain[k] = () => chain
	chain.limit = async () => [{ id: 'dep_prev', imageTag: 'shopx:deploy-1' }]
	return {
		and: () => null, appDomains: {}, appRepos: {}, asc: () => null, createId: () => 'x', deploys: {}, desc: () => null,
		eq: () => null, isNotNull: () => null, isNull: () => null, notInArray: () => null, prefixes: {}, sql: () => null,
		db: { select: () => chain },
	}
})
vi.mock('../ssh', () => ({
	composeFileArgs: () => '',
	envFileCandidatesFor: async () => ['/opt/apps/shopx.env'],
	healthCheckContainer: async () => ({}),
	inspectContainer: async () => ({ image: 'shopx:latest' }),
	livenessCheckContainer: async () => ({}),
	restoreEnvSnapshot: async () => {
		order.push('env')
		return { output: '' }
	},
	rollbackToImage: (...a: unknown[]) => rollbackToImage(...a),
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
	shellQuote: (s: string) => s,
}))
vi.mock('../recreate-guard', () => ({
	checkComposeForRecreate: async (_s: unknown, p: { app: string; what: string }) => {
		order.push(`guard:${p.app}:${p.what}`)
		if (state.refuse) throw new Error('auto-rollback refused: [privileged]')
		return { hash: 'f'.repeat(64), app: p.app, log: 'checked\n' }
	},
}))

const { autoRollback } = await import('../deploys')

const opts = {
	server: { id: 'boxa', host: 'h', user: 'root' } as never,
	serverId: 'boxa',
	containerName: 'shopx',
	configFile: '/opt/apps/shopx/docker-compose.yml',
	service: 'shopx',
	workingDir: '/opt/apps/shopx',
	currentDeployId: 'dep_now',
	reason: 'health gate failed',
}

beforeEach(() => {
	order.length = 0
	state.refuse = false
	rollbackToImage.mockClear()
})

describe('autoRollback runs the recreate guard', () => {
	it('checks after the env restore and hands the guard approval to the recreate', async () => {
		await autoRollback(opts)
		expect(order).toEqual(['env', 'guard:shopx:auto-rollback', 'rollback'])
		const passed = rollbackToImage.mock.calls[0]?.[6] as { approval?: { hash: string } }
		expect(passed.approval?.hash).toBe('f'.repeat(64))
	})
	it('a refusal stops the recreate', async () => {
		state.refuse = true
		const r = await autoRollback(opts)
		expect(rollbackToImage).not.toHaveBeenCalled()
		expect(r.rollbackError).toContain('refused')
		expect(r.rolledBackTo).toBeNull()
	})
})
