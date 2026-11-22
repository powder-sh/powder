// a deployment-group push must keep naming the group's GitHub
// repository id, like the single-app path.
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	group: {} as Record<string, unknown>,
	stored: [] as Array<[string, number]>,
	notified: [] as string[],
	started: 0,
}))

vi.mock('@/lib/deploy-runner', () => ({ runInWeb: vi.fn() }))
vi.mock('@/lib/deploys', () => ({
	DeployInFlightError: class extends Error {},
	deployWorkerEnabled: () => true,
	startDeploy: async () => {
		h.started++
		return { id: 'dep_1' }
	},
	recentSuccessfulGitShas: async () => [],
}))
vi.mock('@/lib/paths-match', () => ({ pathsMatch: () => true }))
vi.mock('@/lib/pending-redeploy', () => ({ schedulePendingRedeploy: vi.fn() }))
vi.mock('@/lib/github-deployments', () => ({
	notifyCommitPending: () => {},
	notifyPreviewCommit: async () => {},
	commentPreviewOnPR: vi.fn(),
	notifyDeploymentStarted: vi.fn(),
}))
vi.mock('@/lib/preview-deploys', () => ({
	previewSkipReason: async () => 'off',
	previewLastSha: async () => null,
	spinOrRedeployPreview: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ ok: true }) }))
vi.mock('@/lib/notifications', () => ({
	notify: async (_e: string, p: { app: string }) => {
		h.notified.push(p.app)
		return { delivered: 1, deduped: false }
	},
}))
vi.mock('@/lib/repos', () => ({
	decryptWebhookSecret: () => 'sek',
	getRepoByToken: async () => null,
	setRepoGithubIds: vi.fn(),
}))
vi.mock('@/lib/repo-groups', () => ({
	decryptWebhookSecretForGroup: () => 'gsek',
	getGroupByToken: async () => h.group,
	listSubAppsForGroup: async () => [
		{ id: 'r1', serverId: 's', containerName: 'api', pathsFilter: null },
		{ id: 'r2', serverId: 's', containerName: 'app', pathsFilter: null },
	],
	setGroupGithubRepoId: async (id: string, repoId: number) => {
		h.stored.push([id, repoId])
	},
}))

import { POST } from '../../app/api/webhooks/deploy/[token]/route'

let n = 0
const push = (repository?: Record<string, unknown>) => {
	const body = JSON.stringify({
		ref: 'refs/heads/main',
		after: `${'d'.repeat(39)}${n % 10}`,
		pusher: { name: 'me' },
		...(repository ? { repository } : {}),
	})
	const sig = `sha256=${createHmac('sha256', 'gsek').update(body).digest('hex')}`
	return POST(
		new Request('http://x/api/webhooks/deploy/gtok', {
			method: 'POST',
			headers: {
				'x-hub-signature-256': sig,
				'x-github-event': 'push',
				'x-github-delivery': `g${++n}`,
			},
			body,
		}),
		{ params: Promise.resolve({ token: 'gtok' }) },
	)
}

beforeEach(() => {
	h.group = {
		id: 'grp_1',
		branch: 'main',
		repoUrl: 'git@github.com:acme/mono.git',
		githubRepoId: 4242,
	}
	h.stored = []
	h.notified = []
	h.started = 0
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('group webhook repository id', () => {
	it('a push from another repository id is refused, nothing deploys, every sub-app is notified', async () => {
		const res = await push({ id: 9999, full_name: 'acme/mono' })
		expect(res.status).toBe(409)
		expect(h.started).toBe(0)
		expect(h.notified.sort()).toEqual(['api', 'app'])
	})
	it('the pinned id fans out', async () => {
		expect((await push({ id: 4242, full_name: 'acme/mono' })).status).toBe(202)
		expect(h.started).toBe(2)
		expect(h.stored).toEqual([])
	})
	it('no stored id: the first verified push stores it', async () => {
		h.group.githubRepoId = null
		expect((await push({ id: 4242, full_name: 'acme/mono' })).status).toBe(202)
		expect(h.stored).toEqual([['grp_1', 4242]])
	})
})
