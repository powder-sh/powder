import { describe, expect, it } from 'vitest'
import { POWDER_DB_SLOW_SUMMARY, isPowderDbError, isTransientDbError, recordAfterSwap } from '../deploy-bookkeeping'
import { deployFailureFromError } from '../deploy-failure'

const pgError = (code: string, message = 'boom') => Object.assign(new Error(message), { name: 'PostgresError', code })
const drizzle = (cause: unknown) =>
	Object.assign(new Error('Failed query: update "deploys" set "git_sha" = $1, "git_branch" = $2 where "deploys"."id" = $3\nparams: abc123,main,dep_1'), { cause })
const noWait = { sleep: async () => {}, log: () => {} }

describe('isTransientDbError', () => {
	it('statement timeout, connection loss and postgres.js connection errors retry', () => {
		expect(isTransientDbError(drizzle(pgError('57014', 'canceling statement due to statement timeout')))).toBe(true)
		expect(isTransientDbError(pgError('08006'))).toBe(true)
		expect(isTransientDbError(pgError('57P01'))).toBe(true)
		expect(isTransientDbError(Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' }))).toBe(true)
		expect(isTransientDbError(drizzle(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })))).toBe(true)
	})
	it('a real query error does not retry', () => {
		expect(isTransientDbError(drizzle(pgError('23505', 'duplicate key')))).toBe(false)
		expect(isTransientDbError(new Error('x'))).toBe(false)
	})
})

describe('isPowderDbError', () => {
	it('is the DB layer only, not an SSH socket error', () => {
		expect(isPowderDbError(drizzle(pgError('57014')))).toBe(true)
		expect(isPowderDbError(pgError('23505'))).toBe(true)
		expect(isPowderDbError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED' }))).toBe(false)
		expect(isPowderDbError(new Error('SSH timeout to 1.2.3.4'))).toBe(false)
	})
})

describe('recordAfterSwap', () => {
	it('retries a transient error and returns the value', async () => {
		let n = 0
		const r = await recordAfterSwap('d', 'x', async () => {
			if (n++ < 2) throw drizzle(pgError('57014'))
			return 7
		}, noWait)
		expect(r).toEqual({ ok: true, value: 7 })
		expect(n).toBe(3)
	})
	it('is bounded and never throws; logs once', async () => {
		let n = 0
		const logs: string[] = []
		const r = await recordAfterSwap('d', 'x', async () => {
			n++
			throw drizzle(pgError('57014'))
		}, { ...noWait, delaysMs: [1, 1, 1], log: (m) => logs.push(m) })
		expect(r.ok).toBe(false)
		expect(n).toBe(4)
		expect(logs).toHaveLength(1)
	})
	it('does not retry a non-transient error', async () => {
		let n = 0
		const r = await recordAfterSwap('d', 'x', async () => {
			n++
			throw drizzle(pgError('23505'))
		}, noWait)
		expect(r.ok).toBe(false)
		expect(n).toBe(1)
	})
})

describe('deployFailureFromError on powder DB errors', () => {
	it('summarizes as powder-side DB slowness, never the query or its params', () => {
		const f = deployFailureFromError(drizzle(pgError('57014', 'canceling statement due to statement timeout')))
		expect(f.errorSummary).toBe(POWDER_DB_SLOW_SUMMARY)
		expect(f.errorSummary).not.toContain('params')
		expect(f.error).not.toContain('params:')
		expect(f.error).toContain('statement timeout')
		expect(f.failedStep).toBeNull()
	})
	it('a non-DB error keeps its parsed summary', () => {
		expect(deployFailureFromError(new Error('SSH timeout to 1.2.3.4')).errorSummary).toContain('SSH timed out')
	})
})
