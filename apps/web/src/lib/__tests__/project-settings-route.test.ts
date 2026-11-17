// PATCH /api/projects/[id]: the Settings tab fields, behind the one project
// access check; only validated fields reach the update.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	access: 'ok' as 'ok' | 'denied',
	sets: [] as unknown[],
	row: true,
	user: { id: 'u' } as { id: string; isAdmin?: boolean; viaToken?: boolean },
	repo: { id: 'a' } as Record<string, unknown>,
}))

vi.mock('@/lib/db', () => {
	const chain = {
		update: () => chain,
		set: (v: unknown) => {
			state.sets.push(v)
			return chain
		},
		where: () => chain,
		returning: async () =>
			state.row
				? [
						{
							syncDeploymentMd: false,
							uptimeEnabled: true,
							healthUrl: '/api/health',
							previewsEnabled: false,
							autoRollback: false,
							deploySettleSeconds: 600,
							backupDbPasswordEncrypted: 'v1:stored',
						},
					]
				: [],
	}
	return {
		db: chain,
		appRepos: {},
		appUptimeChecks: {},
		cronJobs: {},
		deploys: {},
		eq: () => 0,
		desc: () => 0,
		and: () => 0,
		sql: () => 0,
	}
})
vi.mock('@/lib/access', () => ({
	requireProjectAccess: async () =>
		state.access === 'ok'
			? { user: state.user, repo: state.repo }
			: Response.json({ error: 'not found' }, { status: 404 }),
}))
vi.mock('@/lib/servers', () => ({ getServer: async () => undefined }))
vi.mock('@/lib/ssh', () => ({ inspectContainer: async () => ({}) }))
vi.mock('@/lib/deploy-days-db', () => ({ deployDaysFor: async () => new Map() }))
vi.mock('@/lib/hosts', () => ({ webhookUrl: () => 'https://example.com/hook' }))
vi.mock('@/lib/crypto', () => ({ encryptSecret: (p: string) => `enc(${p})` }))

import { NextRequest } from 'next/server'
import { PATCH } from '../../app/api/projects/[id]/route'

const ctx = { params: Promise.resolve({ id: 'a' }) }
const patch = (body: unknown) =>
	PATCH(new NextRequest('http://x/api/projects/a', { method: 'PATCH', body: JSON.stringify(body) }), ctx)

beforeEach(() => {
	state.access = 'ok'
	state.sets = []
	state.row = true
	state.user = { id: 'u' }
	state.repo = { id: 'a' }
})

