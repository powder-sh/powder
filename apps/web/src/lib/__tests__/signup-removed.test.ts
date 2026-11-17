import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	delete process.env.POWDER_ADMIN_USER_IDS
	return { count: 0, oldest: '' }
})

vi.mock('../db', () => ({
	sql: () => 0,
	asc: () => 0,
	user: {},
	db: {
		select: () => ({
			from: () => {
				const p = Promise.resolve([{ n: h.count }]) as Promise<unknown> & { orderBy: () => unknown }
				p.orderBy = () => ({ limit: async () => (h.oldest ? [{ id: h.oldest }] : []) })
				return p
			},
		}),
		// a granted first-run claim deletes a stale stored first-run admin.
		execute: async () => [],
	},
}))
vi.mock('@/lib/auth', () => ({
	auth: { handler: async () => new Response('handled', { status: 200 }) },
}))

import { GET, POST } from '@/app/api/auth/[...all]/route'
import { isAdminUserId } from '../admin-ids'
import {
	SETUP_COOKIE,
	allowUserCreate,
	announceSetupTokenIfFirstRun,
	onFirstUserCreated,
	resetFirstRunClaim,
	resetSetupToken,
	setupToken,
} from '../first-run'
import { POST as setupPOST } from '@/app/api/setup/token/route'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

beforeEach(() => {
	h.count = 0
	h.oldest = ''
	resetFirstRunClaim()
	resetSetupToken()
})

const setupCookie = () => `other=1; ${SETUP_COOKIE}=${encodeURIComponent(setupToken())}`

describe('signup is gone', () => {
	it('has no /signup page', () => {
		expect(existsSync(resolve(__dirname, '../../app/(auth)/signup'))).toBe(false)
	})

	it('/api/auth/sign-up/* returns 404', async () => {
		const post = await POST(new Request('http://x/api/auth/sign-up/email', { method: 'POST', body: '{}' }))
		expect(post.status).toBe(404)
		const get = await GET(new Request('http://x/api/auth/sign-up/anything'))
		expect(get.status).toBe(404)
	})

	it('other auth paths still reach better-auth', async () => {
		const res = await POST(new Request('http://x/api/auth/sign-in/email', { method: 'POST', body: '{}' }))
		expect(res.status).toBe(200)
	})
})

describe('first-run admin bootstrap', () => {
	it('allows creating a user when the user table is empty and the setup cookie is valid', async () => {
		h.count = 0
		expect(await allowUserCreate(setupCookie())).toBe(true)
	})

	it('a fresh install refuses the first login without the setup token', async () => {
		h.count = 0
		expect(await allowUserCreate()).toBe(false)
		expect(await allowUserCreate('')).toBe(false)
		expect(await allowUserCreate(`${SETUP_COOKIE}=wrong`)).toBe(false)
		// The claim was not taken: the operator with the token still gets in.
		expect(await allowUserCreate(setupCookie())).toBe(true)
	})

	it('a token from before a restart stops working', async () => {
		h.count = 0
		const old = setupCookie()
		resetSetupToken()
		expect(await allowUserCreate(old)).toBe(false)
	})

	it('refuses user creation once any user exists', async () => {
		h.count = 1
		expect(await allowUserCreate(setupCookie())).toBe(false)
	})

	it('two concurrent first logins: exactly one is allowed', async () => {
		h.count = 0
		const c = setupCookie()
		const r = await Promise.all([allowUserCreate(c), allowUserCreate(c)])
		expect(r.filter(Boolean)).toHaveLength(1)
	})

	it('makes the first user an admin for this process', async () => {
		h.oldest = 'first1'
		expect(isAdminUserId('first1')).toBe(false)
		await onFirstUserCreated('first1', 'me@example.com')
		expect(isAdminUserId('first1')).toBe(true)
		expect(isAdminUserId('other')).toBe(false)
	})

	it('does not make a user admin if they are not the oldest row', async () => {
		h.oldest = 'older'
		await onFirstUserCreated('late1', 'x@example.com')
		expect(isAdminUserId('late1')).toBe(false)
	})
})

describe('setup token in the log', () => {
	it('a fresh install prints the token once at boot', async () => {
		h.count = 0
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await announceSetupTokenIfFirstRun()
		await announceSetupTokenIfFirstRun()
		const lines = log.mock.calls.map((c) => String(c[0]))
		log.mockRestore()
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain(`[first-run] setup token: ${setupToken()}`)
	})

	it('an install that already has users prints nothing', async () => {
		h.count = 3
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await announceSetupTokenIfFirstRun()
		expect(log).not.toHaveBeenCalled()
		log.mockRestore()
	})
})

describe('/api/setup/token', () => {
	const post = (token: string) => {
		const body = new URLSearchParams({ token })
		return setupPOST(new Request('http://x/api/setup/token', { method: 'POST', body }))
	}

	it('a wrong token sets no cookie', async () => {
		h.count = 0
		setupToken()
		const r = await post('nope')
		expect(r.status).toBe(303)
		expect(r.headers.get('location')).toBe('/setup?state=bad')
		expect(r.headers.get('set-cookie')).toBeNull()
	})

	it('the right token sets a short-lived httpOnly cookie that allowUserCreate accepts', async () => {
		h.count = 0
		const r = await post(setupToken())
		expect(r.headers.get('location')).toBe('/login?setup=ok')
		const c = r.headers.get('set-cookie') ?? ''
		expect(c).toContain('HttpOnly')
		expect(c).toContain('SameSite=Lax')
		expect(c).toMatch(/Max-Age=\d+/)
		expect(await allowUserCreate(c.split(';')[0])).toBe(true)
	})

	it('after setup (a user exists) the route does nothing', async () => {
		h.count = 1
		const r = await post(setupToken())
		expect(r.headers.get('location')).toBe('/setup?state=done')
		expect(r.headers.get('set-cookie')).toBeNull()
	})
})
