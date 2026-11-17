import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// the real access.ts with its edges mocked: a bearer token on a session-only path
// is refused by getCurrentUser itself (when the proxy did not run), and
// requireProjectAccess refuses powder's own container. Invented names only.

const h = vi.hoisted(() => ({
	headers: new Headers(),
	session: null as null | { user: { id: string; email: string; name: string } },
	rows: [] as unknown[][],
}))

vi.mock('next/headers', () => ({ headers: async () => h.headers }))
vi.mock('../auth', () => ({ auth: { api: { getSession: async () => h.session } } }))
vi.mock('../admin-ids', () => ({ isAdminUserId: (id: string) => id === 'u-admin' }))
vi.mock('../db', () => {
	const chain = () => {
		const c: Record<string, unknown> = {}
		for (const m of ['select', 'from', 'where', 'innerJoin', 'update', 'set']) c[m] = () => c
		c.limit = async () => h.rows.shift() ?? []
		c.catch = () => undefined
		return c
	}
	return {
		and: () => 0,
		eq: () => 0,
		isNull: () => 0,
		appRepos: { id: 'id' },
		previewDeploys: {},
		user: {},
		userApiTokens: { id: 'id' },
		db: { select: () => chain(), update: () => chain() },
	}
})

import { getCurrentUser, requireProjectAccess } from '../access'
import { POWDER_REQUEST_HEADER } from '../token-scopes'

const tokenRow = {
	tokenId: 't1',
	userId: 'u-admin',
	email: 'a@zorb.example',
	name: 'a',
	scopes: null,
	expiresAt: null,
}

beforeEach(() => {
	h.headers = new Headers()
	h.session = null
	h.rows = []
})

describe('getCurrentUser refuses a full-access token on a session-only path', () => {
	it('POST /api/tokens with a bearer: no user (401), even with full-access scopes', async () => {
		h.headers = new Headers({
			authorization: 'Bearer pwd_zorb',
			[POWDER_REQUEST_HEADER]: 'POST /api/tokens',
		})
		h.rows = [[tokenRow]]
		expect(await getCurrentUser()).toBeNull()
	})
	it('a token route still authenticates', async () => {
		h.headers = new Headers({
			authorization: 'Bearer pwd_zorb',
			[POWDER_REQUEST_HEADER]: 'POST /api/projects/p1/redeploy',
		})
		h.rows = [[tokenRow]]
		expect((await getCurrentUser())?.viaToken).toBe(true)
	})
	it('no stamp (the proxy did not run): refused', async () => {
		h.headers = new Headers({ authorization: 'Bearer pwd_zorb' })
		h.rows = [[tokenRow]]
		expect(await getCurrentUser()).toBeNull()
	})
	it('a browser session on a session-only path is a user', async () => {
		h.headers = new Headers({ [POWDER_REQUEST_HEADER]: 'POST /api/tokens' })
		h.session = { user: { id: 'u-admin', email: 'a@zorb.example', name: 'a' } }
		expect((await getCurrentUser())?.isAdmin).toBe(true)
	})
})

describe('requireProjectAccess', () => {
	beforeEach(() => {
		h.session = { user: { id: 'u-admin', email: 'a@zorb.example', name: 'a' } }
	})
	it('returns the user and the row', async () => {
		h.rows = [[{ id: 'p1', containerName: 'zorbweb' }]]
		const r = await requireProjectAccess('p1')
		expect(r instanceof Response ? r.status : r.repo.containerName).toBe('zorbweb')
	})
	it('404 for an unknown app and for powder itself', async () => {
		h.rows = [[]]
		expect(((await requireProjectAccess('nope')) as Response).status).toBe(404)
		for (const name of ['powder', 'powder-worker']) {
			h.rows = [[{ id: 'p2', containerName: name }]]
			expect(((await requireProjectAccess('p2')) as Response).status, name).toBe(404)
		}
	})
	it('401 without a user', async () => {
		h.session = null
		expect(((await requireProjectAccess('p1')) as Response).status).toBe(401)
	})
	it("a read route (selfRead) serves powder's own row to an admin session only", async () => {
		h.rows = [[{ id: 'p2', containerName: 'powder' }]]
		const ok = await requireProjectAccess('p2', { selfRead: true })
		expect(ok instanceof Response ? ok.status : ok.repo.containerName).toBe('powder')
		// a token never gets it, read or write
		h.session = null
		h.headers = new Headers({ authorization: 'Bearer pwd_zorb', [POWDER_REQUEST_HEADER]: 'GET /api/projects/p2' })
		h.rows = [[tokenRow], [{ id: 'p2', containerName: 'powder' }]]
		expect(((await requireProjectAccess('p2', { selfRead: true })) as Response).status).toBe(404)
	})
	it('the write and secret routes keep the 404 for powder itself', async () => {
		const P = join(__dirname, '..', '..', 'app', 'api', 'projects', '[id]')
		const src = (f: string) => readFileSync(join(P, f), 'utf8')
		for (const f of ['redeploy/route.ts', 'env/route.ts', 'env/[key]/route.ts', 'env/[key]/history/route.ts', 'env/[key]/rollback/route.ts', 'env/backfill/route.ts', 'domains/[hostname]/apply/route.ts', 'domains/[hostname]/verify/route.ts', 'backups/[backupId]/route.ts', 'ci/[runId]/diagnose/route.ts'])
			expect(src(f), f).not.toContain('selfRead')
		// PATCH (settings) and domains POST / DELETE do not pass it either
		const proj = src('route.ts')
		expect(proj.slice(proj.indexOf('export async function PATCH'))).not.toContain('selfRead')
		const dom = src('domains/route.ts')
		expect(dom.slice(dom.indexOf('export async function POST'))).not.toMatch(/loadOwnedRepo\(id, true\)/)
	})
})
