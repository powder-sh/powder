// GET /api/internal/deploys is how an ops endpoint backfills a deploy event that never
// arrived: a failed row carries the step and exit code next to its summary, the step
// normalised as the event names it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FX } from './fixtures/secret-corpus'

const H = vi.hoisted(() => ({ terminal: [] as Record<string, unknown>[], selects: [] as Record<string, unknown>[] }))

vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ isAdmin: true }),
	hiddenSelfNames: () => [],
}))
vi.mock('@/lib/deploy-settle', () => ({ heldSql: () => 'false' }))
vi.mock('@/lib/db', () => {
	const col = (name: string) => ({ name })
	const deploys = new Proxy({}, { get: (_t, k) => col(String(k)) })
	let call = 0
	const chain = (rows: () => Record<string, unknown>[]) => {
		const c = { from: () => c, where: () => c, orderBy: () => c, limit: async () => rows() }
		return c
	}
	return {
		db: {
			select: (fields: Record<string, unknown>) => {
				H.selects.push(fields)
				call++
				return chain(() => (call % 2 === 1 ? H.terminal : []))
			},
		},
		deploys,
		and: () => null,
		asc: () => null,
		inArray: () => null,
		notInArray: () => null,
		sql: Object.assign(() => null, { raw: () => null }),
	}
})

describe('GET /api/internal/deploys', () => {
	beforeEach(() => {
		H.selects = []
		H.terminal = [
			{ id: 'dep_1', server: 'srv-1', app: 'shop', status: 'failed', kind: 'git_deploy', errorSummary: 'test-failure: first failing file: src/a.test.ts', failedStep: 'docker compose build (local build)', exitCode: 17, error: 'x' },
			{ id: 'dep_2', server: 'srv-1', app: 'shop', status: 'success', kind: 'git_deploy', errorSummary: null, failedStep: null, exitCode: null, error: null },
			{ id: 'dep_3', server: 'srv-1', app: 'shop', status: 'failed', kind: 'git_deploy', errorSummary: 'failed during: unknown', failedStep: `build https://u:${FX.GHP}@x`, exitCode: 1, error: 'x' },
		]
	})
	it('returns failedStep (as the deploy event names it) and exitCode next to errorSummary', async () => {
		const { GET } = await import('@/app/api/internal/deploys/route')
		const body = (await (await GET(new Request('https://dash.example/api/internal/deploys'))).json()) as { deploys: Record<string, unknown>[] }
		expect(H.selects[0]).toHaveProperty('failedStep')
		expect(H.selects[0]).toHaveProperty('exitCode')
		expect(body.deploys[0]).toMatchObject({ errorSummary: 'test-failure: first failing file: src/a.test.ts', failedStep: 'docker compose build local build', exitCode: 17 })
		expect(body.deploys[1]).toMatchObject({ failedStep: null, exitCode: null })
		// a stored step carrying a secret (a forged trailer) leaves as unknown
		expect(body.deploys[2]).toMatchObject({ failedStep: 'unknown' })
		expect(JSON.stringify(body.deploys[2])).not.toContain(FX.GHP)
	})
})
