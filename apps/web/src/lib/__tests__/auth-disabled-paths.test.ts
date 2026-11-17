// better-auth endpoints the UI does not call answer 404 through the real
// handler; the ones it calls still answer. Every better-auth endpoint is either
// used or disabled, so an upgrade that adds one fails here until it is sorted.
import { beforeAll, describe, expect, it } from 'vitest'
import { AUTH_DISABLED_PATHS } from '../auth-paths'

process.env.BETTER_AUTH_SECRET ??= 'q7'.repeat(32)
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
// never reached: none of the requests below touches the database
process.env.DATABASE_URL ??= 'postgres://none:none@127.0.0.1:1/none'

const USED = ['/get-session', '/sign-in/email', '/sign-in/social', '/callback/:id', '/sign-out', '/error', '/ok', '/change-password']

let route: typeof import('@/app/api/auth/[...all]/route')
let auth: typeof import('../auth')['auth']

beforeAll(async () => {
	route = await import('@/app/api/auth/[...all]/route')
	auth = (await import('../auth')).auth
})

const base = 'http://localhost:3000/api/auth'
const get = (p: string) => route.GET(new Request(`${base}${p}`))
const post = (p: string, body: unknown = {}) =>
	route.POST(
		new Request(`${base}${p}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
			body: JSON.stringify(body),
		}),
	)

describe('better-auth disabledPaths', () => {
	it('every disabled path answers 404 to GET and POST', async () => {
		for (const p of AUTH_DISABLED_PATHS) {
			expect((await post(p)).status, `POST ${p}`).toBe(404)
			expect((await get(p)).status, `GET ${p}`).toBe(404)
		}
		expect((await post('/list-sessions/')).status).toBe(404)
		expect((await get('/reset-password/sometoken')).status).toBe(404)
	})

	it('the paths the UI uses still answer', async () => {
		expect((await get('/ok')).status).toBe(200)
		const s = await get('/get-session')
		expect(s.status).toBe(200)
		expect(await s.json()).toBeNull()
		// a body that fails validation: the endpoint is there (400, not 404)
		expect((await post('/sign-in/email', {})).status).toBe(400)
		expect((await get('/callback/github')).status).not.toBe(404)
		expect((await get('/error')).status).not.toBe(404)
	})

	it('every better-auth endpoint is either used or disabled', () => {
		const paths = new Set(
			Object.values(auth.api as Record<string, { path?: string }>)
				.map((e) => e?.path)
				.filter((p): p is string => typeof p === 'string'),
		)
		const sorted = new Set<string>([...USED, ...AUTH_DISABLED_PATHS, '/reset-password/:token'])
		expect([...paths].filter((p) => !sorted.has(p))).toEqual([])
	})
})
