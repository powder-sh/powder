// GET /api/projects/[id] says why previews cannot work on the app's server (the same
// previewBlockReason the webhook gives), so the settings toggle can say so instead of
// being offered. And one duration format for the deploys list and the deploy page.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	const chain: Record<string, unknown> = {}
	for (const k of ['select', 'from', 'where', 'orderBy', 'limit']) chain[k] = () => chain
	chain.then = (r: (v: unknown[]) => unknown) => r([])
	return { chain, server: { id: 'srv-1', name: 'srv-1', host: 'h', kind: 'compose', proxy: 'traefik', baseDomain: null } as Record<string, unknown> }
})
vi.mock('@/lib/db', () => ({
	db: h.chain,
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
		repo: { id: 'a', serverId: 'srv-1', containerName: 'shop', repoUrl: 'x', branch: 'main', webhookToken: 't', previewsEnabled: false },
	}),
}))
vi.mock('@/lib/servers', () => ({ getServer: async () => h.server }))
vi.mock('@/lib/ssh', () => ({
	inspectContainer: async () => {
		throw new Error('no ssh in tests')
	},
}))
// the recent-deploys query has its own test (project-deploys-query.test.ts)
vi.mock('@/lib/project-deploys-db', () => ({ recentDeploysQuery: async () => [] }))
vi.mock('@/lib/deploy-days-db', () => ({ deployDaysFor: async () => new Map() }))
vi.mock('@/lib/hosts', () => ({ webhookUrl: (token: string) => `https://example.com/hook/${token}` }))

import { NextRequest } from 'next/server'
import { GET } from '../../app/api/projects/[id]/route'
import { formatDuration } from '../format'

const ctx = { params: Promise.resolve({ id: 'a' }) }
const read = async () => (await (await GET(new NextRequest('http://x/api/projects/a?part=db'), ctx)).json()) as { previewBlockReason: string | null }

beforeEach(() => {
	h.server = { id: 'srv-1', name: 'srv-1', host: 'h', kind: 'compose', proxy: 'traefik', baseDomain: null }
})

describe('project API: previewBlockReason', () => {
	it('a server without a base domain: the reason', async () => {
		expect((await read()).previewBlockReason).toMatch(/previews are not available on srv-1: no base domain set on this server/)
	})
	it('a server that is not Traefik: the reason', async () => {
		h.server = { ...h.server, proxy: 'nginx', baseDomain: 'apps.example.com' }
		expect((await read()).previewBlockReason).toMatch(/need a Traefik server/)
	})
	it('a Traefik server with a base domain: null', async () => {
		h.server = { ...h.server, baseDomain: 'apps.example.com' }
		expect((await read()).previewBlockReason).toBeNull()
	})
})

describe('formatDuration', () => {
	it('one format: 90 s is "1m 30s", not "2m"', () => {
		expect(formatDuration(90_000)).toBe('1m 30s')
		expect(formatDuration(850)).toBe('850ms')
		expect(formatDuration(45_300)).toBe('45s')
		expect(formatDuration(65 * 60_000)).toBe('1h 5m')
		expect(formatDuration(null)).toBe('-')
	})
})
