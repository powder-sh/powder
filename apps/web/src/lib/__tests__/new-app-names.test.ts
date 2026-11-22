// /new refuses a reserved name and a name whose
// /opt/apps/<name>.env already exists, before any side effect.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	commands: [] as string[],
	envExists: false,
	deployKeys: 0,
	stopAtKey: true,
	stored: [] as Array<Record<string, unknown>>,
	// docker networks on the stub server; `docker network create` fails when set
	networks: new Set<string>(),
	createFails: false,
	// container names of preview rows (any status)
	previewNames: new Set<string>(),
}))

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u1', isAdmin: true }),
	requireServerForUser: async () => ({ id: 's1', kind: 'compose', tlsMode: 'letsencrypt' }),
}))
vi.mock('@/lib/auth', () => ({ auth: {} }))
vi.mock('@/lib/app-hosts', () => ({ NO_BASE_DOMAIN_MESSAGE: '', defaultHostFor: () => null }))
vi.mock('@/lib/traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('@/lib/deploy-runner', () => ({ runInWeb: vi.fn() }))
vi.mock('@/lib/deploys', () => ({
	DeployInFlightError: class extends Error {},
	deployWorkerEnabled: () => true,
	startDeploy: vi.fn(),
}))
vi.mock('@/lib/github-deployments', () => ({ notifyCommitPending: () => {}, notifyPreviewCommit: async () => {}, notifyDeploymentStarted: vi.fn() }))
vi.mock('@/lib/github', () => ({
	commitFile: vi.fn(),
	createDeployKey: async () => {
		h.deployKeys++
		if (h.stopAtKey) throw new Error('stop here')
		return { id: 11, key: 'k' }
	},
	createWebhook: async () => ({ id: 22, url: 'u' }),
	getRepoInfo: async () => ({ id: 777, full_name: 'acme/web' }),
	getRepoFile: async () => 'exists',
	repoHasDockerfile: async () => true,
	getRepo: vi.fn(),
}))
vi.mock('@/lib/framework-detect', () => ({
	detectFromPackageJson: vi.fn(),
	detectPackageManager: vi.fn(),
	dockerfileFor: vi.fn(),
}))
vi.mock('@/lib/integrations', () => ({ getGithubIntegration: async () => ({ token: 't' }) }))
vi.mock('@/lib/keygen', () => ({ generateDeployKey: async () => ({ pub: 'p', priv: 'k' }) }))
vi.mock('@/lib/repos', () => ({
	projectNameProblem: async () => null,
	previewNameProblem: async (n: string) => (h.previewNames.has(n) ? `"${n}" is the name of a preview of another app` : null),
	createRepo: async () => ({ row: { id: 'repo_1', webhookToken: 'wt' }, webhookSecret: 'ws' }),
	setRepoGithubIds: async (id: string, ids: Record<string, unknown>) => {
		h.stored.push({ id, ...ids })
	},
}))
vi.mock('@/lib/app-runtime-files', () => ({ writeRuntimeFilesShell: () => '' }))
vi.mock('@/lib/ssh', () => ({
	gitCloneRepo: vi.fn(),
	listContainers: async () => [],
	runCommand: async (_s: unknown, cmd: string) => {
		h.commands.push(cmd)
		const net = /^docker network inspect (\S+) .*\|\| docker network create (\S+)$/.exec(cmd)
		if (net) {
			if (h.networks.has(net[1])) return { code: 0, stdout: '', stderr: '' }
			if (h.createFails) return { code: 1, stdout: '', stderr: 'permission denied' }
			h.networks.add(net[2])
			return { code: 0, stdout: `${net[2]}-id\n`, stderr: '' }
		}
		if (cmd.includes('.env') && cmd.includes('env-exists'))
			return { code: 0, stdout: h.envExists ? 'env-exists\n' : 'ok\n', stderr: '' }
		return { code: 0, stdout: 'ok\n', stderr: '' }
	},
	pickFreeHostPort: async () => 3100,
	writeEnvFile: vi.fn(),
	writeFileSecret: vi.fn(),
	writeFileViaSftp: vi.fn(),
}))

import { POST } from '../../app/api/apps/route'
import { createNetworkCommand } from '../server-bootstrap'
import { MAX_EXTRA_RESERVED_APP_NAMES, RESERVED_APP_NAMES, reservedAppNameError, reservedAppNames } from '../app-names'

const post = (name: string) =>
	POST(
		new Request('http://x/api/apps', {
			method: 'POST',
			body: JSON.stringify({ serverId: 's1', repoFullName: 'acme/web', name }),
		}) as never,
	)

beforeEach(() => {
	h.commands = []
	h.envExists = false
	h.deployKeys = 0
	h.stopAtKey = true
	h.stored = []
	h.networks = new Set()
	h.createFails = false
	h.previewNames = new Set()
})

describe('/new name checks', () => {
	it('a name a preview row has (any status) is refused before touching the server or GitHub', async () => {
		h.previewNames.add('shop-feature')
		const r = await post('shop-feature')
		expect(r.status).toBe(400)
		expect((await r.json()).error).toContain('is the name of a preview')
		expect(h.commands).toEqual([])
		expect(h.deployKeys).toBe(0)
	})
	it('reserved names are refused before touching the server or GitHub', async () => {
		for (const n of ['powder', 'powder-worker', 'traefik', 'postgres', 'mem-cap']) {
			expect(RESERVED_APP_NAMES).toContain(n)
			const r = await post(n)
			expect(r.status, n).toBe(400)
			expect((await r.json()).error).toContain('reserved')
		}
		expect(h.commands).toEqual([])
		expect(h.deployKeys).toBe(0)
	})
	it('POWDER_RESERVED_APP_NAMES adds names to the reserved list', async () => {
		vi.stubEnv('POWDER_RESERVED_APP_NAMES', ' ops-agent, Metrics-Hub ,,')
		try {
			for (const n of ['ops-agent', 'metrics-hub']) {
				const r = await post(n)
				expect(r.status, n).toBe(400)
				expect((await r.json()).error).toContain('reserved')
			}
			expect(h.commands).toEqual([])
			expect(h.deployKeys).toBe(0)
		} finally {
			vi.unstubAllEnvs()
		}
		expect(reservedAppNameError('ops-agent', {})).toBeNull()
	})
	it('POWDER_RESERVED_APP_NAMES: bad entries are ignored, the count is bounded', () => {
		const env = { POWDER_RESERVED_APP_NAMES: 'ok-name,9bad,a,has space,under_score,../etc' }
		const extra = reservedAppNames(env).filter((n) => !RESERVED_APP_NAMES.includes(n))
		expect(extra).toEqual(['ok-name'])
		const many = Array.from({ length: MAX_EXTRA_RESERVED_APP_NAMES + 10 }, (_, i) => `name-${i}`).join(',')
		const added = reservedAppNames({ POWDER_RESERVED_APP_NAMES: many }).filter((n) => !RESERVED_APP_NAMES.includes(n))
		expect(added).toHaveLength(MAX_EXTRA_RESERVED_APP_NAMES)
		expect(reservedAppNames({})).toEqual(RESERVED_APP_NAMES)
	})
	it('an existing /opt/apps/<name>.env is refused before the deploy key', async () => {
		h.envExists = true
		const r = await post('shop')
		expect(r.status).toBe(400)
		expect((await r.json()).error).toContain('/opt/apps/shop.env already exists')
		expect(h.deployKeys).toBe(0)
	})
	it('a free name goes on (to the deploy key step)', async () => {
		const r = await post('shop')
		expect(h.deployKeys).toBe(1)
		expect(r.status).toBe(502)
	})
	it('a clone this request placed and then refused is removed by its marker, so the name can be retried', async () => {
		h.stopAtKey = false
		const { gitCloneRepo } = await import('@/lib/ssh')
		const { CloneError } = await import('../ssh/git')
		const { cloneMarkerMatchShell } = await import('../clone-marker')
		vi.mocked(gitCloneRepo).mockRejectedValueOnce(new CloneError('clone refused: the repo tracks hostile symlink(s)', false, true, null, 'symlinks'))
		const r = await post('shop')
		expect(r.status).toBe(500)
		const cleanup = h.commands.find((c) => c.includes('rm -rf')) ?? ''
		expect(cleanup).toContain(`if ${cloneMarkerMatchShell('/opt/apps/shop', 'app:shop')}; then rm -rf -- '/opt/apps/shop'; fi`)
	})
	it('a clone refused before placement removes nothing', async () => {
		h.stopAtKey = false
		const { gitCloneRepo } = await import('@/lib/ssh')
		const { CloneError } = await import('../ssh/git')
		vi.mocked(gitCloneRepo).mockRejectedValueOnce(new CloneError('clone refused: exists', true, false, null, 'exists'))
		const r = await post('shop')
		expect(r.status).toBe(500)
		expect(h.commands.some((c) => c.includes('rm -rf'))).toBe(false)
	})
	it('a successful /new stores the deploy key id, the hook id (and the repo id)', async () => {
		h.stopAtKey = false
		const r = await post('shop')
		expect(r.status).toBe(200)
		expect(h.stored).toEqual([{ id: 'repo_1', deployKeyId: 11, hookId: 22, repoId: 777 }])
	})
})

describe('/new makes sure the shared networks its compose names exist', () => {
	const postWith = (body: Record<string, unknown>) =>
		POST(
			new Request('http://x/api/apps', {
				method: 'POST',
				body: JSON.stringify({ serverId: 's1', repoFullName: 'acme/web', name: 'shop', ...body }),
			}) as never,
		)
	it('a server without web gets it, with the bootstrap command, before the deploy key', async () => {
		h.stopAtKey = false
		const r = await postWith({})
		expect(r.status).toBe(200)
		expect(h.networks).toEqual(new Set(['web']))
		const i = h.commands.indexOf(createNetworkCommand('web'))
		expect(i).toBeGreaterThanOrEqual(0)
		expect(h.commands).not.toContain(createNetworkCommand('internal'))
	})
	it('an existing web is left alone; the internal opt-in creates internal too', async () => {
		h.stopAtKey = false
		h.networks = new Set(['web'])
		const r = await postWith({ sharedInternal: true })
		expect(r.status).toBe(200)
		expect(h.networks).toEqual(new Set(['web', 'internal']))
		expect(h.commands).toContain(createNetworkCommand('internal'))
	})
	it('a network that cannot be created stops /new with the reason, before the deploy key', async () => {
		h.createFails = true
		const r = await postWith({})
		expect(r.status).toBe(500)
		expect((await r.json()).error).toBe('could not create the docker network web on the server: permission denied')
		expect(h.deployKeys).toBe(0)
	})
})
