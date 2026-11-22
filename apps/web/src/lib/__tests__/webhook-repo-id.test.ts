// a signed push must keep naming the connected GitHub repository
// id; a mismatch is refused (log + notification), an unset id is stored from
// the first verified push.
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	repo: {} as Record<string, unknown>,
	stored: [] as Array<Record<string, unknown>>,
	notified: [] as Array<{ event: string; message: string }>,
	started: 0,
}))

vi.mock('@/lib/deploy-runner', () => ({ runInWeb: vi.fn() }))
vi.mock('@/lib/deploys', () => ({
	DeployInFlightError: class extends Error {},
	AppBeingDeletedError: class extends Error {},
	appDeleteInFlight: async () => false,
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
	notify: async (event: string, p: { message: string }) => {
		h.notified.push({ event, message: p.message })
		return { delivered: 1, deduped: false }
	},
}))
vi.mock('@/lib/repos', () => ({
	decryptWebhookSecret: () => 'sek',
	getRepoByToken: async () => h.repo,
	setRepoGithubIds: async (id: string, ids: Record<string, unknown>) => {
		h.stored.push({ id, ...ids })
	},
}))
vi.mock('@/lib/repo-groups', () => ({
	decryptWebhookSecretForGroup: () => 'sek',
	getGroupByToken: async () => null,
	listSubAppsForGroup: async () => [],
}))

import { POST } from '../../app/api/webhooks/deploy/[token]/route'
import { repoIdDecision } from '../webhook-repo-id'

let n = 0
const push = (repository?: Record<string, unknown>) => {
	const body = JSON.stringify({
		ref: 'refs/heads/main',
		after: `${'c'.repeat(39)}${n % 10}`,
		pusher: { name: 'me' },
		...(repository ? { repository } : {}),
	})
	const sig = `sha256=${createHmac('sha256', 'sek').update(body).digest('hex')}`
	return POST(
		new Request('http://x/api/webhooks/deploy/tok', {
			method: 'POST',
			headers: {
				'x-hub-signature-256': sig,
				'x-github-event': 'push',
				'x-github-delivery': `r${++n}`,
			},
			body,
		}),
		{ params: Promise.resolve({ token: 'tok' }) },
	)
}

beforeEach(() => {
	h.repo = {
		id: 'repo_1',
		serverId: 's',
		containerName: 'web',
		branch: 'main',
		repoUrl: 'git@github.com:acme/web.git',
		githubRepoId: 777,
	}
	h.stored = []
	h.notified = []
	h.started = 0
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('webhook repository id', () => {
	it('a push from another repository id is refused, logged and notified', async () => {
		const res = await push({ id: 999, full_name: 'acme/web' })
		expect(res.status).toBe(409)
		expect((await res.json()).error).toContain('repository id 999')
		expect(h.started).toBe(0)
		expect(h.notified).toHaveLength(1)
		expect(h.notified[0]?.message).toContain('connected to repository id 777')
		expect(console.warn).toHaveBeenCalled()
	})
	it('the connected repository id deploys', async () => {
		expect((await push({ id: 777, full_name: 'acme/web' })).status).toBe(202)
		expect(h.started).toBe(1)
		expect(h.stored).toEqual([])
	})
	it('no stored id: the first verified push stores it and deploys', async () => {
		h.repo.githubRepoId = null
		expect((await push({ id: 777, full_name: 'acme/web' })).status).toBe(202)
		expect(h.stored).toEqual([{ id: 'repo_1', repoId: 777 }])
	})
	it('a body without repository (hand-made call) is not blocked', async () => {
		expect((await push()).status).toBe(202)
	})
	it('a rename with the same id only warns', () => {
		const d = repoIdDecision(
			{ githubRepoId: 777, repoUrl: 'git@github.com:acme/web.git' },
			{ id: 777, full_name: 'acme/web-renamed' },
		)
		expect(d.action).toBe('ok')
		expect(d.action === 'ok' && d.warn).toContain('acme/web-renamed')
	})
})
