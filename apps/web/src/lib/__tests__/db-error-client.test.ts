// A database error never reaches a client: routes answer a fixed message and
// log the detail (SQL, parameters, driver text) server-side.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_ERROR_MESSAGE, clientErrorMessage, isDbError } from '../pg-error'

vi.mock('server-only', () => ({}))

const h = vi.hoisted(() => ({ fail: null as Error | null }))
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ user: { id: 'u1' }, server: { id: 'boxa' } }),
}))
vi.mock('@/lib/deploys', () => ({
	listDeploysFor: async () => {
		if (h.fail) throw h.fail
		return []
	},
}))

// drizzle-orm's DrizzleQueryError shape: message "Failed query: ...", driver error on cause
function drizzleError(): Error {
	const cause = Object.assign(new Error('password authentication failed for user "admin"'), {
		name: 'PostgresError',
		code: '28P01',
	})
	return Object.assign(new Error('Failed query: select "id" from "deploys" where "server_id" = $1\nparams: boxa'), { cause })
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
	warn.mockRestore()
	h.fail = null
})

describe('clientErrorMessage', () => {
	it('recognises drizzle and postgres.js errors on the cause chain', () => {
		expect(isDbError(drizzleError())).toBe(true)
		expect(isDbError(Object.assign(new Error('relation "x" does not exist'), { name: 'PostgresError' }))).toBe(true)
		expect(isDbError(new Error('wrapper', { cause: drizzleError() }))).toBe(true)
		expect(isDbError(new Error('ssh: connect ECONNREFUSED 10.0.0.2:22'))).toBe(false)
		expect(isDbError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(false)
		expect(isDbError('Failed query: x')).toBe(false)
	})
	it('keeps an ordinary message, hides a database one and logs it', () => {
		expect(clientErrorMessage(new Error('key must match [A-Z_]+'), 'set failed', 't')).toBe('key must match [A-Z_]+')
		expect(clientErrorMessage('boom', 'set failed', 't')).toBe('set failed')
		expect(clientErrorMessage(drizzleError(), 'set failed', 't')).toBe(DB_ERROR_MESSAGE)
		expect(String(warn.mock.calls[0]?.[1])).toContain('Failed query:')
	})
})

describe('GET /api/servers/:id/containers/:name/deploys', () => {
	it('answers dbError "db unreachable" only and logs the detail', async () => {
		const { GET } = await import('@/app/api/servers/[id]/containers/[name]/deploys/route')
		h.fail = drizzleError()
		const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'boxa', name: 'zorbweb' }) })
		const body = await res.json()
		expect(body).toEqual({ deploys: [], dbError: 'db unreachable' })
		expect(JSON.stringify(body)).not.toContain('Failed query')
		expect(warn).toHaveBeenCalled()
		expect(String(warn.mock.calls[0]?.[1])).toContain('Failed query:')
	})
})

describe('routes', () => {
	const API = join(__dirname, '../../app/api')
	const routes: string[] = []
	const walk = (d: string) => {
		for (const e of readdirSync(d)) {
			const p = join(d, e)
			if (statSync(p).isDirectory()) walk(p)
			else if (e === 'route.ts') routes.push(p)
		}
	}
	walk(API)
	it('no route builds a client message from err.message without clientErrorMessage', () => {
		const bad: string[] = []
		for (const p of routes) {
			for (const line of readFileSync(p, 'utf8').split('\n')) {
				if (/console\.(warn|error|log)/.test(line)) continue
				if (/err instanceof Error \? err\.message/.test(line)) bad.push(`${p}: ${line.trim()}`)
			}
		}
		expect(bad).toEqual([])
	})
})
