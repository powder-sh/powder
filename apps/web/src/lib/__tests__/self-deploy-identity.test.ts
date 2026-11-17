// self-deploy (runSelfDeploy: no compose guard, link guards, Dockerfile rewrite,
// image label guard, NET_RAW override) is not chosen by the compose SERVICE label alone
// (any app with a service named like POWDER_SELF_SERVICE would deploy unguarded). It is
// decided by identity, the overlay files must be regular files in powder's own dir, and
// an app may not use powder's service or container name as a key or container_name.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn(async () => ({ code: 0, stdout: 'legacy\n', stderr: '' }))
const uploads: string[] = []
vi.mock('../ssh/connection', () => ({ runCommand: (...a: unknown[]) => (runCommand as (...x: unknown[]) => unknown)(...a) }))
vi.mock('../ssh/files', () => ({
	writeFileViaSftp: async (_s: unknown, _p: string, body: string) => void uploads.push(body),
}))

const { runSelfDeploy, selfDeployDecision } = await import('../deploy/self-deploy')
const { composeViolations, isHighSeverity } = await import('../compose-safety')

const ENV = { POWDER_SELF_SERVICE: 'powder', POWDER_SELF_SERVER_ID: 'boxp', POWDER_SRC: '/opt/apps/powder/src' }
const powder = {
	serverId: 'boxp',
	service: 'powder',
	containerName: 'powder',
	composeProject: 'powder',
	workingDir: '/opt/apps/powder/src',
	configFile: '/opt/apps/powder/src/docker-compose.yml',
}

describe('selfDeployDecision: identity, not the service label', () => {
	it('powder itself still self-deploys', () => {
		expect(selfDeployDecision(powder, ENV)).toBe('self')
		expect(selfDeployDecision(powder, { POWDER_SELF_SERVICE: 'powder', POWDER_SELF_SERVER_ID: 'boxp' })).toBe('self')
	})
	it('an app with a service named powder takes the normal guarded path', () => {
		expect(selfDeployDecision({ ...powder, containerName: 'shopx', composeProject: 'shopx', workingDir: '/opt/apps/shopx', configFile: '/opt/apps/shopx/docker-compose.yml' }, ENV)).toBe('normal')
		// on another server too, and with POWDER_SELF_SERVER_ID unset
		expect(selfDeployDecision({ ...powder, containerName: 'shopx' }, { POWDER_SELF_SERVICE: 'powder' })).toBe('normal')
	})
	it('no POWDER_SELF_SERVICE: never self', () => {
		expect(selfDeployDecision(powder, { POWDER_SELF_SERVER_ID: 'boxp' })).toBe('normal')
	})
	it('POWDER_SELF_SERVER_ID unset: the self container is refused, not matched on any server', () => {
		const r = selfDeployDecision(powder, { POWDER_SELF_SERVICE: 'powder' })
		expect(typeof r === 'object' && r.refuse).toMatch(/POWDER_SELF_SERVER_ID is not/)
	})
	it('a container named powder on another server is not self', () => {
		expect(selfDeployDecision({ ...powder, serverId: 'boxa' }, ENV)).toBe('normal')
	})
	it('the self container with another project, service or dir is refused', () => {
		for (const t of [
			{ ...powder, composeProject: 'shopx' },
			{ ...powder, composeProject: null },
			{ ...powder, service: 'web' },
			{ ...powder, workingDir: '/opt/apps/shopx' },
			{ ...powder, configFile: '/opt/apps/shopx/docker-compose.yml' },
			{ ...powder, workingDir: '/opt/apps/powder/../shopx' },
		])
			expect(typeof selfDeployDecision(t, ENV)).toBe('object')
	})
	it('POWDER_SELF_CONTAINER renames the self container', () => {
		const env = { ...ENV, POWDER_SELF_CONTAINER: 'ctl' }
		expect(selfDeployDecision(powder, env)).toBe('normal')
		expect(selfDeployDecision({ ...powder, containerName: 'ctl', composeProject: 'ctl' }, env)).toBe('self')
	})
	it('rebuildDeploy decides by selfIdentity, never by the service alone', () => {
		const src = readFileSync(join(__dirname, '..', 'deploy', 'run.ts'), 'utf8')
		expect(src).not.toMatch(/selfService === service/)
		expect(src).toMatch(/opts\?\.selfIdentity\s*\?\s*selfDeployDecision\(/)
		const runner = readFileSync(join(__dirname, '..', 'deploy-runner.ts'), 'utf8')
		expect(runner).toMatch(/selfIdentity: \{ containerName, composeProject: f\.project \}/)
	})
})

describe('self-deploy overlays: regular files in powder\'s own dir only', () => {
	it('the prep script refuses a missing or linked overlay before anything runs', async () => {
		uploads.length = 0
		await runSelfDeploy({ id: 'boxp', host: 'h' } as never, '/opt/apps/powder/src', '/opt/apps/powder/src/docker-compose.yml', 'powder', 'deploy-x', undefined, { deployId: 'dep_x' })
		const script = uploads[0] ?? ''
		const m = script.match(/if \[ ! -f '[^']*shared-db\.yml' \][^;]*; then echo '[^']*'; exit 1; fi; /)
		expect(m).not.toBeNull()
		expect(script.indexOf((m?.[0] ?? ''))).toBeLessThan(script.indexOf('docker compose'))
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'self-')))
		try {
			const check = (m?.[0] ?? '').split('/opt/apps/powder/src').join(root)
			const run = () => spawnSync('bash', ['-c', `${check}echo PASSED`], { encoding: 'utf8' }).stdout
			expect(run()).toContain('self-deploy: refusing')
			symlinkSync('/etc/hostname', join(root, 'docker-compose.shared-db.yml'))
			expect(run()).toContain('self-deploy: refusing')
			rmSync(join(root, 'docker-compose.shared-db.yml'))
			writeFileSync(join(root, 'docker-compose.shared-db.yml'), 'services: {}\n')
			expect(run()).toContain('PASSED')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe('an app may not use powder\'s own service or container name', () => {
	const ctx = { appName: 'shopx', selfNames: { service: 'powder', container: 'powder' } }
	it('a service key powder on its own network is a high finding', () => {
		const v = composeViolations({ name: 'shopx', services: { powder: { image: 'shopx:latest', networks: { default: null } } } }, ctx)
		expect(v.map((x) => x.code)).toContain('service_key')
		expect(v.every(isHighSeverity)).toBe(true)
	})
	it('a renamed self service counts too, as a key and as a container_name', () => {
		const c = { appName: 'shopx', selfNames: { service: 'ctl', container: 'powder' } }
		expect(composeViolations({ name: 'shopx', services: { CTL: { image: 'shopx:latest' } } }, c).map((x) => x.code)).toContain('service_key')
		expect(composeViolations({ name: 'shopx', services: { shopx: { image: 'shopx:latest', container_name: 'ctl' } } }, c).map((x) => x.code)).toContain('container_name')
	})
	it('a plain app has no finding', () => {
		expect(composeViolations({ name: 'shopx', services: { shopx: { image: 'shopx:latest' } } }, ctx)).toEqual([])
	})
})
