// Backup prune keep validation and session-only delete, HEAD is GET for
// every rule, MCP rest() honours the session-only registry, the Dockerfile commit
// route is session-only. Invented names only.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const stub = vi.hoisted(() => () => ({ GET: async () => Response.json({}), POST: async () => Response.json({}), PUT: async () => Response.json({}), DELETE: async () => Response.json({}) }))
vi.mock('@/app/api/projects/route', stub)
vi.mock('@/app/api/projects/[id]/context/route', stub)
vi.mock('@/app/api/projects/[id]/domains/route', stub)
vi.mock('@/app/api/servers/[id]/containers/[name]/deploys/route', stub)
vi.mock('@/app/api/deploys/[deployId]/route', stub)
vi.mock('@/app/api/projects/[id]/redeploy/route', stub)
vi.mock('@/app/api/projects/[id]/env/route', stub)
vi.mock('@/app/api/projects/[id]/env/[key]/route', stub)
vi.mock('@/app/api/servers/list/route', stub)

const h = vi.hoisted(() => ({
	user: null as unknown,
	prune: [] as Array<{ server: string; app: string; keep: unknown; dryRun: boolean }>,
}))
vi.mock('@/lib/access', () => ({ requireUser: async () => h.user, visibleRepos: async () => [] }))
vi.mock('@/lib/backups', () => ({
	pruneBackupPools: async (server: string, app: string, opts: { scheduledKeep?: unknown; dryRun: boolean }) => {
		h.prune.push({ server, app, keep: opts.scheduledKeep, dryRun: opts.dryRun })
		return (['scheduled', 'manual'] as const).map((pool) => ({ server, app, pool, kept: 1, held: 0, pruned: 0, freedBytes: 0, errors: 0 }))
	},
}))
vi.mock('@/lib/db', () => ({
	appRepos: {},
	eq: () => 0,
	db: { select: () => ({ from: () => ({ where: async () => [{ serverId: 'boxa', containerName: 'zorbweb' }] }) }) },
}))

import { POST as prunePOST } from '../../app/api/internal/backups/prune/route'
import { planRetention } from '../backup-logic'
import { rest } from '../mcp/tools'
import { sessionOnlyRule } from '../session-only'
import { tokenAllows } from '../token-scopes'

const tokenAdmin = { id: 'u1', email: 'a@zorb.example', name: 'a', isAdmin: true, viaToken: true, tokenScopes: null }
const sessionAdmin = { id: 'u1', email: 'a@zorb.example', name: 'a', isAdmin: true }

beforeEach(() => {
	h.prune = []
	h.user = tokenAdmin
	vi.unstubAllEnvs()
})

const prune = (body: unknown) =>
	prunePOST(new Request('https://dash.example/api/internal/backups/prune', { method: 'POST', body: JSON.stringify(body) }))

describe('backup prune', () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, sizeBytes: 1000 }))
	it('planRetention with a keep that is not a finite number keeps every row', () => {
		for (const k of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const p = planRetention(rows, k)
			expect(p.keep.length).toBeGreaterThanOrEqual(1)
			expect(p.prune).toEqual([])
		}
		expect(planRetention(rows, 2).keep.length).toBe(2)
		expect(planRetention(rows, 0).keep.length).toBe(1)
	})
	it('a keep that is not a whole number >= 1 is a 400, before any prune', async () => {
		for (const keep of ['3', 0, -1, 1.5, null, {}, 'NaN'])
			expect((await prune({ dryRun: true, keep })).status, JSON.stringify(keep)).toBe(400)
		for (const keep of ['2', 0, 2.5])
			expect((await prune({ dryRun: true, apps: [{ server: 'boxa', app: 'zorbweb', keep }] })).status).toBe(400)
		expect((await prune({ dryRun: true, apps: 'zorbweb' })).status).toBe(400)
		expect(h.prune).toEqual([])
	})
	it('a token may dry-run; deleting needs a browser session (or the operator flag)', async () => {
		expect((await prune({ keep: 3 })).status).toBe(200)
		expect(h.prune[0]?.dryRun).toBe(true)
		const del = await prune({ dryRun: false, keep: 3 })
		expect(del.status).toBe(403)
		expect(((await del.json()) as { code: string }).code).toBe('session_only')
		expect(h.prune.some((p) => p.dryRun === false)).toBe(false)
		h.user = sessionAdmin
		expect((await prune({ dryRun: false, keep: 3 })).status).toBe(200)
		h.user = tokenAdmin
		vi.stubEnv('POWDER_TOKEN_BACKUP_PRUNE', '1')
		expect((await prune({ dryRun: false, keep: 3 })).status).toBe(200)
		expect(h.prune.filter((p) => p.dryRun === false).length).toBe(2)
	})
})

describe('HEAD is GET for every rule', () => {
	it('the session-only registry and token scopes', () => {
		expect(sessionOnlyRule('HEAD', '/api/tokens')?.why).toBe('token list')
		expect(sessionOnlyRule('head', '/api/servers/boxa/containers/zorbweb/repo')).not.toBeNull()
		expect(tokenAllows(['GET /api/projects'], 'HEAD /api/projects')).toBe(true)
		expect(tokenAllows(['POST /api/projects'], 'HEAD /api/projects')).toBe(false)
	})
})

describe('MCP rest refuses a session-only route for a token', () => {
	const handler = vi.fn(async () => Response.json({ ok: true }))
	const ctx = (user: unknown) => ({ user: user as never, headers: new Headers(), origin: 'https://dash.example' })
	it('a token is refused before the handler; a session reaches it', async () => {
		await expect(rest(ctx(tokenAdmin), 'GET', '/api/tokens', handler, {})).rejects.toThrow(/admin browser session/)
		await expect(
			rest(ctx(tokenAdmin), 'GET', '/api/env-vars', handler, {}, { query: { reveal: '1' } }),
		).rejects.toThrow(/admin browser session/)
		expect(handler).not.toHaveBeenCalled()
		await rest(ctx(sessionAdmin), 'GET', '/api/tokens', handler, {})
		expect(handler).toHaveBeenCalledOnce()
	})
})

describe('the Dockerfile commit route is session-only', () => {
	it('POST /api/integrations/github/repos/*/*/dockerfile', () => {
		expect(sessionOnlyRule('POST', '/api/integrations/github/repos/zorbco/zorbweb/dockerfile')?.why).toBe('Dockerfile commit')
		expect(sessionOnlyRule('GET', '/api/integrations/github/repos/zorbco/zorbweb/detect')).toBeNull()
	})
})
