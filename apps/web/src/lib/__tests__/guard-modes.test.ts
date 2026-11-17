// The compose guard ENFORCES by default (public default); it only warns
// with POWDER_COMPOSE_GUARD=warn, where a failed probe never blocks a deploy.
import { describe, expect, it, vi } from 'vitest'

const state: { stdout: string; throws: boolean } = { stdout: '', throws: false }
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		if (state.throws) throw new Error('SSH timeout')
		return { stdout: state.stdout.split('__POWDER_CG_SEP__').join(cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0] ?? '__POWDER_CG_SEP__'), stderr: '', code: 0 }
	},
}))
import {
	ComposeGuardError,
	checkComposeForDeploy,
	composeGuardEnforced,
	deployGuardContext,
	parseComposeProbe,
} from '../deploy/compose-check'
import { composeHashGuardShell } from '../deploy/compose-hash'

const server = { id: 's1', name: 's1', host: 'h', user: 'root', port: 22, kind: 'compose' as const }
const p = {
	appName: 'myapp',
	workingDir: '/opt/apps/myapp',
	composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
	routeHosts: null,
	// no stored baseline: warn mode only warns
	approvedHash: null,
}
const cfg = (svc: Record<string, unknown>) =>
	JSON.stringify({
		name: 'myapp',
		services: { myapp: { image: 'myapp:latest', container_name: 'myapp', ...svc } },
	})
const probe = (svc: Record<string, unknown>, ps = '') =>
	['a'.repeat(64), cfg(svc), cfg({}), ps].join('\n__POWDER_CG_SEP__\n')

describe('compose guard modes', () => {
	it('default (unset) and unknown values enforce', async () => {
		state.throws = false
		for (const env of [{}, { POWDER_COMPOSE_GUARD: '' }, { POWDER_COMPOSE_GUARD: 'off' }]) {
			state.stdout = probe({ privileged: true })
			await expect(checkComposeForDeploy(server, '', p, env)).rejects.toBeInstanceOf(
				ComposeGuardError,
			)
		}
		expect(composeGuardEnforced({})).toBe(true)
		expect(composeGuardEnforced({ POWDER_COMPOSE_GUARD: ' Warn ' })).toBe(false)
	})
	it('warn: violations become one greppable line each, the deploy continues', async () => {
		state.throws = false
		state.stdout = probe({ network_mode: 'host', cap_add: ['NET_ADMIN'] })
		const r = await checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'warn' })
		expect(r.enforce).toBe(false)
		expect(r.hash).toBe('a'.repeat(64))
		const lines = r.log.split('\n').filter((l) => l.startsWith('[compose-guard] WARN'))
		expect(lines).toHaveLength(2)
		expect(lines[0]).toMatch(/^\[compose-guard\] WARN myapp network_mode service myapp: /)
		expect(lines[1]).toMatch(/^\[compose-guard\] WARN myapp cap_add /)
	})
	it('POWDER_COMPOSE_GUARD=warn does not refuse an unchanged config', async () => {
		state.stdout = probe({ privileged: true })
		await expect(
			checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'warn' }),
		).resolves.toMatchObject({ enforce: false })
	})
	it('enforce refuses', async () => {
		state.stdout = probe({ privileged: true })
		await expect(
			checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'enforce' }),
		).rejects.toBeInstanceOf(ComposeGuardError)
	})
	it('a failed probe continues in warn mode (no hash pinned) and refuses in enforce mode', async () => {
		state.stdout = 'garbage'
		const r = await checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'warn' })
		expect(r.hash).toBe('')
		expect(r.log).toContain('[compose-guard] WARN myapp probe ')
		state.throws = true
		const r2 = await checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'warn' })
		expect(r2.log).toContain('SSH timeout')
		await expect(checkComposeForDeploy(server, '', p, {})).rejects.toBeInstanceOf(ComposeGuardError)
		state.throws = false
	})
	it('the hash tripwire only warns in warn mode', () => {
		expect(composeHashGuardShell('', 'b'.repeat(64), 'x', false, 'myapp')).not.toContain('exit 1')
		expect(composeHashGuardShell('', 'b'.repeat(64), 'x', false, 'myapp')).toContain(
			'[compose-guard] WARN myapp config_changed',
		)
		expect(composeHashGuardShell('', 'b'.repeat(64), 'x', true)).toContain('exit 1')
	})
	it('exited or unlabelled containers running an image do not make it "another app\'s image"', () => {
		const ps = [
			'old\tmyapp:latest\tother\texited',
			'stray\tmyapp:latest\t\trunning',
			'live\tvictim:latest\tvictim\trunning',
		].join('\n')
		const input = parseComposeProbe(probe({}, ps))
		if (!input) throw new Error('probe did not parse')
		const c = deployGuardContext(input, { ...p, serverId: 's1' })
		expect(c.foreignImages).toEqual(['victim:latest'])
	})
})