describe('PATCH /api/projects/[id]', () => {
	it('writes uptimeEnabled, healthUrl and previewsEnabled', async () => {
		const res = await patch({ uptimeEnabled: true, healthUrl: ' /api/health ', previewsEnabled: false })
		expect(res.status).toBe(200)
		expect(state.sets).toEqual([{ uptimeEnabled: true, healthUrl: '/api/health', previewsEnabled: false }])
		expect(await res.json()).toMatchObject({ ok: true, uptimeEnabled: true, healthUrl: '/api/health' })
	})
	it('still takes syncDeploymentMd alone', async () => {
		expect((await patch({ syncDeploymentMd: true })).status).toBe(200)
		expect(state.sets).toEqual([{ syncDeploymentMd: true }])
	})
	it('writes the automatic rollback opt-out and returns it', async () => {
		const res = await patch({ autoRollback: false })
		expect(res.status).toBe(200)
		expect(state.sets).toEqual([{ autoRollback: false }])
		expect(await res.json()).toMatchObject({ ok: true, autoRollback: false })
	})
	it('writes the settle window and returns it; null goes back to the install-wide value', async () => {
		const res = await patch({ deploySettleSeconds: 600 })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ ok: true, deploySettleSeconds: 600 })
		expect((await patch({ deploySettleSeconds: null })).status).toBe(200)
		expect(state.sets).toEqual([{ deploySettleSeconds: 600 }, { deploySettleSeconds: null }])
	})
	it('a bad value is a 400 and nothing is written', async () => {
		for (const body of [{ uptimeEnabled: 'on' }, { autoRollback: 'no' }, { deploySettleSeconds: 1801 }, { deploySettleSeconds: -1 }, { deploySettleSeconds: '60' }, { healthUrl: 'http://127.0.0.1/' }, {}, { other: true }]) {
			expect((await patch(body)).status).toBe(400)
		}
		expect(state.sets).toEqual([])
	})
	it('no access: the access answer, nothing written', async () => {
		state.access = 'denied'
		expect((await patch({ previewsEnabled: true })).status).toBe(404)
		expect(state.sets).toEqual([])
	})
	it('a body over the cap is refused', async () => {
		const res = await patch({ healthUrl: `/${'a'.repeat(5000)}` })
		expect(res.status).toBe(413)
		expect(state.sets).toEqual([])
	})

	describe('the database backups dump', () => {
		const admin = () => {
			state.user = { id: 'u', isAdmin: true }
		}
		it('needs an admin browser session: a member or an API token gets 403, nothing written', async () => {
			for (const user of [{ id: 'u' }, { id: 'u', isAdmin: true, viaToken: true }]) {
				state.user = user
				for (const body of [{ backupDbContainer: 'pg-shared' }, { hasPostgres: true }, { backupDbPassword: 'x' }]) {
					const res = await patch(body)
					expect(res.status).toBe(403)
					expect(await res.json()).toMatchObject({ code: 'session_only' })
				}
			}
			expect(state.sets).toEqual([])
		})
		it('writes the fields, the password encrypted; the answer says only that one is set', async () => {
			admin()
			const res = await patch({
				hasPostgres: true,
				backupDbContainer: ' pg-shared ',
				backupDbName: 'shop',
				backupDbUser: 'shop',
				backupDbPassword: ' s3cret ',
			})
			expect(res.status).toBe(200)
			expect(state.sets).toEqual([
				{
					hasPostgres: true,
					backupDbContainer: 'pg-shared',
					backupDbName: 'shop',
					backupDbUser: 'shop',
					backupDbPasswordEncrypted: 'enc( s3cret )',
				},
			])
			const body = await res.json()
			expect(body).toMatchObject({ ok: true, backupDbPasswordSet: true })
			expect(JSON.stringify(body)).not.toContain('stored')
			expect(body).not.toHaveProperty('backupDbPasswordEncrypted')
		})
		it('empty values go back to the defaults; null clears the password', async () => {
			admin()
			expect((await patch({ backupDbContainer: '', backupDbName: '  ', backupDbPassword: null })).status).toBe(200)
			expect(state.sets).toEqual([{ backupDbContainer: null, backupDbName: null, backupDbPasswordEncrypted: null }])
		})
		it('a host needs a password, stored or in the same request, and excludes a container', async () => {
			admin()
			expect((await patch({ backupDbHost: '127.0.0.1:5432' })).status).toBe(400)
			state.repo = { id: 'a', backupDbPasswordEncrypted: 'v1:x' }
			expect((await patch({ backupDbHost: '127.0.0.1:5432' })).status).toBe(200)
			expect((await patch({ backupDbHost: 'db.internal', backupDbPassword: null })).status).toBe(400)
			state.repo = { id: 'a', backupDbContainer: 'pg-shared' }
			const both = await patch({ backupDbHost: 'db.internal', backupDbPassword: 'pw' })
			expect(both.status).toBe(400)
			expect((await both.json()).error).toMatch(/not both/)
			expect((await patch({ backupDbHost: 'db.internal', backupDbPassword: 'pw', backupDbContainer: null })).status).toBe(200)
			expect(state.sets).toEqual([
				{ backupDbHost: '127.0.0.1:5432' },
				{ backupDbHost: 'db.internal', backupDbContainer: null, backupDbPasswordEncrypted: 'enc(pw)' },
			])
		})
	})
})
