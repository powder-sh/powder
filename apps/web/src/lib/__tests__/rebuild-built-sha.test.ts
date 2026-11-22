// rebuildDeploy end to end (server, builder and guard stubbed): when a deploy fails, which
// commit the failure and the test gate result belong to, and what GitHub gets for it.
// The builder may build a newer commit (B) than the one requested (A) when A is no
// longer the branch tip; the target is then pinned to B. A target that fails before it
// prints its synced-sha marker (app lock, preflight, git sync) must still report B.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const H = vi.hoisted(() => ({
	builder: null as null | { sha: string | null; stageImage: string; testGate: 'passed' | 'failed' | 'none' | null },
	scriptOut: '',
}))

vi.mock('../ssh/connection', async (orig) => ({
	...(await orig<typeof import('../ssh/connection')>()),
	runCommand: vi.fn(async (_s: unknown, cmd: string) =>
		cmd.startsWith('timeout -k') && cmd.includes('powder-deploy') ? { code: 1, stdout: H.scriptOut, stderr: '' } : { code: 0, stdout: '', stderr: '' },
	),
}))
vi.mock('../ssh/files', async (orig) => ({ ...(await orig<typeof import('../ssh/files')>()), writeFileViaSftp: vi.fn(async () => {}) }))
vi.mock('../compose-override-io', () => ({
	applyComposeOverride: async () => ({ log: '' }),
	OverrideMergeError: class extends Error {},
}))
vi.mock('../deploy/compose-check', () => ({
	ComposeGuardError: class extends Error {},
	checkComposeForDeploy: async () => ({ hash: 'f'.repeat(64), structuralHash: 'f'.repeat(64), structuralView: null, log: '', enforce: true, dockerfileAuthority: null }),
}))
vi.mock('../builder', () => ({
	resolveComposeBuildFacts: async () => ({ image: 'demo:latest', context: '/opt/apps/demo/src', dockerfile: 'Dockerfile', args: {}, hasSecrets: false, hasAdditionalContexts: false }),
	runBuilderPhase: async () => {
		if (!H.builder) throw new Error('no builder')
		return H.builder
	},
}))
vi.mock('../deploy/fragments', async (orig) => ({ ...(await orig<typeof import('../deploy/fragments')>()), resolveInfraServices: async () => [] }))
// the GitHub side, for the end-to-end statuses
vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const chain = { from: () => chain, where: async () => [{ githubDeploymentId: null }] }
	return { ...real, db: { select: () => chain } }
})
vi.mock('../integrations', () => ({ getAdminGithubIntegration: async () => ({ token: 'tok-rebuild', username: null, source: 'pat' }) }))

import type { AppRepo } from '../db'
import { deployFailureFromError } from '../deploy-failure'
import { rebuildDeploy } from '../deploy/run'
import { notifyDeploymentFinished } from '../github-deployments'

const server = { id: 'srv-1', name: 'srv-1', host: '203.0.113.9', port: 22 } as never
const repo = { id: 'app_1', serverId: 'srv-1', containerName: 'demo', repoUrl: 'git@github.com:acme/demo.git', ownerUserId: 'u' } as unknown as AppRepo
const PREFLIGHT_FAIL = '── preflight ──\nthe server is out of disk\n__POWDER_FAIL__ step=preflight code=1\n'

async function failAt(opts: { builder: boolean; requested: string }) {
	const err = await rebuildDeploy(server, '/opt/apps/demo', '/opt/apps/demo/docker-compose.yml', 'demo', 'dep_1', undefined, {
		sha: opts.requested,
		branch: 'main',
		migrateApp: 'demo',
		...(opts.builder ? { builder: { host: '198.51.100.7', repoUrl: 'git@github.com:acme/demo.git', deployKeyPriv: 'k' } } : {}),
	}).then(
		() => null,
		(e: unknown) => e,
	)
	return deployFailureFromError(err)
}

let posted: { sha: string; context: string; state: string }[] = []
beforeEach(() => {
	posted = []
	H.builder = null
	H.scriptOut = PREFLIGHT_FAIL
	vi.stubEnv('BETTER_AUTH_URL', 'https://powder.example')
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const m = url.match(/\/statuses\/([0-9a-f]{40})$/)
		if (m) {
			const b = JSON.parse(String(init.body))
			posted.push({ sha: m[1] ?? '', context: b.context, state: b.state })
		}
		return new Response('{}', { status: 201 })
	})
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

// what failDeploy hands GitHub (deploy-runner.ts): the built commit when known
async function post(fail: Awaited<ReturnType<typeof failAt>>, requested: string) {
	await notifyDeploymentFinished(repo, 'dep_1', 'failure', fail.errorSummary, {
		kind: 'git_deploy',
		requestedSha: requested,
		sha: fail.builtSha,
		failedStep: fail.failedStep,
		errorSummary: fail.errorSummary,
		testGate: fail.testGate,
	})
}

describe('rebuildDeploy failure: the commit it belongs to', () => {
	it('builder built B for a requested A, target fails at preflight: failure and test-gate success on B, A closed as error', async () => {
		H.builder = { sha: B, stageImage: 'demo:latest-stage', testGate: 'passed' }
		const fail = await failAt({ builder: true, requested: A })
		expect(fail).toMatchObject({ failedStep: 'preflight', testGate: 'passed', builtSha: B })
		await post(fail, A)
		expect(posted).toEqual(
			expect.arrayContaining([
				{ sha: B, context: 'powder/deploy', state: 'failure' },
				{ sha: B, context: 'powder/test-gate', state: 'success' },
				{ sha: A, context: 'powder/deploy', state: 'error' },
			]),
		)
		expect(posted).toHaveLength(3)
	})
	it('builder built the requested commit: everything on it, nothing extra', async () => {
		H.builder = { sha: A, stageImage: 'demo:latest-stage', testGate: 'passed' }
		const fail = await failAt({ builder: true, requested: A })
		expect(fail.builtSha).toBe(A)
		await post(fail, A)
		expect(posted).toEqual([
			{ sha: A, context: 'powder/deploy', state: 'failure' },
			{ sha: A, context: 'powder/test-gate', state: 'success' },
		])
	})
	it('the builder reported no built commit (no nonced marker): the target was not pinned, so no commit is claimed', async () => {
		// prebuilt, but shaIsStrict stays false: wantSha is still only the requested commit,
		// which the builder may not have built, so it must not be reported as the built one
		H.builder = { sha: null, stageImage: 'demo:latest-stage', testGate: 'passed' }
		const fail = await failAt({ builder: true, requested: A })
		expect(fail).toMatchObject({ failedStep: 'preflight', builtSha: null })
	})
	it('no builder, the target fails before its synced-sha marker: no built commit, failure on the requested one, no test-gate status', async () => {
		const fail = await failAt({ builder: false, requested: A })
		expect(fail).toMatchObject({ failedStep: 'preflight', testGate: null, builtSha: null })
		await post(fail, A)
		expect(posted).toEqual([{ sha: A, context: 'powder/deploy', state: 'failure' }])
	})
	it('a forged plain synced line in the output does not count; only the nonced marker would', async () => {
		H.scriptOut = `__POWDER_SHA_forged__ ${B} main\n${PREFLIGHT_FAIL}`
		const fail = await failAt({ builder: false, requested: A })
		expect(fail.builtSha).toBeNull()
	})
})
