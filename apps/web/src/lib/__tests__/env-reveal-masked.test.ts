import { beforeEach, describe, expect, it, vi } from 'vitest'

let access: Record<string, unknown> = {}
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => access,
}))
vi.mock('@/lib/ssh', () => ({
	inspectContainer: async () => ({ name: 'app', env: [{ key: 'DB_PASSWORD', value: 'supersecret42' }] }),
	findEnvFile: async () => ({ path: '/p', exists: true, contents: 'API_KEY=valuevalue12\n', candidates: ['/p'] }),
	readEnvFile: async () => ({ exists: true, contents: 'K=vvvvvvvv99\n' }),
	envFileCandidatesFor: () => [],
	writeEnvFile: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ and: () => 0, eq: () => 0, appRepos: {}, db: {} }))
vi.mock('@/lib/env-vars-db', () => ({
	auditCtxFromRequest: () => ({}),
	deleteForProject: vi.fn(),
	isEnvDbModeEnabled: () => false,
	listForProject: vi.fn(),
	renderEnvFile: vi.fn(),
	setForProject: vi.fn(),
}))

import { GET as envGet } from '../../app/api/servers/[id]/containers/[name]/env-file/route'
import { GET as inspectGet } from '../../app/api/servers/[id]/containers/[name]/inspect/route'
import { maskValue } from '../secret-mask'

const ctx = { params: Promise.resolve({ id: 's', name: 'app' }) }
const req = (q = '') => new Request(`http://x/api?${q}`)
const server = { id: 's', kind: 'compose' }

describe('masked by default', () => {
	beforeEach(() => {
		access = { user: { id: 'a', isAdmin: true }, server }
	})
	it('maskValue', () => {
		expect(maskValue('supersecret42')).toBe('****42')
		expect(maskValue('abc')).toBe('****')
	})
	it('inspect masks env by default', async () => {
		const body = await (await inspectGet(req(), ctx)).json()
		expect(JSON.stringify(body)).not.toContain('supersecret42')
		expect(body.env[0].value).toBe('****42')
	})
	it('env-file masks entries and raw by default', async () => {
		const body = await (await envGet(req(), ctx)).json()
		expect(JSON.stringify(body)).not.toContain('valuevalue12')
		expect(body.entries[0].value).toBe('****12')
	})
	it('admin session + reveal=1 gets full values', async () => {
		const body = await (await envGet(req('reveal=1'), ctx)).json()
		expect(body.entries[0].value).toBe('valuevalue12')
		const insp = await (await inspectGet(req('reveal=1'), ctx)).json()
		expect(insp.env[0].value).toBe('supersecret42')
	})
	it('bearer token with reveal=1 is refused', async () => {
		access = { user: { id: 'a', isAdmin: true, viaToken: true, tokenScopes: null }, server }
		expect((await envGet(req('reveal=1'), ctx)).status).toBe(403)
		expect((await inspectGet(req('reveal=1'), ctx)).status).toBe(403)
	})
	it('non-admin session with reveal=1 is refused', async () => {
		access = { user: { id: 'u', isAdmin: false }, server }
		expect((await inspectGet(req('reveal=1'), ctx)).status).toBe(403)
	})
})
