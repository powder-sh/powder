// One authority for reading a Postgres SQLSTATE off a thrown error.
// drizzle-orm >= 0.44 wraps driver errors in DrizzleQueryError ("Failed query:
// ..."), with the pg error on `.cause`, so `err.code === '23505'` never matches.
// Never compare `.code` against a SQLSTATE literal directly (guard test:
// __tests__/pg-error-guard.test.ts); use pgErrorCode / isPgError.
const SQLSTATE = /^[0-9A-Z]{5}$/
const MAX_DEPTH = 5

export function pgErrorCode(err: unknown): string | undefined {
	let cur: unknown = err
	for (let i = 0; i < MAX_DEPTH && cur && typeof cur === 'object'; i++) {
		const code = (cur as { code?: unknown }).code
		if (typeof code === 'string' && SQLSTATE.test(code)) return code
		cur = (cur as { cause?: unknown }).cause
	}
	return undefined
}

export function isPgError(err: unknown, code: string): boolean {
	return pgErrorCode(err) === code
}

/** A database error: drizzle's DrizzleQueryError ("Failed query: <sql>\nparams:
 *  ..."), or postgres.js's PostgresError, anywhere on the cause chain. Its message
 *  carries SQL, parameters or driver detail and never goes to a client. */
export function isDbError(err: unknown): boolean {
	let cur: unknown = err
	for (let i = 0; i < MAX_DEPTH && cur && typeof cur === 'object'; i++) {
		const e = cur as { name?: unknown; message?: unknown; cause?: unknown }
		if (e.name === 'PostgresError') return true
		if (typeof e.message === 'string' && e.message.startsWith('Failed query:')) return true
		cur = e.cause
	}
	return false
}

// SQLSTATEs that mean "try again" rather than "this statement is wrong":
// 57014 statement timeout, 57P01-03 admin/crash shutdown or cannot connect now,
// class 08 connection exceptions, 53300 too many connections, 40001/40P01 retryable txn conflicts.
const TRANSIENT_SQLSTATE = /^(57014|57P0[123]|08[0-9A-Z]{3}|53300|40001|40P01)$/
// postgres.js and Node socket errors (no SQLSTATE).
const TRANSIENT_DRIVER_CODE = /^(CONNECTION_(CLOSED|ENDED|DESTROYED)|CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN)$/

/** A DB error worth retrying: statement timeout, connection loss, pool/connect timeout,
 *  anywhere on the cause chain. Pure. */
export function isTransientDbError(err: unknown): boolean {
	const state = pgErrorCode(err)
	if (state && TRANSIENT_SQLSTATE.test(state)) return true
	let cur: unknown = err
	for (let i = 0; i < MAX_DEPTH && cur && typeof cur === 'object'; i++) {
		const e = cur as { code?: unknown; message?: unknown; cause?: unknown }
		if (typeof e.code === 'string' && TRANSIENT_DRIVER_CODE.test(e.code)) return true
		if (typeof e.message === 'string' && /canceling statement due to statement timeout/i.test(e.message)) return true
		cur = e.cause
	}
	return false
}

export const DB_ERROR_MESSAGE = 'database error'

/** The message a route may show for `err`: its own message, or `fallback` for a
 *  non-Error. A database error is logged (console.warn with `tag`) and answered
 *  with DB_ERROR_MESSAGE only. */
export function clientErrorMessage(err: unknown, fallback: string, tag: string): string {
	if (isDbError(err)) {
		console.warn(`[${tag}] database error:`, err instanceof Error ? err.message : String(err))
		return DB_ERROR_MESSAGE
	}
	return err instanceof Error ? err.message : fallback
}
