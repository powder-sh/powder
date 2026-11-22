// URL snapshots and the rollback bridge start a bare `docker run` container for
// Traefik to route: it joins the network the server's Traefik routes over
// (traefik-network.ts), and on a server whose Traefik runs on `web` the command is
// what it always was. Invented names; ssh and the db are mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	server: {} as Record<string, unknown>,
	probe: '',
	commands: [] as string[],
}))

vi.mock('../db', () => ({ db: { update: () => ({ set: () => ({ where: async () => {} }) }) }, deploys: {}, eq: () => null, lte: () => null }))
vi.mock('../servers', () => ({ getServer: async () => state.server, saveTraefikNetwork: async () => {} }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))
vi.mock('../deploys', () => ({ runHealthGate: async () => ({ healthy: true, output: 'ok' }) }))
vi.mock('../recreate-guard', () => ({ checkComposeForRecreate: async () => ({ hash: '', app: 'demo', log: '' }) }))
vi.mock('../ssh', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		state.commands.push(cmd)
		if (cmd.includes('===POWDER_DOCKER_NETWORKS===')) return { code: 0, stdout: state.probe, stderr: '' }
		if (/json \.Config\.Labels/.test(cmd)) return { code: 0, stdout: 'null\n', stderr: '' }
		if (/inspect -f/.test(cmd)) return { code: 0, stdout: 'sha256:prev\n', stderr: '' }
		if (/config --images/.test(cmd)) return { code: 0, stdout: 'demo:latest\n', stderr: '' }
		return { code: 0, stdout: '', stderr: '' }
	},
}))

import { atomicRollback, spawnSnapshot } from '../deploy-snapshots'

const deploy = { id: 'dep_abcdef123456', imageTag: 'demo:deploy-abc' } as never
const repo = { serverId: 'srv-1', containerName: 'demo' } as never
const base = { id: 'srv-1', host: 'h', user: 'root', port: 22, baseDomain: 'apps.example.com', tlsMode: 'acme' }
const runs = () => state.commands.filter((c) => /docker run -d --pull=never/.test(c))

beforeEach(() => {
	state.commands = []
	;(globalThis as { __powderTraefikNetworkCache?: Map<string, unknown> }).__powderTraefikNetworkCache?.clear()
})

describe('snapshot and rollback bridge network', () => {
	it('Traefik on web: --network web, as before', async () => {
		state.server = { ...base, proxy: 'traefik' }
		state.probe = `${JSON.stringify([{ Args: ['--providers.docker.network=web'], NetworkSettings: { Networks: { web: {} } } }])}\n===POWDER_DOCKER_NETWORKS===\nweb:false\n`
		await spawnSnapshot(deploy, repo)
		await atomicRollback(deploy, repo)
		expect(runs()).toHaveLength(2)
		for (const c of runs()) expect(c).toMatch(/ --restart no --network web --cap-drop /)
	})
	it('Traefik merely attached to another network: still web, nothing is routed over a guess', async () => {
		state.server = { ...base, proxy: 'traefik' }
		state.probe = `${JSON.stringify([{ NetworkSettings: { Networks: { infra: {} } } }])}\n===POWDER_DOCKER_NETWORKS===\ninfra:false:\n`
		await spawnSnapshot(deploy, repo)
		await atomicRollback(deploy, repo)
		for (const c of runs()) expect(c).toMatch(/ --restart no --network web --cap-drop /)
	})
	it('Traefik declared on another network: the snapshot and the bridge join that one, nothing joins web', async () => {
		state.server = { ...base, proxy: 'traefik' }
		state.probe = `${JSON.stringify([
			{
				Args: ['--providers.docker.network=infra'],
				NetworkSettings: { Networks: { infra: {}, backplane: {} } },
			},
		])}\n===POWDER_DOCKER_NETWORKS===\ninfra:false:\nbackplane:true:\n`
		await spawnSnapshot(deploy, repo)
		await atomicRollback(deploy, repo)
		expect(runs()).toHaveLength(2)
		for (const c of runs()) {
			expect(c).toMatch(/ --restart no --network infra --cap-drop /)
			expect(c).not.toMatch(/--network web/)
		}
		// read once for both (cached)
		expect(state.commands.filter((c) => c.includes('===POWDER_DOCKER_NETWORKS===')).length).toBe(1)
	})
})
