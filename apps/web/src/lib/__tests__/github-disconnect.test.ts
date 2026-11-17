// connect records the GitHub deploy key + webhook ids, disconnect
// deletes both on GitHub (best effort), and the audit script finds orphan keys.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	deleted: [] as string[],
	failKey: false,
	stored: [] as Array<Record<string, unknown>>,
	repoRow: null as Record<string, unknown> | null,
	deletedRows: [] as string[],
}))

vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({
		user: { id: 'u1', viaToken: false },
		server: { id: 's1', kind: 'compose' },
	}),
}))
vi.mock('@/lib/github', async (orig) => ({
	...(await orig<typeof import('../github')>()),
	createDeployKey: async () => ({ id: 11, key: 'k' }),
	createWebhook: async () => ({ id: 22, url: 'u' }),
	getRepoInfo: async () => ({ id: 777, full_name: 'acme/web' }),
	deleteDeployKey: async (_t: string, o: string, r: string, id: number) => {
		if (h.failKey) throw new Error('github 403: Must have admin rights')
		h.deleted.push(`${o}/${r} key ${id}`)
	},
	deleteWebhook: async (_t: string, o: string, r: string, id: number) => {
		h.deleted.push(`${o}/${r} hook ${id}`)
	},
}))
vi.mock('@/lib/integrations', () => ({
	getGithubIntegration: async () => ({ token: 'tok' }),
	getAdminGithubIntegration: async () => null,
}))
vi.mock('@/lib/keygen', () => ({ generateDeployKey: async () => ({ pub: 'p', priv: 'k' }) }))
vi.mock('@/lib/env-vars-db', () => ({
	auditCtxFromRequest: () => ({}),
	bulkImportFromText: async () => ({ imported: 0, existing: 0, skipped: 0 }),
}))
vi.mock('@/lib/repos', () => ({
	projectNameProblem: async () => null,
	appNamesOnServer: async () => [],
	createRepo: async () => ({
		row: { id: 'repo_1', webhookToken: 'wt', createdAt: new Date(0) },
		webhookSecret: 'ws',
	}),
	deleteRepo: async (id: string) => {
		h.deletedRows.push(id)
	},
	getRepoFor: async () => h.repoRow,
	setRepoGithubIds: async (id: string, ids: Record<string, unknown>) => {
		h.stored.push({ id, ...ids })
	},
	decryptWebhookSecret: () => 'ws',
}))
vi.mock('@/lib/ssh', () => ({
	GITHUB_KNOWN_HOSTS_SETUP: '',
	GIT_SSH_HOSTKEY_OPTS: '',
	findEnvFile: async () => ({ exists: false }),
	inspectContainer: async () => ({ compose: { workingDir: '/opt/apps/web', configFile: null } }),
	runCommand: async () => ({ code: 0, stdout: 'refs/heads/main\n', stderr: '' }),
	writeFileSecret: async () => {},
	deleteRemoteFile: async () => {},
}))

import { POST as importPost } from '../../app/api/servers/[id]/containers/[name]/repo/import/route'
import { DELETE as disconnect } from '../../app/api/servers/[id]/containers/[name]/repo/route'

const ctx = { params: Promise.resolve({ id: 's1', name: 'web' }) }

beforeEach(() => {
	h.deleted = []
	h.failKey = false
	h.stored = []
	h.repoRow = null
	h.deletedRows = []
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GitHub deploy key + webhook lifecycle', () => {
	it('repo import stores the deploy key id and the hook id', async () => {
		const res = await importPost(
			new Request('http://x', {
				method: 'POST',
				body: JSON.stringify({ repoFullName: 'acme/web' }),
			}) as never,
			ctx,
		)
		expect(res.status).toBe(200)
		expect(h.stored).toEqual([{ id: 'repo_1', deployKeyId: 11, hookId: 22, repoId: 777 }])
	})
	it('disconnect deletes both on GitHub, then the row', async () => {
		h.repoRow = {
			id: 'repo_1',
			repoUrl: 'git@github.com:acme/web.git',
			ownerUserId: 'u1',
			githubDeployKeyId: 11,
			githubHookId: 22,
		}
		const body = await (await disconnect(new Request('http://x'), ctx)).json()
		expect(h.deleted).toEqual(['acme/web hook 22', 'acme/web key 11'])
		expect(body.github).toEqual({ deployKey: 'deleted', hook: 'deleted' })
		expect(h.deletedRows).toEqual(['repo_1'])
	})
	it('a GitHub failure is logged and reported; the disconnect still happens', async () => {
		h.failKey = true
		h.repoRow = {
			id: 'repo_1',
			repoUrl: 'git@github.com:acme/web.git',
			ownerUserId: 'u1',
			githubDeployKeyId: 11,
			githubHookId: 22,
		}
		const body = await (await disconnect(new Request('http://x'), ctx)).json()
		expect(body.ok).toBe(true)
		expect(body.github.deployKey).toMatch(/^failed: github 403/)
		expect(body.github.hook).toBe('deleted')
		expect(console.warn).toHaveBeenCalled()
		expect(h.deletedRows).toEqual(['repo_1'])
	})
	it('rows without GitHub ids touch nothing on GitHub', async () => {
		h.repoRow = { id: 'repo_1', repoUrl: 'git@github.com:acme/web.git', ownerUserId: 'u1' }
		const body = await (await disconnect(new Request('http://x'), ctx)).json()
		expect(h.deleted).toEqual([])
		expect(body.github).toEqual({ deployKey: 'not recorded', hook: 'not recorded' })
	})
})
