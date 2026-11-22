// GET /api/projects/[id]: the webhook URL carries the app's deploy token, so an API
// token caller gets a `<token>` placeholder (as the context route answers).
// GET /api/projects/[id]/context: recent deploys are keyed on server AND container.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	const wheres: unknown[] = []
	const chain: Record<string, unknown> = {}
	for (const k of ['select', 'from', 'orderBy', 'limit']) chain[k] = () => chain
	chain.where = (w: unknown) => {
		wheres.push(w)
		return chain
	}
	chain.then = (r: (v: unknown[]) => unknown) => r([])
	return { wheres, chain, user: { id: 'u', isAdmin: true, viaToken: false } as Record<string, unknown> }
})
vi.mock('@/lib/db', () => ({
	db: h.chain,
	appRepos: {},
	appUptimeChecks: {},
	cronJobs: {},
	deploys: { serverId: 'deploys.server_id', containerName: 'deploys.container_name' },
	eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
	desc: () => 0,
	and: (...a: unknown[]) => ({ and: a }),
	sql: () => 0,
}))
vi.mock('@/lib/access', () => ({
	requireProjectAccess: async () => ({
		user: h.user,
		repo: {
			id: 'a',
			serverId: 's1',
			containerName: 'app',
			repoUrl: 'x',
			branch: 'main',
			webhookToken: 'secret-hook-token',
		},
	}),
}))
vi.mock('@/lib/servers', () => ({ getServer: async () => ({ id: 's1', name: 'srv', host: 'h', kind: 'compose' }) }))
vi.mock('@/lib/ssh', () => ({
	inspectContainer: async () => {
		throw new Error('no ssh in tests')
	},
	getNginxRoutes: async () => [],
	getContainerHostNetInfo: async () => new Map(),
}))
vi.mock('@/lib/managed-containers', () => ({ managedContainerNames: async () => [] }))
// the recent-deploys query has its own test (project-deploys-query.test.ts)
vi.mock('@/lib/project-deploys-db', () => ({ recentDeploysQuery: async () => [] }))
vi.mock('@/lib/deploy-days-db', () => ({ deployDaysFor: async () => new Map() }))
vi.mock('@/lib/hosts', () => ({
	webhookUrl: (token: string) => `https://example.com/api/webhooks/deploy/${token}`,
	webhookBaseUrl: () => 'https://example.com',
	dashboardUrl: () => 'https://dash.example.com',
}))

import { NextRequest } from 'next/server'
import { GET as contextGET } from '../../app/api/projects/[id]/context/route'
import { GET } from '../../app/api/projects/[id]/route'

const ctx = { params: Promise.resolve({ id: 'a' }) }

beforeEach(() => {
	h.wheres.length = 0
})

describe('GET /api/projects/[id] webhookUrl', () => {
	it('an admin session gets the real webhook URL', async () => {
		h.user = { id: 'u', isAdmin: true, viaToken: false }
		const body = (await (await GET(new NextRequest('http://x/api/projects/a?part=db'), ctx)).json()) as {
			webhookUrl: string
		}
		expect(body.webhookUrl).toBe('https://example.com/api/webhooks/deploy/secret-hook-token')
	})
	it('an API token caller gets the <token> placeholder, never the deploy token', async () => {
		h.user = { id: 'u', isAdmin: true, viaToken: true, tokenId: 't' }
		const res = await GET(new NextRequest('http://x/api/projects/a?part=db'), ctx)
		const text = await res.text()
		expect(JSON.parse(text).webhookUrl).toBe('https://example.com/api/webhooks/deploy/<token>')
		expect(text).not.toContain('secret-hook-token')
	})
})

describe('GET /api/projects/[id]/context recent deploys', () => {
	it('filters on the app server as well as the container name', async () => {
		h.user = { id: 'u', isAdmin: true, viaToken: true, tokenId: 't' }
		const res = await contextGET(new Request('http://x/api/projects/a/context'), ctx)
		expect(res.status).toBe(200)
		expect(h.wheres).toContainEqual({
			and: [{ eq: ['deploys.server_id', 's1'] }, { eq: ['deploys.container_name', 'app'] }],
		})
		expect(h.wheres).not.toContainEqual({ eq: ['deploys.container_name', 'app'] })
	})
})
