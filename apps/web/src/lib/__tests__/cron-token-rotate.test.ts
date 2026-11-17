// a cron token minted through an API token or the scheduler is never revealed, so
// an admin browser session can rotate it: POST .../crons/token/rotate mints a new one and
// shows it once. Bearer tokens never reach it (SESSION_ONLY, and the route checks again).
// The crons list says only whether a token is set. Invented names.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const h = vi.hoisted(() => ({ user: null as unknown, rotated: 0, tokenSet: true }))
const sessionAdmin = { id: 'u1', email: 'a@zorb.example', name: 'a', isAdmin: true }
const tokenAdmin = { ...sessionAdmin, viaToken: true, tokenScopes: null }
const sessionUser = { ...sessionAdmin, isAdmin: false }

vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ user: h.user, server: { id: 'boxa', host: 'h', kind: 'compose' } }),
}))
vi.mock('@/lib/cron-scheduler', () => ({
	rotateAppCronToken: async () => {
		h.rotated++
		return 'zorbnewcrontoken0123456789abcdef'
	},
	appCronTokenSet: async () => h.tokenSet,
	ensureAppCronToken: async () => null,
}))
vi.mock('@/lib/db', () => {
	const q = () => {
		const c = Object.assign(Promise.resolve().then(() => []), {}) as Promise<unknown> & Record<string, unknown>
		for (const k of ['from', 'where', 'orderBy', 'limit']) c[k] = () => c
		return c
	}
	return { cronJobs: {}, cronJobRuns: {}, and: () => 0, eq: () => 0, desc: () => 0, inArray: () => 0, db: { select: () => q() } }
})
vi.mock('@/lib/ssh', () => ({
	getRootCrontab: async () => '',
	inspectContainer: async () => ({ ports: [] }),
	extractHostPorts: () => [],
}))
vi.mock('@/lib/app-hosts', () => ({ defaultHostFor: () => 'zorbweb.example.test' }))

import { GET as listCrons } from '../../app/api/servers/[id]/containers/[name]/crons/route'
import { POST as rotate } from '../../app/api/servers/[id]/containers/[name]/crons/token/rotate/route'
import { sessionOnlyRule } from '../session-only'

const params = { params: Promise.resolve({ id: 'boxa', name: 'zorbweb' }) }
const call = () => rotate(new Request('http://x/api/servers/boxa/containers/zorbweb/crons/token/rotate', { method: 'POST' }), params)

describe('cron token rotate', () => {
	beforeEach(() => {
		h.rotated = 0
		h.tokenSet = true
	})
	it('is SESSION_ONLY: the proxy refuses any bearer token', () => {
		expect(sessionOnlyRule('POST', '/api/servers/boxa/containers/zorbweb/crons/token/rotate')?.why).toBe('cron token rotate')
	})
	it('an admin browser session gets a new token, once', async () => {
		h.user = sessionAdmin
		const r = await call()
		expect(r.status).toBe(200)
		expect((await r.json()).cronToken).toBe('zorbnewcrontoken0123456789abcdef')
		expect(h.rotated).toBe(1)
	})
	it('an API token (even an admin one) and a non-admin session are refused and rotate nothing', async () => {
		for (const u of [tokenAdmin, sessionUser]) {
			h.user = u
			const r = await call()
			expect(r.status).toBe(403)
			expect(JSON.stringify(await r.json())).not.toContain('zorbnewcrontoken')
		}
		expect(h.rotated).toBe(0)
	})
	it('the crons list says whether a token is set, never the token', async () => {
		h.user = sessionAdmin
		const body = await (await listCrons(new Request('http://x/'), params)).json()
		expect(body.cronTokenSet).toBe(true)
		expect(JSON.stringify(body)).not.toContain('zorbnewcrontoken')
		h.tokenSet = false
		expect((await (await listCrons(new Request('http://x/'), params)).json()).cronTokenSet).toBe(false)
	})
})
