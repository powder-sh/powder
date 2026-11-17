import { beforeEach, describe, expect, it, vi } from 'vitest'

const rows: { app: unknown[]; preview: unknown[] } = { app: [], preview: [] }
let call = 0
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('../auth', () => ({ auth: { api: { getSession: async () => ({ user: { id: 'a', email: 'a', name: 'a' } }) } } }))
vi.mock('../admin-ids', () => ({ isAdminUserId: () => true }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 'srv' }) }))
vi.mock('../db', () => {
	const chain = () => {
		const c: Record<string, unknown> = {}
		for (const k of ['from', 'where', 'innerJoin', 'limit']) c[k] = () => c
		c.then = (res: (v: unknown) => unknown) => res(call++ === 0 ? rows.app : rows.preview)
		return c
	}
	return {
		and: () => 0, eq: () => 0, isNull: () => 0,
		appRepos: {}, previewDeploys: {}, user: {}, userApiTokens: {},
		db: { select: () => chain() },
	}
})

import { isSafeContainerName, requireContainerAccess } from '../access'

describe('requireContainerAccess', () => {
	beforeEach(() => {
		call = 0
		rows.app = []
		rows.preview = []
	})
	it('name validation', () => {
		expect(isSafeContainerName('my-app_1.x')).toBe(true)
		expect(isSafeContainerName('x/../../etc/y')).toBe(false)
		expect(isSafeContainerName('a..b')).toBe(false)
		expect(isSafeContainerName('-rf')).toBe(false)
		expect(isSafeContainerName('a'.repeat(65))).toBe(false)
	})
	it('traversal name -> 400', async () => {
		const r = await requireContainerAccess('srv', 'x/../../etc/y')
		expect(r instanceof Response && r.status).toBe(400)
	})
	it('container without app_repos or preview row -> 404', async () => {
		const r = await requireContainerAccess('srv', 'postgres')
		expect(r instanceof Response && r.status).toBe(404)
	})
	it('known app passes; known preview passes', async () => {
		rows.app = [{ id: 'r1' }]
		expect(await requireContainerAccess('srv', 'myapp')).not.toBeInstanceOf(Response)
		call = 0
		rows.app = []
		rows.preview = [{ id: 'p1' }]
		expect(await requireContainerAccess('srv', 'myapp-feat')).not.toBeInstanceOf(Response)
	})
})
