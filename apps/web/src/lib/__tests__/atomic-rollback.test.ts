import { beforeEach, describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn()
const runHealthGate = vi.fn()
vi.mock('../db', () => ({}))
vi.mock('../ssh', () => ({ runCommand: (...a: unknown[]) => runCommand(...a) }))
vi.mock('../deploys', () => ({ runHealthGate: (...a: unknown[]) => runHealthGate(...a) }))
vi.mock('../servers', () => ({
	getServer: async () => ({ id: 's1', host: 'h', user: 'root', baseDomain: 'apps.example.com', tlsMode: 'acme' }),
}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))
// the recreate guard runs the deploy's compose check (own test: recreate-guard)
const recreateChecks: unknown[] = []
vi.mock('../recreate-guard', () => ({
	checkComposeForRecreate: async (_s: unknown, p: unknown) => {
		recreateChecks.push(p)
		return { hash: '', app: 'x', log: '' }
	},
}))

import { atomicRollback, imageRepo, pickComposeImage } from '../deploy-snapshots'

const deploy = { id: 'dep_1', imageTag: 'reg:5000/team/app:deploy-abc' } as never
const repo = { serverId: 's1', containerName: 'demoapp' } as never

let imageLabels = '{"com.docker.compose.project":"demoapp","com.docker.compose.service":"demoapp","com.docker.compose.version":"2.35.1"}'
function script(failOn?: RegExp) {
	runCommand.mockImplementation(async (_s: unknown, cmd: string) => {
		if (/json \.Config\.Labels/.test(cmd)) return { code: 0, stdout: `${imageLabels}\n`, stderr: '' }
		if (/inspect -f/.test(cmd)) return { code: 0, stdout: 'sha256:prev\n', stderr: '' }
		if (/config --images/.test(cmd)) return { code: 0, stdout: 'postgres:16\nreg:5000/team/app:latest\n', stderr: '' }
		if (failOn?.test(cmd)) return { code: 1, stdout: '', stderr: 'boom' }
		return { code: 0, stdout: '', stderr: '' }
	})
}
const cmds = () => runCommand.mock.calls.map((c) => String(c[1]))

describe('atomicRollback', () => {
	beforeEach(() => {
		runCommand.mockReset()
		runHealthGate.mockReset()
		runHealthGate.mockResolvedValue({ healthy: true, output: 'ok' })
	})

	it('removes the -rb container even when the recreate fails', async () => {
		script(/--force-recreate/)
		await expect(atomicRollback(deploy, repo)).rejects.toThrow(/recreate/)
		const c = cmds()
		const lastRm = c.map((x, i) => (/docker rm -f 'demoapp-rb'/.test(x) ? i : -1)).filter((i) => i >= 0).pop() as number
		expect(lastRm).toBeGreaterThan(c.findIndex((x) => /--force-recreate/.test(x)))
	})

	it('retags to the compose image ref (registry port kept), runs up under pipefail, then health gates', async () => {
		script()
		await atomicRollback(deploy, repo)
		const c = cmds()
		// ONE locked shell: lock, then retag, then up (never a bare retag outside the lock)
		const locked = c.find((x) => /--force-recreate/.test(x)) ?? ''
		expect(locked).toMatch(/^bash -o pipefail -c /)
		expect(locked.indexOf('flock')).toBeGreaterThan(-1)
		expect(locked.indexOf('flock')).toBeLessThan(locked.indexOf('deploy-abc'))
		expect(locked.indexOf('deploy-abc')).toBeLessThan(locked.indexOf('--force-recreate'))
		expect(c.some((x) => /^docker tag 'reg:5000/.test(x))).toBe(false)
		expect(runHealthGate).toHaveBeenCalledTimes(1)
	})

	it('the -rb bridge drops NET_RAW and blanks the compose labels', async () => {
		script()
		await atomicRollback(deploy, repo)
		const run = cmds().find((x) => /docker run -d --pull=never --name 'demoapp-rb'/.test(x))
		expect(run).toContain('--cap-drop NET_RAW')
		expect(run).toContain('--label com.docker.compose.project= ')
		expect(run).toContain('--label com.docker.compose.project.config_files= ')
	})

	it('refuses an image with a com.docker.compose.* label compose never sets on an image', async () => {
		const keep = imageLabels
		imageLabels = '{"com.docker.compose.project.config_files":"/opt/apps/other/docker-compose.yml"}'
		try {
			script()
			await expect(atomicRollback(deploy, repo)).rejects.toThrow(/config_files/)
			expect(cmds().some((x) => /docker run/.test(x))).toBe(false)
		} finally {
			imageLabels = keep
		}
	})

	it('an unhealthy rolled-back container fails the rollback', async () => {
		script()
		runHealthGate.mockResolvedValue({ healthy: false, output: 'down' })
		await expect(atomicRollback(deploy, repo)).rejects.toThrow(/UNHEALTHY/)
	})

	const facts = { configFile: '/srv/x/compose.yml', service: 'app', workingDir: '/srv/x' }
	const restoreRe = /docker tag [^a-z]*sha256:prev/

	it('uses the compose file and SERVICE from the container inspection', async () => {
		script()
		await atomicRollback(deploy, repo, facts)
		const up = cmds().find((x) => /--force-recreate/.test(x)) ?? ''
		expect(up).toContain('/srv/x/compose.yml')
		expect(up).toContain("app")
		// success: no standalone restore command (the in-shell one only runs on a failed up)
		expect(cmds().some((x) => restoreRe.test(x) && !/--force-recreate/.test(x))).toBe(false)
	})

	it('puts the previously running image back on the shared tag when the recreate fails', async () => {
		script(/--force-recreate/)
		await expect(atomicRollback(deploy, repo, facts)).rejects.toThrow()
		expect(cmds().some((x) => restoreRe.test(x))).toBe(true)
	})

	it('the lock path comes from the compose working dir, not the config file dir', async () => {
		script()
		await atomicRollback(deploy, repo, { configFile: '/srv/x/conf/compose.yml', service: 'app', workingDir: '/srv/x' })
		const locked = cmds().find((x) => /--force-recreate/.test(x)) ?? ''
		expect(locked).toContain('/srv/x/')
		expect(locked).not.toContain('/srv/x/conf/.powder')
	})

	it('puts it back when the health gate fails', async () => {
		script()
		runHealthGate.mockResolvedValue({ healthy: false, output: 'down' })
		await expect(atomicRollback(deploy, repo, facts)).rejects.toThrow(/UNHEALTHY/)
		expect(cmds().some((x) => restoreRe.test(x))).toBe(true)
	})

	it('image helpers respect registry ports', () => {
		expect(imageRepo('reg:5000/app:deploy-x')).toBe('reg:5000/app')
		expect(imageRepo('app:latest')).toBe('app')
		expect(pickComposeImage(['postgres:16', 'reg:5000/app:v2'], 'reg:5000/app:deploy-x')).toBe('reg:5000/app:v2')
		expect(pickComposeImage(['a:1', 'b:1'], 'c:deploy-x')).toBeNull()
	})
})

describe('atomicRollback runs the recreate guard first', () => {
	it('checks the compose on disk as the app before it touches the server', async () => {
		runCommand.mockReset()
		runHealthGate.mockResolvedValue({ healthy: true, output: 'ok' })
		script()
		recreateChecks.length = 0
		await atomicRollback(deploy, repo)
		expect(recreateChecks).toEqual([expect.objectContaining({ app: 'demoapp', what: 'rollback' })])
	})
})
