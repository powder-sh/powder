import { afterEach, describe, expect, it, vi } from 'vitest'

// requireContainerAccess is the ONE authority that refuses powder's own
// containers, for every container route (allowUnmanaged too). Invented names.

const managed = true
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('../auth', () => ({ auth: { api: { getSession: async () => ({ user: { id: 'u1', email: 'a@example.test', name: 'A' } }) } } }))
vi.mock('../admin-ids', () => ({ isAdminUserId: () => true }))
vi.mock('../servers', () => ({ getServer: async (id: string) => (id === 'srv' ? { id: 'srv' } : undefined) }))
vi.mock('../db', () => {
	const chain = () => {
		const c: Record<string, unknown> = {}
		for (const m of ['select', 'from', 'where', 'innerJoin']) c[m] = () => c
		c.limit = async () => (managed ? [{ id: 'r1' }] : [])
		return c
	}
	return { and: () => 0, eq: () => 0, isNull: () => 0, appRepos: {}, previewDeploys: {}, user: {}, userApiTokens: {}, db: { select: () => chain() } }
})

import { requireContainerAccess } from '../access'

afterEach(() => vi.unstubAllEnvs())

describe('powder-self refusal inside requireContainerAccess', () => {
	it('refuses powder, powder-worker and POWDER_SELF_CONTAINER (and its -worker), managed or not', async () => {
		vi.stubEnv('POWDER_SELF_CONTAINER', 'hqdeploy')
		for (const name of ['powder', 'powder-worker', 'hqdeploy', 'hqdeploy-worker']) {
			for (const allowUnmanaged of [false, true]) {
				const r = await requireContainerAccess('srv', name, { allowUnmanaged })
				expect(r instanceof Response && r.status, `${name} ${allowUnmanaged}`).toBe(404)
			}
		}
	})
	it('an app container passes', async () => {
		const r = await requireContainerAccess('srv', 'quillbox')
		expect(r instanceof Response).toBe(false)
	})
	it('the container routes keep no per-route copy (one authority)', async () => {
		const { readFileSync } = await import('node:fs')
		const { join } = await import('node:path')
		const base = join(__dirname, '../../app/api/servers/[id]/containers/[name]')
		for (const r of ['inspect', 'restart', 'logs', 'logs/stream', 'rollback', 'env-file']) {
			const src = readFileSync(join(base, r, 'route.ts'), 'utf8')
			expect(src, r).toContain('requireContainerAccess(')
			expect(src, r).not.toContain('powderSelfDenied')
		}
	})
})
