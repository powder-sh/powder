import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Previews build the app's own Dockerfile and route to its own port, not
// ./Dockerfile:3000. createRepo stores what /new validated (0065 container_port);
// an app with no stored port gets it from the parent's compose / Traefik label.
//
// The createRepo part needs a migrated scratch database (every file in
// packages/db/drizzle applied, 0065 included):
//   POWDER_TEST_DATABASE_URL=postgres:///powder_test pnpm -C apps/web test
// and is skipped without it. Never point it at a real powder database.
const url = process.env.POWDER_TEST_DATABASE_URL
if (url) {
	process.env.DATABASE_URL = url
	process.env.POWDER_ENCRYPTION_KEY ??= 'ab'.repeat(32)
}

const h = vi.hoisted(() => ({ server: { id: 's1' } as unknown, portReads: [] as string[] }))
vi.mock('server-only', () => ({}))
vi.mock('../servers', () => ({ getServer: async () => h.server }))
vi.mock('../app-domains', async (orig) => ({
	...((await orig()) as object),
	readAppContainerPort: async (_server: unknown, name: string) => {
		h.portReads.push(name)
		return 8081
	},
}))

// Imported in the tests, after DATABASE_URL is set (../db reads it once).
const load = async () => ({ ...(await import('../preview-deploys')), ...(await import('../app-settings')) })

describe('previewBuildInputs', () => {
	beforeEach(() => {
		h.server = { id: 's1' }
		h.portReads = []
	})
	it('a stored port and Dockerfile are used as they are, no compose read', async () => {
		const { previewBuildInputs } = await load()
		const r = await previewBuildInputs({ serverId: 's1', containerName: 'shop', dockerfilePath: 'docker/web.Dockerfile', containerPort: 4000 })
		expect(r).toEqual({ dockerfilePath: 'docker/web.Dockerfile', containerPort: 4000 })
		expect(h.portReads).toEqual([])
	})
	it('no stored port: read from the parent compose', async () => {
		const { previewBuildInputs } = await load()
		const r = await previewBuildInputs({ serverId: 's1', containerName: 'shop', dockerfilePath: './Dockerfile', containerPort: null })
		expect(r).toEqual({ dockerfilePath: './Dockerfile', containerPort: 8081 })
		expect(h.portReads).toEqual(['shop'])
	})
	it('no stored port and the server is gone: 3000', async () => {
		h.server = null
		const { previewBuildInputs } = await load()
		const r = await previewBuildInputs({ serverId: 's1', containerName: 'shop', dockerfilePath: '', containerPort: null })
		expect(r).toEqual({ dockerfilePath: './Dockerfile', containerPort: 3000 })
	})
})

describe('settings: preview Dockerfile and port', () => {
	it('valid values pass, null port clears, bad values are refused', async () => {
		const { validateAppSettings } = await load()
		expect(validateAppSettings({ dockerfilePath: ' docker/app.Dockerfile ', containerPort: 8080 })).toEqual({
			ok: true,
			value: { dockerfilePath: 'docker/app.Dockerfile', containerPort: 8080 },
		})
		expect(validateAppSettings({ containerPort: null })).toEqual({ ok: true, value: { containerPort: null } })
		for (const body of [{ dockerfilePath: '../x' }, { dockerfilePath: '/etc/x' }, { containerPort: 0 }, { containerPort: '80' }, { containerPort: 70000 }])
			expect(validateAppSettings(body).ok, JSON.stringify(body)).toBe(false)
	})
})

describe.skipIf(!url)('createRepo stores the Dockerfile and port (real postgres)', () => {
	const tag = `pbi${Date.now()}`
	const server = `srv_${tag}`
	let d: typeof import('../db')
	afterAll(async () => {
		if (!d) return
		await d.db.execute(d.sql`DELETE FROM app_repos WHERE server_id = ${server}`)
		await d.db.execute(d.sql`DELETE FROM servers WHERE id = ${server}`)
	})
	it('given values are stored; omitted ones default to ./Dockerfile and NULL', async () => {
		d = await import('../db')
		const { createRepo } = await import('../repos')
		await d.db.execute(d.sql`INSERT INTO servers (id, name, host) VALUES (${server}, ${server}, '192.0.2.10')`)
		const base = { serverId: server, repoUrl: 'git@github.com:zorb/zorbweb.git', branch: 'main', pub: 'ssh-ed25519 AAAA', priv: 'k' }
		const a = await createRepo({ ...base, containerName: `${tag}a`, dockerfilePath: 'docker/app.Dockerfile', containerPort: 8080 })
		expect(a.row).toMatchObject({ dockerfilePath: 'docker/app.Dockerfile', containerPort: 8080 })
		const b = await createRepo({ ...base, containerName: `${tag}b` })
		expect(b.row).toMatchObject({ dockerfilePath: './Dockerfile', containerPort: null })
	})
})
