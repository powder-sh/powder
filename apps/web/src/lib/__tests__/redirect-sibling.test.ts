import { beforeEach, describe, expect, it, vi } from 'vitest'

// a www/apex redirect writes a Traefik router (priority 300) or an nginx
// server_name for the SIBLING host too (www.X for X, X for www.X). Only the app's own
// hostname was checked, so app A owning shop.example could take www.shop.example
// from app B.

// app_domains rows by lowercase hostname; app_repos: shop -> r1.
const domains: Record<string, Array<{ appRepoId: string; status: string }>> = {}
const ran = vi.fn()
vi.mock('../ssh', () => ({
	runCommand: (...a: unknown[]) => {
		ran(...a)
		return { code: 0, stdout: '', stderr: '' }
	},
}))
vi.mock('../db', () => {
	let lastHost = ''
	const appRepos = { __t: 'repos', id: 'id', serverId: 'serverId', containerName: 'containerName' }
	const appDomains = {
		__t: 'domains',
		hostname: 'hostname',
		appRepoId: 'appRepoId',
		status: 'status',
	}
	const sql = (_s: TemplateStringsArray, ..._v: unknown[]) => {
		lastHost = String(_v[1] ?? '')
		return 1
	}
	const db = {
		select: () => ({
			from: (t: { __t: string }) => ({
				where: () => {
					const rows = () => (t.__t === 'repos' ? [{ id: 'r1' }] : (domains[lastHost] ?? []))
					const p = Promise.resolve().then(rows) as Promise<unknown[]> & {
						limit: () => Promise<unknown[]>
					}
					p.limit = () => Promise.resolve().then(rows)
					return p
				},
			}),
		}),
	}
	return { and: () => 1, eq: () => 1, sql, db, appRepos, appDomains }
})

const { siblingHostAllowed } = await import('../domain-ownership')
const { applyToTraefik, wwwRedirectHost } = await import('../domain-redirects')

const server = { id: 's1', host: 'h', proxy: 'traefik' } as never

beforeEach(() => {
	for (const k of Object.keys(domains)) delete domains[k]
	ran.mockReset()
	domains['shop.example'] = [{ appRepoId: 'r1', status: 'live' }]
})

describe('www/apex sibling host', () => {
	it('wwwRedirectHost names the host the redirect answers on', () => {
		expect(wwwRedirectHost({ hostname: 'shop.example', wwwMode: 'apex' })).toBe('www.shop.example')
		expect(wwwRedirectHost({ hostname: 'www.shop.example', wwwMode: 'www' })).toBe('shop.example')
		expect(wwwRedirectHost({ hostname: 'shop.example', wwwMode: 'none' })).toBeNull()
	})

	it('siblingHostAllowed: own verified/live, or nobody else', () => {
		expect(siblingHostAllowed([], 'r1')).toBe(true)
		expect(siblingHostAllowed([{ appRepoId: 'r1', status: 'verified' }], 'r1')).toBe(true)
		expect(siblingHostAllowed([{ appRepoId: 'r1', status: 'pending' }], 'r1')).toBe(true)
		expect(siblingHostAllowed([{ appRepoId: 'r2', status: 'pending' }], 'r1')).toBe(false)
		expect(siblingHostAllowed([{ appRepoId: 'r2', status: 'live' }], 'r1')).toBe(false)
		expect(
			siblingHostAllowed(
				[
					{ appRepoId: 'r2', status: 'live' },
					{ appRepoId: 'r1', status: 'live' },
				],
				'r1',
			),
		).toBe(true)
	})

	it('refuses a redirect whose sibling belongs to another app, before writing anything', async () => {
		domains['www.shop.example'] = [{ appRepoId: 'r2', status: 'live' }]
		await expect(
			applyToTraefik(server, 'shop', [{ hostname: 'shop.example', wwwMode: 'apex', custom: [] }]),
		).rejects.toThrow(/www\.shop\.example belongs to another app/)
		expect(ran).not.toHaveBeenCalled()
	})

	it('allows a sibling nobody claims, and one that is a domain of this app', async () => {
		// Past the ownership gate the writer talks to the server (the file provider probe here).
		const r1 = await applyToTraefik(server, 'shop', [
			{ hostname: 'shop.example', wwwMode: 'apex', custom: [] },
		]).catch((e: Error) => e)
		expect(String(r1)).not.toMatch(/another app|does not belong/)
		expect(ran).toHaveBeenCalled()
		ran.mockReset()
		domains['www.shop.example'] = [{ appRepoId: 'r1', status: 'verified' }]
		const r2 = await applyToTraefik(server, 'shop', [
			{ hostname: 'shop.example', wwwMode: 'apex', custom: [] },
		]).catch((e: Error) => e)
		expect(String(r2)).not.toMatch(/another app|does not belong/)
		expect(ran).toHaveBeenCalled()
	})
})
