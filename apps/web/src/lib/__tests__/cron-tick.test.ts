import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fake cron_jobs table that evaluates the (eq / and) conditions the scheduler
// passes to UPDATE ... WHERE, so a conditional claim really succeeds only once.
type Job = {
	id: string
	enabled: boolean
	schedule: string
	timezone: string
	nextRunAt: Date | null
	kind: string
	lastRunAt?: Date
	runningSince: Date | null
	timeoutSeconds: number
	lastRunStatus: string | null
}
const state: {
	job: Job
	stale: Job[]
	selectDelay: Promise<void> | null
	selects: number
	runs: number
	inserts: Record<string, unknown>[]
} = {
	job: {} as Job,
	stale: [],
	selectDelay: null,
	selects: 0,
	runs: 0,
	inserts: [],
}

vi.mock('../db', () => {
	// biome-ignore lint/suspicious/noExplicitAny: permissive fake query builder
	const chain = (): any => new Proxy(() => {}, { get: (_t, p) => (p === 'then' ? undefined : chain()), apply: () => chain() })
	const eq = (col: string, val: unknown) => ({ col, val })
	const and = (...c: unknown[]) => c
	return {
		and,
		eq,
		isNull: (col: string) => ({ col, op: 'isNull' }),
		or: (...c: unknown[]) => ({ op: 'or', c }),
		lte: (col: string, val: unknown) => ({ col, val, op: 'lte' }),
		sql: () => ({}),
		createId: (p: string) => `${p}_x`,
		prefixes: { cronJobRun: 'cjr' },
		appDomains: {},
		appRepos: {},
		appEnvVars: {},
		appUptimeChecks: {},
		cronJobRuns: { id: 'runId' },
		schedulerHeartbeat: {},
		cronJobs: { id: 'id', nextRunAt: 'nextRunAt', enabled: 'enabled', runningSince: 'runningSince' },
		db: {
			execute: async () => [],
			insert: (table: unknown) => ({
				values: (v: Record<string, unknown>) => {
					if ((table as { id?: string }).id === 'runId') state.inserts.push(v)
					return Object.assign(Promise.resolve(), { onConflictDoUpdate: async () => {} })
				},
			}),
			select: () => ({
				from: () => ({
					where: async () => {
						state.selects++
						if (state.selectDelay) await state.selectDelay
						return state.stale
					},
				}),
			}),
			update: () => ({
				set: (vals: Record<string, unknown>) => ({
					where: (cond: unknown) => {
						type Cond = { col: string; val: unknown; op?: string; c?: Cond[] }
						const conds = (Array.isArray(cond) ? cond : [cond]) as Cond[]
						const test = (c: Cond): boolean => {
							if (c.op === 'or') return (c.c ?? []).some(test)
							const cur = (state.job as unknown as Record<string, unknown>)[c.col]
							if (c.op === 'isNull') return cur === null || cur === undefined
							if (c.op === 'lte') return (cur as Date | null) != null && (cur as Date).getTime() <= (c.val as Date).getTime()
							return c.val instanceof Date ? (cur as Date | null)?.getTime() === c.val.getTime() : cur === c.val
						}
						const run = async () => {
							// Only cron_jobs updates are evaluated against the fake row.
							if ('status' in vals) return [{ id: 'run' }]
							const ok = conds.every(test)
							if (ok) Object.assign(state.job, vals)
							if ('lastRunAt' in vals) state.runs++
							return ok ? [{ id: state.job.id }] : []
						}
						return { returning: run, then: (res: (v: unknown) => unknown) => run().then(res) }
					},
				}),
			}),
		},
	}
})
vi.mock('../crypto', () => ({ decryptSecret: () => '', encryptSecret: () => '' }))
vi.mock('../rate-limit', () => ({ pruneRateLimitBuckets: () => {} }))
vi.mock('../servers', () => ({ getServer: async () => null }))
vi.mock('../ssh', () => ({ runCommand: async () => ({}) }))

import { cronTick } from '../cron-scheduler'

const past = new Date(Date.now() - 5_000)

beforeEach(() => {
	state.job = {
		id: 'cron_1',
		enabled: true,
		schedule: '* * * * *',
		timezone: 'UTC',
		nextRunAt: past,
		kind: 'bogus',
		runningSince: null,
		timeoutSeconds: 30,
		lastRunStatus: null,
	}
	state.inserts = []
	state.stale = [{ ...state.job }]
	state.selectDelay = null
	state.selects = 0
	state.runs = 0
})

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('cron scheduler tick', () => {
	it('two scheduler passes that read the same due row run the job once', async () => {
		await cronTick()
		await cronTick() // second process / later pass with the same stale read
		await settle()
		expect(state.runs).toBe(1)
	})

	it('a due row whose timestamp has microsecond precision still fires (range claim, not equality)', async () => {
		// The DB keeps .123456; JS reads .123 back. Equality would never match.
		// Stored value is a sub-ms hair later than what JS read back.
		state.stale = [{ ...state.job, nextRunAt: past }]
		state.job.nextRunAt = new Date(past.getTime() + 1)
		await cronTick()
		await settle()
		expect(state.runs).toBe(1)
	})

	it('a tick still running when the next interval fires is not re-entered', async () => {
		let release!: () => void
		state.selectDelay = new Promise<void>((r) => {
			release = r
		})
		const first = cronTick()
		const second = cronTick()
		await second
		expect(state.selects).toBe(1)
		release()
		await first
		await settle()
		expect(state.runs).toBe(1)
	})

	it('overlap: a job whose previous run is still running is skipped and the skip is recorded', async () => {
		state.job.runningSince = new Date(Date.now() - 1_000)
		state.stale = [{ ...state.job }]
		await cronTick()
		await settle()
		expect(state.runs).toBe(0)
		expect(state.inserts.map((r) => r.status)).toEqual(['skipped'])
	})

	it('overlap: a running mark older than timeout + grace is stale and the job runs', async () => {
		state.job.runningSince = new Date(Date.now() - 10 * 60_000)
		state.stale = [{ ...state.job }]
		await cronTick()
		await settle()
		expect(state.runs).toBe(1)
		expect(state.inserts.map((r) => r.status)).toEqual(['running'])
		expect(state.job.runningSince).toBeNull()
	})
})
