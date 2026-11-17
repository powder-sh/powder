import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as Array<{ proxy?: string; id?: string }> }))

vi.mock('../db', () => {
	const chain = () => {
		const c: Record<string, unknown> = {}
		c.from = () => c
		c.where = () => c
		c.limit = () => c
		c.then = (res: (v: unknown) => unknown) => res(h.rows)
		return c
	}
	return {
		db: { select: () => chain() },
		eq: () => 0,
		servers: { id: 'id', proxy: 'proxy' },
	}
})
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../repos', () => ({}))

import { listTraefikServerIds, isTraefikServer } from '../traefik-servers'
import { previewBlockReason } from '../preview-deploys'

beforeEach(() => {
	h.rows = []
})

describe('isTraefikServer', () => {
	it('reads proxy off a server row without querying', async () => {
		expect(await isTraefikServer({ proxy: 'traefik' })).toBe(true)
		expect(await isTraefikServer({ proxy: 'nginx' })).toBe(false)
		expect(await isTraefikServer({})).toBe(false)
	})
	it('looks up servers.proxy by id', async () => {
		h.rows = [{ proxy: 'traefik' }]
		expect(await isTraefikServer('server-a')).toBe(true)
		h.rows = [{ proxy: 'nginx' }]
		expect(await isTraefikServer('server-a')).toBe(false)
	})
	it('unknown server id is not traefik', async () => {
		h.rows = []
		expect(await isTraefikServer('nope')).toBe(false)
	})
	it('lists traefik server ids', async () => {
		h.rows = [{ id: 'a' }, { id: 'b' }]
		expect(await listTraefikServerIds()).toEqual(['a', 'b'])
	})
})

describe('previewBlockReason', () => {
	it('blocks nginx servers', () => {
		expect(previewBlockReason({ traefik: false, serverId: 'server-a', baseDomain: 'x.dev' })).toMatch(/Traefik/)
	})
	it('allows a traefik server with a base domain', () => {
		expect(previewBlockReason({ traefik: true, serverId: 'cloud-1', baseDomain: 'apps.example.com' })).toBeNull()
		expect(previewBlockReason({ traefik: true, serverId: 'server-a', baseDomain: 'x.dev' })).toBeNull()
	})
	it('skips a traefik server without a base domain, with a reason', () => {
		const r = previewBlockReason({ traefik: true, serverId: 'server-a', baseDomain: null })
		expect(r).toMatch(/server-a/)
		expect(r).toMatch(/base domain/)
	})
})
