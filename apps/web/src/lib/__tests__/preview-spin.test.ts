import { beforeEach, describe, expect, it, vi } from 'vitest'

const state: { rows: unknown[]; parent: boolean; deleting: boolean; deleted: string[]; inserted: number; onRebuild: (() => void) | null } = {
	rows: [],
	parent: true,
	deleting: false,
	deleted: [],
	inserted: 0,
	onRebuild: null,
}
const runCommand = vi.fn()
const rebuildDeploy = vi.fn()
const gitCloneRepo = vi.fn()
const writeFileSecret = vi.fn()
const writeFileViaSftp = vi.fn()

vi.mock('../db', () => ({
	appRepos: { t: 'app_repos' },
	previewDeploys: { t: 'preview_deploys' },
	prefixes: { previewDeploy: 'pv' },
	createId: () => 'pv_new',
	eq: () => null,
	db: {
		// app_repos by id (the parent check, selects { id }) answers the parent row;
		// every other read answers the preview rows
		select: (cols?: Record<string, unknown>) => ({
			from: (t: { t: string }) =>
				Object.assign(Promise.resolve([] as unknown[]), {
					where: () =>
						Promise.resolve(
							t.t === 'app_repos' && cols && 'id' in cols ? (state.parent ? [{ id: 'r1' }] : []) : state.rows,
						),
				}),
		}),
		insert: () => ({
			values: async () => {
				state.inserted++
			},
		}),
		update: () => ({ set: () => ({ where: async () => {} }) }),
		delete: (t: { t: string }) => ({
			where: async () => {
				state.deleted.push(t.t)
			},
		}),
	},
}))
vi.mock('../deploys', () => ({ appDeleteInFlight: async () => state.deleting }))
vi.mock('../app-domains', () => ({ routeHostsFor: async () => [] }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))
vi.mock('../repos', () => ({ decryptDeployKey: () => 'KEY' }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 's1', host: 'h', user: 'root', baseDomain: 'apps.example.com' }) }))
vi.mock('../ssh', () => ({
	runCommand: (...a: unknown[]) => runCommand(...a),
	rebuildDeploy: (...a: unknown[]) => rebuildDeploy(...a),
	gitCloneRepo: (...a: unknown[]) => gitCloneRepo(...a),
	writeFileSecret: (...a: unknown[]) => writeFileSecret(...a),
	writeFileViaSftp: (...a: unknown[]) => writeFileViaSftp(...a),
}))

import { PreviewParentGoneError, previewSkipReason, previewTeardownShell, spinOrRedeployPreview, tearDownPreview } from '../preview-deploys'

const repo = { id: 'r1', serverId: 's1', containerName: 'shop', repoUrl: 'git@github.com:o/r.git', healthUrl: null } as never
const existing = (status: string) => ({
	id: 'pv1', appRepoId: 'r1', branchSlug: 'feature', branch: 'feature', containerName: 'pv-shop-feature',
	workingDir: '/opt/apps/pv-shop-feature', url: 'https://pv-shop-feature.apps.example.com', status,
})

beforeEach(() => {
	state.parent = true
	state.deleting = false
	state.deleted = []
	state.inserted = 0
	state.onRebuild = null
	for (const m of [runCommand, rebuildDeploy, gitCloneRepo, writeFileSecret, writeFileViaSftp]) m.mockReset()
	runCommand.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' })
	rebuildDeploy.mockImplementation(async () => {
		state.onRebuild?.()
		return { output: 'built' }
	})
	gitCloneRepo.mockResolvedValue({ output: '' })
})

describe('spinOrRedeployPreview', () => {
	it('passes the branch to rebuildDeploy', async () => {
		state.rows = [existing('running')]
		await spinOrRedeployPreview(repo, 'feature')
		const call = rebuildDeploy.mock.calls[0]
		if (!call) throw new Error('rebuildDeploy was not called')
		expect(call[6]).toEqual({ branch: 'feature', swapOrdinal: expect.any(Number), skipMigrate: true, cacheNamespace: null, composeGuard: { routeHosts: expect.any(Array), extraEnvFiles: ['/opt/apps/shop.preview.env'] } })
		expect(gitCloneRepo).not.toHaveBeenCalled()
	})

	it('an un-hashed slug row is reused only for the same branch', async () => {
		state.rows = [{ ...existing('running'), branchSlug: 'feat-x', branch: 'feat/x' }]
		await spinOrRedeployPreview(repo, 'feat/x')
		expect(gitCloneRepo).not.toHaveBeenCalled() // reused: no fresh clone
		gitCloneRepo.mockClear()
		await spinOrRedeployPreview(repo, 'feat-x') // same readable slug, DIFFERENT branch
		expect(gitCloneRepo).toHaveBeenCalledTimes(1) // new preview, not the other branch's
	})

	it('a preview left failed by a first spin is re-cloned', async () => {
		state.rows = [existing('failed')]
		await spinOrRedeployPreview(repo, 'feature')
		expect(gitCloneRepo).toHaveBeenCalledTimes(1)
	})

	it('a missing compose file is treated as a first spin', async () => {
		state.rows = [existing('running')]
		runCommand.mockImplementation(async (_s: unknown, cmd: string) => ({
			code: 0,
			stdout: /-f .*docker-compose\.yml/.test(cmd) && /echo ok/.test(cmd) ? 'missing' : 'ok',
			stderr: '',
		}))
		await spinOrRedeployPreview(repo, 'feature')
		expect(gitCloneRepo).toHaveBeenCalledTimes(1)
	})

	it('removes the planted key copy when the clone fails', async () => {
		state.rows = []
		gitCloneRepo.mockRejectedValue(new Error('clone failed'))
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toThrow('clone failed')
		const keyPath = writeFileSecret.mock.calls[0]?.[1] as string
		expect(runCommand.mock.calls.some((c) => String(c[1]).startsWith('rm -f ') && String(c[1]).includes(`'${keyPath}'`))).toBe(true)
	})

	it('the compose uses the preview env file only, never the production env', async () => {
		state.rows = [existing('running')]
		await spinOrRedeployPreview(repo, 'feature')
		// compose goes over SFTP at 0600, never base64 in a command line.
		expect(writeFileViaSftp).toHaveBeenCalledTimes(1)
		expect(writeFileViaSftp.mock.calls[0]?.[3]).toBe(0o600)
		const yaml = String(writeFileViaSftp.mock.calls[0]?.[2])
		const yamlB64 = Buffer.from(yaml, 'utf8').toString('base64')
		expect(runCommand.mock.calls.some((c) => String(c[1]).includes(yamlB64))).toBe(false)
		expect(yaml).toContain('/opt/apps/shop.preview.env')
		expect(yaml).not.toContain('/opt/apps/shop.env')
	})
})

