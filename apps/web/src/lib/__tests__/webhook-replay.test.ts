import { gitHardenShellFunctions } from '../git-harden'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const state = { last: null as string | null, recent: [] as string[], group: false, preview: null as string | null, deleting: false }
const startDeploy = vi.fn(async () => ({ id: 'dep_1' }))

vi.mock('@/lib/deploy-runner', () => ({ runInWeb: vi.fn() }))
vi.mock('@/lib/deploys', () => ({
	DeployInFlightError: class extends Error {},
	AppBeingDeletedError: class extends Error {},
	appDeleteInFlight: async () => state.deleting === true,
	deployWorkerEnabled: () => true,
	startDeploy: (...a: unknown[]) => startDeploy(...(a as [])),
	recentSuccessfulGitShas: async () => (state.last ? [state.last, ...state.recent] : state.recent),
}))
vi.mock('@/lib/paths-match', () => ({ pathsMatch: () => true }))
vi.mock('@/lib/pending-redeploy', () => ({ schedulePendingRedeploy: vi.fn() }))
vi.mock('@/lib/github-deployments', () => ({ notifyCommitPending: () => {}, notifyPreviewCommit: async () => {}, commentPreviewOnPR: vi.fn(), notifyDeploymentStarted: vi.fn() }))
const spin = vi.fn(async () => ({ url: 'https://p.example' }))
vi.mock('@/lib/preview-deploys', () => ({ previewBuildInputs: async (r: { dockerfilePath?: string; containerPort?: number }) => ({ dockerfilePath: r.dockerfilePath ?? './Dockerfile', containerPort: r.containerPort ?? 3000 }), previewSkipReason: async () => null, previewLastSha: async () => state.preview, spinOrRedeployPreview: (...a: unknown[]) => spin(...(a as [])) }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ ok: true }) }))
vi.mock('@/lib/repos', () => ({
	decryptWebhookSecret: () => 'sek',
	getRepoByToken: async () => (state.group ? null : { serverId: 's', containerName: 'web', branch: 'main', dockerfilePath: 'docker/app.Dockerfile', containerPort: 8080 }),
}))
vi.mock('@/lib/repo-groups', () => ({
	decryptWebhookSecretForGroup: () => 'sek',
	getGroupByToken: async () => (state.group ? { id: 'g', branch: 'main' } : null),
	listSubAppsForGroup: async () => [
		{ serverId: 's', containerName: 'a', pathsFilter: null },
		{ serverId: 's', containerName: 'b', pathsFilter: null },
	],
}))

import { POST } from '../../app/api/webhooks/deploy/[token]/route'
import { gitResolveTarget } from '../ssh'

let n = 0
const push = (after: string, extra: Record<string, unknown> = {}, ref = 'refs/heads/main') => {
	const body = JSON.stringify({ ref, after, pusher: { name: 'me' }, ...extra })
	const sig = `sha256=${createHmac('sha256', 'sek').update(body).digest('hex')}`
	return POST(
		new Request('http://x/api/webhooks/deploy/tok', {
			method: 'POST',
			headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push', 'x-github-delivery': `d${++n}` },
			body,
		}),
		{ params: Promise.resolve({ token: 'tok' }) },
	)
}

describe('webhook replay of the already-deployed sha', () => {
	beforeEach(() => {
		startDeploy.mockClear()
		state.last = null
	})
	it('same sha as the last successful deploy: 200 already deployed, nothing queued', async () => {
		state.last = SHA
		const res = await push(SHA)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ ignored: 'already deployed' })
		expect(startDeploy).not.toHaveBeenCalled()
	})
	it('signed powder_force:true queues even for the already-deployed sha', async () => {
		state.last = SHA
		const res = await push(SHA, { powder_force: true })
		expect(res.status).toBe(202)
		expect(startDeploy).toHaveBeenCalledTimes(1)
	})
	it('powder_force of a non-true value does not force', async () => {
		state.last = SHA
		expect((await push(SHA, { powder_force: 'true' })).status).toBe(200)
		expect(startDeploy).not.toHaveBeenCalled()
	})
	it('a different sha queues a deploy', async () => {
		state.last = SHA
		const res = await push(OTHER)
		expect(res.status).toBe(202)
		expect(startDeploy).toHaveBeenCalledTimes(1)
	})
	it('no previous successful deploy: queues', async () => {
		expect((await push(SHA)).status).toBe(202)
	})
	it('an OLDER sha still in the last-20 set is ignored too; powder_force overrides', async () => {
		state.last = OTHER
		state.recent = [SHA]
		const res = await push(SHA)
		expect(await res.json()).toMatchObject({ ignored: 'already deployed' })
		expect(startDeploy).not.toHaveBeenCalled()
		expect((await push(SHA, { powder_force: true })).status).toBe(202)
		state.recent = []
	})
})

