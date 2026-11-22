// Lookups keyed by an app's owner go stale once that user is removed (the
// app_repos / domain_redirects rows keep the old id). The CI tab uses a current
// admin's GitHub token (getAdminGithubIntegration, like the diagnose route), and
// the domains list loads redirect config by (server, container, hostname), never
// by owner_user_id. Invented names only.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	adminCalls: [] as unknown[],
	plainCalls: [] as unknown[],
	redirectWhere: [] as unknown[],
	repo: { id: 'r1', serverId: 'boxa', containerName: 'zorbweb', repoUrl: 'git@github.com:zorbco/zorbweb.git', branch: 'main', ownerUserId: 'gone_user' },
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/access', () => ({
	requireProjectAccess: async () => ({ repo: h.repo, user: { id: 'admin2', isAdmin: true } }),
	requireUser: async () => ({ id: 'admin2', isAdmin: true }),
	visibleRepos: async () => [h.repo],
}))
vi.mock('@/lib/integrations', () => ({
	getAdminGithubIntegration: async (id: unknown) => {
		h.adminCalls.push(id)
		return { token: 'tok', username: 'a', source: 'pat' }
	},
	getGithubIntegration: async (id: unknown) => {
		h.plainCalls.push(id)
		return null
	},
}))
vi.mock('@/lib/github-ci', () => ({
	parseGitHubRepo: () => ({ owner: 'zorbco', repo: 'zorbweb' }),
	listRunsForRepo: async () => [],
	listWorkflowsForRepo: async () => [],
	getCommitBySha: async () => null,
	getRunFailureTail: async () => '',
}))
vi.mock('@/lib/db', () => ({
	domainRedirects: { serverId: 'domain_redirects.server_id', ownerUserId: 'domain_redirects.owner_user_id' },
	inArray: (col: unknown, vals: unknown) => ({ inArray: [col, vals] }),
	// the ci tab's deploy checks: query helpers and the deploys columns
	sql: () => ({}),
	and: (...a: unknown[]) => ({ and: a }),
	eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
	desc: (col: unknown) => ({ desc: col }),
	gte: (col: unknown, v: unknown) => ({ gte: [col, v] }),
	isNotNull: (col: unknown) => ({ isNotNull: col }),
	deploys: { serverId: 'deploys.server_id', containerName: 'deploys.container_name', kind: 'deploys.kind', status: 'deploys.status', startedAt: 'deploys.started_at' },
	db: {
		select: () => ({
			from: (table: { serverId?: unknown }) => ({
				where: (w: unknown) => {
					// deploys: no rows; the chain goes on with orderBy/limit/groupBy
					if (table?.serverId === 'deploys.server_id') {
						return Object.assign(Promise.resolve([]), {
							orderBy: () => ({ limit: async () => [] }),
							groupBy: async () => [],
						})
					}
					h.redirectWhere.push(w)
					return Promise.resolve([
						{ serverId: 'boxa', containerName: 'zorbweb', hostname: 'zorb.example', ownerUserId: 'gone_user', wwwMode: 'apex', customRedirectsJson: '[]', appliedAt: null, appliedError: null },
					])
				},
			}),
		}),
	},
}))
vi.mock('@/lib/servers', () => ({
	getServer: async () => ({ id: 'boxa', name: 'boxa', proxy: 'traefik' }),
	listAllServers: async () => [{ id: 'boxa', name: 'boxa', proxy: 'traefik' }],
}))
vi.mock('@/lib/managed-containers', () => ({ managedContainerNames: async () => ['zorbweb'] }))
vi.mock('@/lib/ssh', () => ({
	listContainers: async () => [{ name: 'zorbweb', ports: '127.0.0.1:3100->3000/tcp' }],
	getNginxRoutes: async () => [{ host: 'zorbweb', port: null, urls: ['https://zorb.example'] }],
	getContainerHostNetInfo: async () => new Map(),
	extractHostPorts: () => [],
	runCommand: async () => ({ stdout: '' }),
}))

import { GET as ciGET } from '../../app/api/projects/[id]/ci/route'
import { GET as domainsGET } from '../../app/api/domains/route'

beforeEach(() => {
	h.adminCalls = []
	h.plainCalls = []
	h.redirectWhere = []
})

describe('the owner was removed', () => {
	it('the CI tab asks for a current admin token, never the stored owner token alone', async () => {
		const res = await ciGET(new Request('http://x'), { params: Promise.resolve({ id: 'r1' }) })
		expect(res.status).toBe(200)
		expect(((await res.json()) as { connected?: boolean }).connected).not.toBe(false)
		expect(h.adminCalls).toEqual(['gone_user'])
		expect(h.plainCalls).toEqual([])
	})
	it('the domains list shows redirect config saved by the removed user', async () => {
		const res = await domainsGET(new Request('http://x/api/domains'))
		const body = (await res.json()) as { domains: Array<{ hostname: string; wwwMode: string }> }
		expect(body.domains).toEqual([expect.objectContaining({ hostname: 'zorb.example', wwwMode: 'apex' })])
		expect(JSON.stringify(h.redirectWhere)).not.toContain('owner_user_id')
	})
	it('no route or lib filters a table by owner_user_id', () => {
		const src = join(__dirname, '../..')
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((n) => {
				const p = join(dir, n)
				if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p)
				return /\.tsx?$/.test(n) ? [p] : []
			})
		const offenders = walk(src)
			.filter((f) => /eq\(\s*\w+\.ownerUserId/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(src, f))
		expect(offenders).toEqual([])
	})
})
