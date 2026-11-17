// the CI diagnose route picks its GitHub token like the other background
// paths: only a current admin's, never a removed owner's.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ admin: vi.fn(), plain: vi.fn() }))
vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u-viewer' }),
	// the one project access check, run on the mocked db and the real powderSelfDenied
	requireProjectAccess: async (id: string) => {
		const { db, appRepos, eq } = (await import('@/lib/db')) as unknown as { db: { select: () => { from: (t: unknown) => { where: (w: unknown) => { limit: (n: number) => Promise<Array<{ containerName?: string }>> } } } }; appRepos: { id: unknown }; eq: (a: unknown, b: unknown) => unknown }
		const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, id)).limit(1)
		if (!repo) return Response.json({ error: 'not found' }, { status: 404 })
		const { powderSelfDenied } = await vi.importActual<typeof import('../secret-mask')>('../secret-mask')
		return powderSelfDenied(repo.containerName ?? '') ?? { user: { id: 'u-viewer' }, repo }
	},
}))
vi.mock('@/lib/db', () => {
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: async () => [
			{ id: 'p1', repoUrl: 'https://github.com/acme/web', ownerUserId: 'u-gone' },
		],
	}
	return { appRepos: {}, eq: () => null, db: { select: () => chain } }
})
vi.mock('@/lib/integrations', () => ({
	getAdminGithubIntegration: h.admin,
	getGithubIntegration: h.plain,
}))
vi.mock('@/lib/github-ci', () => ({
	getRunFailureTail: async () => 'tail',
	parseGitHubRepo: () => ({ owner: 'acme', repo: 'web' }),
}))
vi.mock('@/lib/ci-translate', () => ({
	translateFailure: () => ({ source: 'pattern' }),
	diagnoseFailureWithLlm: vi.fn(),
}))

import { POST } from '../../app/api/projects/[id]/ci/[runId]/diagnose/route'

describe('diagnose token', () => {
	beforeEach(() => {
		h.admin.mockReset()
		h.plain.mockReset()
	})
	it('asks the admin-only picker with the owner preferred, never the raw lookup', async () => {
		h.admin.mockResolvedValue({ token: 't', username: null, source: 'pat' })
		const res = await POST(new Request('http://x'), {
			params: Promise.resolve({ id: 'p1', runId: '5' }),
		})
		expect(res.status).toBe(200)
		expect(h.admin).toHaveBeenCalledWith('u-gone')
		expect(h.plain).not.toHaveBeenCalled()
	})
	it('no admin token: 400', async () => {
		h.admin.mockResolvedValue(null)
		const res = await POST(new Request('http://x'), {
			params: Promise.resolve({ id: 'p1', runId: '5' }),
		})
		expect(res.status).toBe(400)
	})
})
