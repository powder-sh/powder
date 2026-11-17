import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPgError, pgErrorCode } from '../pg-error'

// web has no direct drizzle-orm dep; resolve the copy @powder/db uses.
const req = createRequire(join(__dirname, '../../../../../packages/db/package.json'))
const { DrizzleQueryError } = req('drizzle-orm') as {
	DrizzleQueryError: new (q: string, p: unknown[], cause?: Error) => Error
}

const pgErr = (code: string) => Object.assign(new Error('duplicate key value violates unique constraint'), { code })

describe('pgErrorCode', () => {
	it('reads the code off a bare pg error', () => {
		expect(pgErrorCode(pgErr('23505'))).toBe('23505')
	})
	it('reads the code through a real DrizzleQueryError', () => {
		const wrapped = new DrizzleQueryError('insert into deploys ...', [1], pgErr('23505'))
		expect((wrapped as { code?: string }).code).toBeUndefined()
		expect(pgErrorCode(wrapped)).toBe('23505')
		expect(isPgError(wrapped, '23505')).toBe(true)
		expect(isPgError(wrapped, '23503')).toBe(false)
	})
	it('walks several cause levels', () => {
		const e = new Error('a', { cause: new Error('b', { cause: pgErr('40001') }) })
		expect(pgErrorCode(e)).toBe('40001')
	})
	it('ignores non-SQLSTATE codes (node errno strings, numbers)', () => {
		expect(pgErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBeUndefined()
		expect(pgErrorCode({ code: 23505 })).toBeUndefined()
		expect(pgErrorCode(null)).toBeUndefined()
		expect(pgErrorCode('23505')).toBeUndefined()
	})
	it('survives a cause cycle', () => {
		const a: { cause?: unknown } = {}
		a.cause = a
		expect(pgErrorCode(a)).toBeUndefined()
	})
})