describe('preview teardown by label, never compose down', () => {
	const RM = 'rm -' + 'rf'
	it('the teardown shell removes by project label and network name only', () => {
		const sh = previewTeardownShell('pv-shop-feature')
		expect(sh).not.toMatch(/compose (down|-f|config)/)
		expect(sh).toContain("docker ps -aq --filter 'label=com.docker.compose.project=pv-shop-feature'")
		expect(sh).toContain("docker network rm 'pv-shop-feature_default'")
	})

	it('tearDownPreview runs the label teardown, no compose parse of the checkout', async () => {
		state.rows = [existing('running')]
		await tearDownPreview('pv1')
		const cmds = runCommand.mock.calls.map((c) => String(c[1]))
		expect(cmds.some((c) => c.includes('label=com.docker.compose.project=pv-shop-feature') && c.includes(`${RM} '/opt/apps/pv-shop-feature'`))).toBe(true)
		expect(cmds.some((c) => /docker compose/.test(c))).toBe(false)
	})

	it('a failed first spin removes the refused clone', async () => {
		state.rows = []
		rebuildDeploy.mockRejectedValue(new Error('compose guard: refused'))
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toThrow('refused')
		const wd = String(gitCloneRepo.mock.calls[0]?.[1])
		expect(runCommand.mock.calls.some((c) => String(c[1]).includes(`${RM} '${wd}'`))).toBe(true)
	})

	it('a failed redeploy of a running preview keeps its checkout', async () => {
		state.rows = [existing('running')]
		rebuildDeploy.mockRejectedValue(new Error('build failed'))
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toThrow('build failed')
		expect(runCommand.mock.calls.some((c) => String(c[1]).includes(RM))).toBe(false)
	})
})

describe('previewSkipReason', () => {
	it('previews are opt-in per app', async () => {
		expect(await previewSkipReason({ ...(repo as object), previewsEnabled: false } as never)).toMatch(/previews are off/)
		expect(await previewSkipReason({ ...(repo as object), previewsEnabled: true } as never)).toBeNull()
	})
})

describe('a preview never outlives its app', () => {
	const RM = 'rm -' + 'rf'
	it('an app being deleted when the spin starts: refused before any command, no row', async () => {
		state.rows = []
		state.deleting = true
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toBeInstanceOf(PreviewParentGoneError)
		expect(runCommand).not.toHaveBeenCalled()
		expect(gitCloneRepo).not.toHaveBeenCalled()
		expect(state.inserted).toBe(0)
	})
	it('an app row gone when the spin starts: refused the same way', async () => {
		state.rows = [existing('running')]
		state.parent = false
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toThrow(/app shop was deleted/)
		expect(rebuildDeploy).not.toHaveBeenCalled()
	})
	it('a delete that starts before the new preview is registered: no row, no clone', async () => {
		state.rows = []
		runCommand.mockImplementation(async (_s: unknown, cmd: string) => {
			if (cmd.startsWith('if [ -e')) state.deleting = true // during the name check
			return { code: 0, stdout: 'ok', stderr: '' }
		})
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toBeInstanceOf(PreviewParentGoneError)
		expect(state.inserted).toBe(0)
		expect(gitCloneRepo).not.toHaveBeenCalled()
	})
	it('the app deleted while the preview built: its container, checkout and row are removed', async () => {
		state.rows = []
		state.onRebuild = () => {
			state.parent = false
		}
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toBeInstanceOf(PreviewParentGoneError)
		const cmds = runCommand.mock.calls.map((c) => String(c[1]))
		const wd = String(gitCloneRepo.mock.calls[0]?.[1])
		expect(cmds.some((c) => c.includes('label=com.docker.compose.project=pv-shop-') && c.includes(`${RM} '${wd}'`))).toBe(true)
		expect(state.deleted).toEqual(['preview_deploys'])
	})
	it('a delete started while a redeploy built: the running preview is removed too', async () => {
		state.rows = [existing('running')]
		state.onRebuild = () => {
			state.deleting = true
		}
		await expect(spinOrRedeployPreview(repo, 'feature')).rejects.toThrow(/is being deleted/)
		const cmds = runCommand.mock.calls.map((c) => String(c[1]))
		expect(cmds.some((c) => c.includes('label=com.docker.compose.project=pv-shop-feature') && c.includes(`${RM} '/opt/apps/pv-shop-feature'`))).toBe(true)
		expect(state.deleted).toEqual(['preview_deploys'])
	})
})
