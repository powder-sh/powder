// The app tabs render from ?part=db while the container state is read over
// SSH: that part never touches the server.
import { describe, expect, it, vi } from 'vitest'

const { inspect, chain } = vi.hoisted(() => {
	const chain: Record<string, unknown> = {}
	for (const k of ['select', 'from', 'where', 'orderBy', 'limit']) chain[k] = () => chain
	chain.then = (r: (v: unknown[]) => unknown) => r([])
	return { inspect: vi.fn(async () => ({ status: 'running' })), chain }
})
// the recent-deploys query has its own test (project-deploys-query.test.ts)
vi.mock('@/lib/project-deploys-db', () => ({ recentDeploysQuery: async () => [] }))
vi.mock('@/lib/db', () => ({
	db: chain,
	appRepos: {},
	appUptimeChecks: {},
	cronJobs: {},
	deploys: {},
	eq: () => 0,
	desc: () => 0,
	and: () => 0,
	sql: () => 0,
}))
vi.mock('@/lib/access', () => ({
	requireProjectAccess: async () => ({
		user: { id: 'u', isAdmin: true, viaToken: false },
		repo: { id: 'a', serverId: 's', containerName: 'app', repoUrl: 'x', branch: 'main', webhookToken: 't' },
	}),
}))
vi.mock('@/lib/servers', () => ({ getServer: async () => ({ id: 's', name: 'srv' }) }))
vi.mock('@/lib/ssh', () => ({ inspectContainer: inspect }))
vi.mock('@/lib/deploy-days-db', () => ({ deployDaysFor: async () => new Map() }))
vi.mock('@/lib/hosts', () => ({ webhookUrl: () => 'https://example.com/hook' }))

import { NextRequest } from 'next/server'
import { GET } from '../../app/api/projects/[id]/route'

const ctx = { params: Promise.resolve({ id: 'a' }) }

describe('GET /api/projects/[id]?part=db', () => {
	it('answers without the SSH inspect and without a container', async () => {
		const res = await GET(new NextRequest('http://x/api/projects/a?part=db'), ctx)
		const body = (await res.json()) as { project: { container?: unknown } }
		expect(res.status).toBe(200)
		expect(inspect).not.toHaveBeenCalled()
		expect(body.project.container).toBeUndefined()
	})
	it('the full read includes the container state', async () => {
		const res = await GET(new NextRequest('http://x/api/projects/a'), ctx)
		const body = (await res.json()) as { project: { container?: { reachable: boolean } } }
		expect(inspect).toHaveBeenCalledTimes(1)
		expect(body.project.container?.reachable).toBe(true)
	})
})
