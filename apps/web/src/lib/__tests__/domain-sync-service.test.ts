import { appLockPath } from '../deploy-supersede'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn()
vi.mock('../db', () => ({
	and: () => null,
	eq: () => null,
	desc: () => null,
	sql: () => null,
	appDomains: {},
	appRepos: {},
	deploys: {},
	prefixes: {},
	createId: () => 'x',
	db: {
		select: () => ({
			from: () => ({
				where: () => Object.assign(Promise.resolve([]), { orderBy: () => ({ limit: async () => [] }) }),
			}),
		}),
	},
}))
vi.mock('../ssh', () => ({ runCommand: (...a: unknown[]) => runCommand(...a), inspectContainer: vi.fn() }))
vi.mock('../ssh/connection', () => ({ runCommand: (...a: unknown[]) => runCommand(...a) }))
vi.mock('../compose-override-io', () => ({ applyComposeOverride: async () => ({ changed: true, log: '' }), UnsafeOverrideError: class extends Error {} }))
vi.mock('../servers', () => ({ getServer: async () => ({ id: 's1', host: 'h', user: 'root', baseDomain: 'apps.example.com', tlsMode: 'acme' }) }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))
// the recreate guard runs the deploy's compose check (own test: recreate-guard)
const recreateChecks: Array<{ p: unknown; cmdsBefore: number }> = []
const guard = { refuse: false }
vi.mock('../recreate-guard', () => ({
	checkComposeForRecreate: async (_s: unknown, p: unknown) => {
		recreateChecks.push({ p, cmdsBefore: runCommand.mock.calls.length })
		if (guard.refuse) throw new Error('domain apply refused: [privileged]')
		return { hash: 'f'.repeat(64), app: 'demoapp', log: '' }
	},
}))
vi.mock('../powder-config', () => ({
	readPowderConfig: async () => null,
	buildTraefikLabels: () => ({ middlewareLabels: [], middlewareChain: [] }),
}))

import { applyDomainsToCompose } from '../app-domains'

beforeEach(() => {
	recreateChecks.length = 0
	guard.refuse = false
	runCommand.mockReset()
	runCommand.mockImplementation(async (_s: unknown, cmd: string) => {
		if (/config --format json/.test(cmd)) return { code: 0, stdout: '{"services":{"app":{}}}', stderr: '' }
		if (/^cat /.test(cmd)) return { code: 0, stdout: 'services:\n  app:\n    image: demoapp:latest\n', stderr: '' }
		if (/echo ok/.test(cmd)) return { code: 0, stdout: 'ok', stderr: '' }
		if (/grep -oE/.test(cmd)) return { code: 0, stdout: '3000', stderr: '' }
		return { code: 0, stdout: '', stderr: '' }
	})
})

describe('domain sync for a service named app with a different container name', () => {
	it('recreates service `app` under the app-named lock, not the container name', async () => {
		const repo = { id: 'r1', serverId: 's1', containerName: 'demoapp', healthUrl: null } as never
		await applyDomainsToCompose(repo, {
			workingDir: '/opt/apps/demoapp',
			service: 'app',
			configFile: '/opt/apps/demoapp/docker-compose.yml',
		})
		const up = runCommand.mock.calls.map((c) => String(c[1])).find((c) => c.includes('force-recreate')) ?? ''
		expect(up).toContain(appLockPath('/opt/apps/demoapp', 'app'))
		expect(up).not.toContain(appLockPath('/opt/apps/demoapp', 'demoapp'))
		expect(up).toMatch(/up -d --no-build --force-recreate --no-deps '\\''app'\\''/)
	})
})

// the domain apply must take its approval from checkComposeForRecreate
// (a literal approval would recreate unchecked), and a refusal must stop the up.
describe('domain apply runs the recreate guard', () => {
	const repo = { id: 'r1', serverId: 's1', containerName: 'demoapp', healthUrl: null } as never
	const facts = { workingDir: '/opt/apps/demoapp', service: 'app', configFile: '/opt/apps/demoapp/docker-compose.yml' }
	it('checks as the app before the up and pins the hash the check returned', async () => {
		await applyDomainsToCompose(repo, facts)
		expect(recreateChecks).toHaveLength(1)
		expect(recreateChecks[0]?.p).toEqual(expect.objectContaining({ app: 'demoapp', what: 'domain apply' }))
		const cmds = runCommand.mock.calls.map((c) => String(c[1]))
		const upAt = cmds.findIndex((c) => c.includes('force-recreate'))
		expect(upAt).toBeGreaterThanOrEqual(recreateChecks[0]?.cmdsBefore ?? Number.POSITIVE_INFINITY)
		expect(cmds[upAt]).toContain('f'.repeat(64))
	})
	it('a refusal stops the up', async () => {
		guard.refuse = true
		await expect(applyDomainsToCompose(repo, facts)).rejects.toThrow(/refused/)
		expect(runCommand.mock.calls.map((c) => String(c[1])).some((c) => c.includes('force-recreate'))).toBe(false)
	})
})