describe('a push while the app is being deleted', () => {
	beforeEach(() => {
		startDeploy.mockClear()
		spin.mockClear()
		state.last = null
		state.deleting = true
	})
	it('409, no deploy is queued and no preview is spun', async () => {
		const res = await push(SHA)
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'app is being deleted' })
		expect((await push(OTHER, {}, 'refs/heads/feat')).status).toBe(409)
		expect(startDeploy).not.toHaveBeenCalled()
		expect(spin).not.toHaveBeenCalled()
		state.deleting = false
	})
})

describe('group webhook replay guard', () => {
	beforeEach(() => {
		startDeploy.mockClear()
		state.last = null
		state.recent = []
		state.group = true
	})
	it('ignores a sub-app whose recent shas include `after`, deploys the others', async () => {
		state.recent = [SHA]
		const res = await push(SHA)
		const j = await res.json()
		expect(j.alreadyDeployed).toEqual(['a', 'b'])
		expect(startDeploy).not.toHaveBeenCalled()
		state.recent = []
		const res2 = await push(OTHER)
		expect((await res2.json()).triggered).toEqual(['a', 'b'])
		expect(startDeploy).toHaveBeenCalledTimes(2)
		state.group = false
	})
})

describe('preview replay guard', () => {
	beforeEach(() => {
		spin.mockClear()
		state.group = false
		state.preview = null
	})
	it('a replayed push of the sha the preview already runs is ignored; a new sha spins', async () => {
		state.preview = SHA
		const res = await push(SHA, {}, 'refs/heads/feat')
		expect(await res.json()).toMatchObject({ ignored: 'preview already at this commit' })
		expect(spin).not.toHaveBeenCalled()
		const res2 = await push(OTHER, {}, 'refs/heads/feat')
		expect(res2.status).toBe(202)
		expect(spin).toHaveBeenCalledTimes(1)
		// the app's own port and Dockerfile, not the ./Dockerfile:3000 defaults
		expect((spin.mock.calls[0] as unknown[]).slice(1, 4)).toEqual(['feat', 8080, 'docker/app.Dockerfile'])
		expect((await push(SHA, { powder_force: true }, 'refs/heads/feat')).status).toBe(202)
	})
})

describe('an accepted preview delivery is remembered', () => {
	it('a replay of the same delivery id does not spin the preview again', async () => {
		spin.mockClear()
		state.group = false
		state.preview = null
		const body = JSON.stringify({ ref: 'refs/heads/feat2', after: OTHER, pusher: { name: 'me' } })
		const sig = `sha256=${createHmac('sha256', 'sek').update(body).digest('hex')}`
		const send = () =>
			POST(
				new Request('http://x/api/webhooks/deploy/tok', {
					method: 'POST',
					headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push', 'x-github-delivery': 'delivery-same' },
					body,
				}),
				{ params: Promise.resolve({ token: 'tok' }) },
			)
		expect((await send()).status).toBe(202)
		const again = await send()
		expect(again.status).not.toBe(202)
		expect(spin).toHaveBeenCalledTimes(1)
	})
})

const git = (cwd: string, ...a: string[]) =>
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim()

describe('ancestry base when the server has no HEAD', () => {
	const sha: Record<string, string> = {}
	let work = ''
	beforeAll(() => {
		const root = mkdtempSync(join(tmpdir(), 's10-'))
		const origin = join(root, 'origin')
		git(root, 'init', '-q', '-b', 'main', origin)
		for (const c of ['c1', 'c2', 'c3']) {
			writeFileSync(join(origin, c), c)
			git(origin, 'add', '.')
			git(origin, 'commit', '-q', '-m', c)
			sha[c] = git(origin, 'rev-parse', 'HEAD')
		}
		work = join(root, 'work')
		git(root, 'init', '-q', '-b', 'main', work) // unborn HEAD: CUR is empty
		git(work, 'remote', 'add', 'origin', origin)
		git(work, 'fetch', '-q', 'origin')
	})
	const target = (wanted: string, base: string | null) => {
		const frag = gitResolveTarget("'*'", 'main', wanted, false, base)
		const out = execFileSync('bash', ['-c', `${gitHardenShellFunctions()}retry() { "$@"; }; ${frag} echo "TARGET=$TARGET"`], { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } })
		return /TARGET=(.*)/.exec(out)?.[1] ?? ''
	}
	it('without a base, an ancestor sha is accepted (the base closes this)', () => {
		expect(target((sha.c1 ?? ''), null)).toBe(sha.c1)
	})
	it('with the DB git_sha as base, a replayed ancestor deploys HEAD', () => {
		expect(target((sha.c1 ?? ''), (sha.c3 ?? ''))).toBe(sha.c3) // origin/main resolved to its sha
	})
	it('with the base, a forward sha is still pinned', () => {
		expect(target((sha.c3 ?? ''), (sha.c2 ?? ''))).toBe(sha.c3)
	})
})
