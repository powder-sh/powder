// The webhook marks a push urgent (never held on the settle window, lib/deploy-settle.ts)
// for powder_force or `[urgent]` in any commit message of the push, on the single-app path and for
// every sub-app row of a monorepo fan-out push; a GitHub redelivery starts nothing.
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	group: null as Record<string, unknown> | null,
	calls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/deploy-runner', () => ({ runInWeb: vi.fn() }))
vi.mock('@/lib/deploys', () => ({
	DeployInFlightError: class extends Error {},
	AppBeingDeletedError: class extends Error {},
	appDeleteInFlight: async () => false,
	deployWorkerEnabled: () => true,
	startDeploy: async (o: Record<string, unknown>) => {
		h.calls.push(o)
		return o.urgent
			? { id: `dep_${h.calls.length}`, status: 'queued', notBefore: null }
			: { id: `dep_${h.calls.length}`, status: 'queued', notBefore: new Date(Date.now() + 600_000) }
	},
	recentSuccessfulGitShas: async () => [],
}))
vi.mock('@/lib/paths-match', () => ({ pathsMatch: () => true }))
vi.mock('@/lib/pending-redeploy', () => ({ schedulePendingRedeploy: vi.fn() }))
vi.mock('@/lib/github-deployments', () => ({ commentPreviewOnPR: vi.fn(), notifyDeploymentStarted: vi.fn() }))
vi.mock('@/lib/preview-deploys', () => ({
	previewSkipReason: async () => 'off',
	previewLastSha: async () => null,
	spinOrRedeployPreview: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ ok: true }) }))
vi.mock('@/lib/notifications', () => ({ notify: async () => ({ delivered: 1, deduped: false }) }))
vi.mock('@/lib/repos', () => ({
	decryptWebhookSecret: () => 'sek',
	getRepoByToken: async () =>
		h.group
			? null
			: { id: 'repo_1', serverId: 's', containerName: 'web', branch: 'main', repoUrl: 'git@github.com:acme/web.git', githubRepoId: 777 },
	setRepoGithubIds: vi.fn(),
}))
vi.mock('@/lib/repo-groups', () => ({
	decryptWebhookSecretForGroup: () => 'sek',
	getGroupByToken: async () => h.group,
	listSubAppsForGroup: async () => [
		{ id: 'r1', serverId: 's', containerName: 'api', pathsFilter: null },
		{ id: 'r2', serverId: 's', containerName: 'app', pathsFilter: null },
	],
	setGroupGithubRepoId: vi.fn(),
}))

import { POST } from '../../app/api/webhooks/deploy/[token]/route'

let n = 0
const push = (extra: Record<string, unknown>, delivery = `u${++n}`) => {
	const body = JSON.stringify({
		ref: 'refs/heads/main',
		after: `${'e'.repeat(39)}${n % 10}`,
		pusher: { name: 'me' },
		repository: h.group ? { id: 4242, full_name: 'acme/mono' } : { id: 777, full_name: 'acme/web' },
		commits: [{ modified: ['src/a.ts'] }],
		...extra,
	})
	const sig = `sha256=${createHmac('sha256', 'sek').update(body).digest('hex')}`
	return POST(
		new Request('http://x/api/webhooks/deploy/tok', {
			method: 'POST',
			headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push', 'x-github-delivery': delivery },
			body,
		}),
		{ params: Promise.resolve({ token: 'tok' }) },
	)
}

beforeEach(() => {
	h.group = null
	h.calls = []
})

describe('single-app push', () => {
	it('a plain push is not urgent; the answer says it waits and how to skip it', async () => {
		const res = await push({ head_commit: { message: 'tweak copy', modified: ['src/a.ts'] } })
		expect(res.status).toBe(202)
		expect(h.calls).toHaveLength(1)
		expect(h.calls[0]).toMatchObject({ triggeredBy: 'webhook:me', urgent: false })
		const body = await res.json()
		expect(body.waiting).toContain('to bundle further pushes')
		expect(body.waiting).toContain('redeploy now')
	})
	it('[urgent] in the head commit message, any case', async () => {
		await push({ head_commit: { message: 'fix checkout [Urgent]', modified: ['src/a.ts'] } })
		expect(h.calls[0]).toMatchObject({ urgent: true })
	})
	it('powder_force', async () => {
		await push({ powder_force: true })
		expect(h.calls[0]).toMatchObject({ urgent: true })
	})
	it('[urgent] in a commit that is not the head commit counts too', async () => {
		await push({ commits: [{ message: '[urgent] fix', modified: ['src/a.ts'] }, { message: 'later' }], head_commit: { message: 'later', modified: ['src/a.ts'] } })
		expect(h.calls[0]).toMatchObject({ urgent: true })
	})
	it('GitHub redelivering the same push starts nothing a second time', async () => {
		await push({ head_commit: { message: 'x', modified: ['src/a.ts'] } }, 'same-delivery')
		const again = await push({ head_commit: { message: 'x', modified: ['src/a.ts'] } }, 'same-delivery')
		expect((await again.json()).ignored).toBe('duplicate delivery')
		expect(h.calls).toHaveLength(1)
	})
})

describe('monorepo fan-out push', () => {
	beforeEach(() => {
		h.group = { id: 'grp_1', branch: 'main', repoUrl: 'git@github.com:acme/mono.git', githubRepoId: 4242 }
	})
	it('every sub-app row gets the hold', async () => {
		await push({ head_commit: { message: 'tweak', modified: ['src/a.ts'] } })
		expect(h.calls.map((c) => [c.containerName, c.triggeredBy, c.urgent])).toEqual([
			['api', 'webhook-group:me', false],
			['app', 'webhook-group:me', false],
		])
	})
	it('[urgent] applies to every sub-app row of the push', async () => {
		await push({ head_commit: { message: '[urgent] hotfix', modified: ['src/a.ts'] } })
		expect(h.calls.map((c) => c.urgent)).toEqual([true, true])
	})
})
