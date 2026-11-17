// /api/health returns only {status} to the public;
// the detail is for on-server callers (loopback) and a signed-in admin.
import { afterEach, describe, expect, it, vi } from 'vitest'

const auth = { user: null as null | { isAdmin: boolean } }
vi.mock('@/lib/access', () => ({ getCurrentUser: async () => auth.user }))

vi.mock('@/lib/db', () => ({ db: { execute: async () => [] }, sql: () => '' }))
const worker = vi.hoisted(() => ({ on: true }))
vi.mock('@/lib/deploys', () => ({ deployWorkerEnabled: () => worker.on }))
vi.mock('@/lib/cron-scheduler', () => ({
	getSchedulerHealth: async () => ({
		started: true,
		owner: 'worker-1',
		lastTickAt: new Date(),
		staleMs: 1000,
	}),
	getClaimLoopHealth: async () => ({
		started: true,
		owner: 'worker-1',
		lastTickAt: new Date(),
		staleMs: 1000,
	}),
}))
import { GET } from '../../app/api/health/route'

const req = (host: string, extra: Record<string, string> = {}) =>
	new Request(`http://${host}/api/health`, { headers: { host, ...extra } })

describe('/api/health', () => {
	afterEach(() => vi.unstubAllEnvs())
	it('site host: status only', async () => {
		vi.stubEnv('POWDER_SITE_HOST', 'powder.example')
		const r = await GET(req('powder.example'))
		expect(r.status).toBe(200)
		expect(await r.json()).toEqual({ status: 'ok' })
	})
	it('dashboard host and on-server callers keep the detail', async () => {
		vi.stubEnv('POWDER_SITE_HOST', 'powder.example')
		const body = await (await GET(req('127.0.0.1:3050', { 'x-forwarded-for': '127.0.0.1' }))).json()
		expect(body.status).toBe('ok')
		expect(body.scheduler.owner).toBe('worker-1')
		expect(body.claimLoop.started).toBe(true)
	})
	it('in-web mode (no deploy worker): claimLoop is "in-web"', async () => {
		worker.on = false
		try {
			const body = await (await GET(req('127.0.0.1:3050', { 'x-forwarded-for': '127.0.0.1' }))).json()
			expect(body.status).toBe('ok')
			expect(body.claimLoop).toBe('in-web')
		} finally {
			worker.on = true
		}
	})
	it('public dashboard host: status only, same code (uptime monitors keep working)', async () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		auth.user = null
		const r = await GET(
			req('powder.example', { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' }),
		)
		expect(r.status).toBe(200)
		expect(await r.json()).toEqual({ status: 'ok' })
	})
	it('a signed-in admin gets the detail; a non-admin does not', async () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		auth.user = { isAdmin: true }
		expect((await (await GET(req('powder.example'))).json()).db).toBe(true)
		auth.user = { isAdmin: false }
		expect(await (await GET(req('powder.example'))).json()).toEqual({ status: 'ok' })
		auth.user = null
	})
	it('loopback: the in-container probe (peer 127.0.0.1 / ::1) gets the detail', async () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		expect(
			(await (await GET(req('127.0.0.1:3000', { 'x-forwarded-for': '127.0.0.1' }))).json()).db,
		).toBe(true)
		expect((await (await GET(req('localhost:3000', { 'x-forwarded-for': '::1' }))).json()).db).toBe(
			true,
		)
	})
	it('a bridge peer (another container, or the host through docker-proxy) gets status only', async () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		for (const peer of ['172.18.0.1', '172.18.0.5', '10.0.0.3'])
			expect(
				await (await GET(req('localhost:3000', { 'x-forwarded-for': peer }))).json(),
				peer,
			).toEqual({
				status: 'ok',
			})
		// no peer reported at all: public
		expect(await (await GET(req('127.0.0.1:3050'))).json()).toEqual({ status: 'ok' })
	})
	it('a loopback Host through a proxy or from a public peer is public', async () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		const cases: Array<Record<string, string>> = [
			{ 'x-real-ip': '203.0.113.9' },
			{ 'cf-connecting-ip': '203.0.113.9' },
			{ 'x-forwarded-for': '203.0.113.9' },
			{ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
			{ 'x-forwarded-host': 'powder.example' },
		]
		for (const extra of cases)
			expect(await (await GET(req('127.0.0.1:3050', extra))).json(), JSON.stringify(extra)).toEqual(
				{ status: 'ok' },
			)
	})
})
