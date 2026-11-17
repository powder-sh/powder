// POST /api/projects/<id>/backups (in TOKEN_ROUTES): a manual backup prunes
// manual backups only, a second one is refused while one runs for the app,
// token triggers are rate limited per app, and every caller but an admin
// browser session has a daily cap counted from the DB.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	user: { id: 'u', isAdmin: true, viaToken: true } as Record<string, unknown>,
	inFlight: null as null | { id: string },
	runs: [] as Array<{ repo: string; source: unknown }>,
	repoId: 'rep_1',
	recent: { count: 0, oldestAt: null as Date | null },
}))

vi.mock('@/lib/access', () => ({
	requireProjectAccess: async () => ({
		user: h.user,
		repo: { id: h.repoId, serverId: 's1', containerName: `app-${h.repoId}`, hasPostgres: true },
	}),
}))
vi.mock('@/lib/backup-restore', () => ({ listRestoresForApp: async () => [], restoreUrlHint: async () => null }))
vi.mock('@/lib/backups', () => ({
	BackupInFlightError: class extends Error {},
	isBackupConfigured: () => true,
	listBackupsForApp: async () => [],
	liveInFlightBackup: async () => h.inFlight,
	recentManualBackups: async () => h.recent,
	runBackupForApp: async (repo: { id: string }, opts: { source?: unknown }) => {
		h.runs.push({ repo: repo.id, source: opts?.source })
		return {}
	},
}))

import { POST } from '../../app/api/projects/[id]/backups/route'

const post = async () =>
	(await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: h.repoId }) })) as Response

beforeEach(() => {
	h.inFlight = null
	h.recent = { count: 0, oldestAt: null }
	h.runs.length = 0
})

describe('POST /api/projects/<id>/backups', () => {
	it('fires a manual backup (source manual)', async () => {
		h.repoId = 'rep_manual'
		const r = await post()
		expect(r.status).toBe(202)
		await new Promise((res) => setTimeout(res, 0))
		expect(h.runs).toEqual([{ repo: 'rep_manual', source: 'manual' }])
	})

	it('409 while a backup of the app is in flight, nothing fired', async () => {
		h.repoId = 'rep_busy'
		h.inFlight = { id: 'bkp_1' }
		const r = await post()
		expect(r.status).toBe(409)
		expect((await r.json()).backupId).toBe('bkp_1')
		await new Promise((res) => setTimeout(res, 0))
		expect(h.runs).toEqual([])
	})

	it('a token gets 2 triggers per app per 10 minutes, then 429 with Retry-After', async () => {
		h.repoId = 'rep_rl'
		h.user = { id: 'u', isAdmin: true, viaToken: true }
		expect((await post()).status).toBe(202)
		expect((await post()).status).toBe(202)
		const third = await post()
		expect(third.status).toBe(429)
		expect(Number(third.headers.get('Retry-After'))).toBeGreaterThan(0)
		// another app has its own bucket
		h.repoId = 'rep_rl_other'
		expect((await post()).status).toBe(202)
	})

	it('a refused (409) trigger does not use up the token budget', async () => {
		h.repoId = 'rep_rl_409'
		h.user = { id: 'u', isAdmin: true, viaToken: true }
		h.inFlight = { id: 'bkp_x' }
		for (let i = 0; i < 5; i++) expect((await post()).status).toBe(409)
		h.inFlight = null
		expect((await post()).status).toBe(202)
	})

	it('an admin browser session is not rate limited', async () => {
		h.repoId = 'rep_session'
		h.user = { id: 'u', isAdmin: true, viaToken: false }
		for (let i = 0; i < 5; i++) expect((await post()).status).toBe(202)
	})
})

describe('daily cap on manual triggers', () => {
	it('a token is refused at 12 manual backups in the last 24h, Retry-After from the oldest', async () => {
		h.repoId = 'rep_cap_token'
		h.user = { id: 'u', isAdmin: true, viaToken: true }
		h.recent = { count: 12, oldestAt: new Date(Date.now() - 23 * 3600_000) }
		const r = await post()
		expect(r.status).toBe(429)
		const retry = Number(r.headers.get('Retry-After'))
		expect(retry).toBeGreaterThan(3500)
		expect(retry).toBeLessThanOrEqual(3600)
		await new Promise((res) => setTimeout(res, 0))
		expect(h.runs).toEqual([])
	})

	it('a non-admin session is capped too, and 11 still passes', async () => {
		h.user = { id: 'u2', isAdmin: false, viaToken: false }
		h.repoId = 'rep_cap_user'
		h.recent = { count: 12, oldestAt: new Date() }
		expect((await post()).status).toBe(429)
		h.repoId = 'rep_cap_user_ok'
		h.recent = { count: 11, oldestAt: new Date() }
		expect((await post()).status).toBe(202)
	})

	it('an admin browser session is not capped', async () => {
		h.user = { id: 'u', isAdmin: true, viaToken: false }
		h.repoId = 'rep_cap_admin'
		h.recent = { count: 50, oldestAt: new Date() }
		expect((await post()).status).toBe(202)
	})
})

describe('retentionPoolFor', () => {
	it('each source prunes its own pool with its own keep floor', async () => {
		const real = await vi.importActual<typeof import('../backups')>('../backups')
		expect(real.retentionPoolFor({ source: 'scheduled' })).toEqual({ source: 'scheduled', keep: 7 })
		expect(real.retentionPoolFor({ source: 'manual' })).toEqual({ source: 'manual', keep: 3 })
		expect(real.retentionPoolFor({ source: 'anything else' })).toBeNull()
	})
})
