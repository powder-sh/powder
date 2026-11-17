import { beforeEach, describe, expect, it, vi } from 'vitest'

let user: Record<string, unknown> = {}
const repos = [
	{ id: 'r1', serverId: 's', containerName: 'web', hasPostgres: true, hasKv: true, backupDbContainer: null, backupDbHost: null, backupDbName: 'app', backupDbUser: 'app' },
]
vi.mock('@/lib/access', () => ({
	requireUser: async () => user,
	visibleRepos: async () => repos,
}))
vi.mock('@/lib/servers', () => ({
	listAllServers: async () => [{ id: 's', name: 'server' }],
	getServer: async () => ({ id: 's', name: 'server' }),
	updateServerStatus: vi.fn(),
}))
vi.mock('@/lib/crypto', () => ({ decryptSecret: () => 'x' }))
vi.mock('@/lib/ssh', () => ({
	listContainers: async () => [
		{ name: 'web', state: 'running' },
		{ name: 'web-db', state: 'running' },
		{ name: 'web-kv', state: 'running' },
		{ name: 'powder', state: 'running' },
		{ name: 'powder-worker', state: 'running' },
		{ name: 'stranger', state: 'running' },
	],
	bulkReadAppEnvFiles: async (_s: unknown, names: string[]) =>
		new Map(
			names.map((n) => [
				n,
				{
					exists: true,
					path: `/opt/apps/${n}.env`,
					contents: `SECRET=topsecretvalue\nDATABASE_URL=postgres://app:hunter2pw@web-db:5432/app\nREDIS_URL=redis://:kvpass@web-kv:6379\n`,
				},
			]),
		),
	findEnvFile: async () => ({
		exists: true,
		path: '/p',
		contents: `SECRET=topsecretvalue\nDATABASE_URL=postgres://app:hunter2pw@web-db:5432/app\nREDIS_URL=redis://:kvpass@web-kv:6379\n`,
	}),
	runCommand: async () => ({ code: 0, stdout: '1234', stderr: '' }),
}))

import { GET as dbGet } from '../../app/api/databases/route'
import { GET as envGet } from '../../app/api/env-vars/route'

const req = (path: string, q = '') => new Request(`http://x${path}?${q}`)
const token = { id: 'a', isAdmin: true, viaToken: true, tokenScopes: null }

describe('/api/env-vars', () => {
	beforeEach(() => {
		user = token
	})
	it('token user gets masked values, managed apps only, never powder itself', async () => {
		const res = await envGet(req('/api/env-vars'))
		const text = await res.text()
		expect(text).not.toContain('topsecretvalue')
		expect(text).not.toContain('hunter2pw')
		const body = JSON.parse(text)
		const names = body.apps.map((a: { containerName: string }) => a.containerName)
		expect(names).toEqual(['web'])
		expect(body.apps[0].entries[0].value).toBe('****ue')
	})
	it('?app= path is masked too, and refuses powder', async () => {
		const text = await (await envGet(req('/api/env-vars', 'app=web'))).text()
		expect(text).not.toContain('topsecretvalue')
		const none = await (await envGet(req('/api/env-vars', 'app=powder'))).json()
		expect(none.apps).toEqual([])
	})
	it('token + reveal=1 is 403', async () => {
		expect((await envGet(req('/api/env-vars', 'reveal=1'))).status).toBe(403)
	})
	it('admin session + reveal=1 gets full values', async () => {
		user = { id: 'a', isAdmin: true }
		const body = await (await envGet(req('/api/env-vars', 'reveal=1'))).json()
		expect(body.apps[0].entries[0].value).toBe('topsecretvalue')
	})
	it('non-admin session + reveal=1 is 403', async () => {
		user = { id: 'b', isAdmin: false }
		expect((await envGet(req('/api/env-vars', 'reveal=1'))).status).toBe(403)
	})
})

describe('/api/databases', () => {
	beforeEach(() => {
		user = token
	})
	it('token user gets connection strings without passwords', async () => {
		const text = await (await dbGet(req('/api/databases'))).text()
		expect(text).not.toContain('hunter2pw')
		expect(text).not.toContain('kvpass')
		expect(text).toContain('postgres://app:****@web-db:5432/app')
		expect(text).toContain('redis://:****@web-kv:6379')
	})
	it('token + reveal=1 is 403', async () => {
		expect((await dbGet(req('/api/databases', 'reveal=1'))).status).toBe(403)
	})
	it('admin session + reveal=1 gets the full URL', async () => {
		user = { id: 'a', isAdmin: true }
		const text = await (await dbGet(req('/api/databases', 'reveal=1'))).text()
		expect(text).toContain('hunter2pw')
	})
})
