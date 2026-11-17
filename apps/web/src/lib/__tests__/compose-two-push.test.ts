// the two-push bypass. A push whose compose change is refused by the
// re-check leaves its tree on disk; the NEXT push would probe that tree, see no
// hash movement during its own git sync and only warn. So the guard compares the
// probed config's STRUCTURAL hash with the one the last successful deploy stored
// (deploys.compose_config_hash, 0056): a different hash enforces the high-severity
// rules in warn mode. No stored hash: warn only, the success stores the baseline.
// Env values and image tags are not part of the structural hash.
// A refusal also resets src/ to the last good commit, and the run after a re-check
// refuses when the hash moves again.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
	probes: [] as string[],
	scriptRuns: [] as Array<{ code: number; stdout: string }>,
	scripts: [] as string[],
	cmds: [] as string[],
}
const runCommand = vi.fn(async (_s: unknown, cmd: string) => {
	state.cmds.push(cmd)
	if (/__POWDER_CG_SEP_[0-9a-f]+__/.test(cmd))
		return { stdout: (state.probes.shift() ?? '').split('__POWDER_CG_SEP__').join(cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0] ?? ''), stderr: '', code: 0 }
	if (cmd.startsWith('timeout -k')) {
		// the script prints the marker tagged with its nonce; take it from the script
		const run = state.scriptRuns.shift() ?? { code: 0, stdout: '' }
		const m = state.scripts[state.scripts.length - 1]?.match(
			/__POWDER_COMPOSE_CHANGED_[A-Za-z0-9]+__/,
		)?.[0]
		const raw = (run as { raw?: boolean }).raw === true
		return {
			...run,
			stdout: m && !raw ? run.stdout.split('__POWDER_COMPOSE_CHANGED__').join(m) : run.stdout,
			stderr: '',
		}
	}
	if (cmd.includes('__POWDER_RESET_OK__'))
		return { stdout: '__POWDER_RESET_OK__\n', stderr: '', code: 0 }
	return { stdout: '', stderr: '', code: 0 }
})
vi.mock('../ssh/connection', () => ({
	runCommand: (...a: unknown[]) => runCommand(...(a as [unknown, string])),
}))
vi.mock('../ssh/files', () => ({
	writeFileViaSftp: async (_s: unknown, _p: string, script: string) => {
		state.scripts.push(script)
	},
}))

import { checkComposeForDeploy, structuralComposeHash } from '../deploy/compose-check'
import { rebuildDeploy } from '../deploy/run'

const server = { id: 's1', name: 's1', host: 'h', user: 'root', port: 22, kind: 'compose' as const }
const p = {
	appName: 'myapp',
	workingDir: '/opt/apps/myapp',
	composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
	routeHosts: null,
}
const cfg = (svc: Record<string, unknown>) =>
	JSON.stringify({
		name: 'myapp',
		services: { myapp: { image: 'myapp:latest', container_name: 'myapp', ...svc } },
	})
const probe = (svc: Record<string, unknown>, hash = 'a') =>
	[hash.repeat(64), cfg(svc), cfg(svc), ''].join('\n__POWDER_CG_SEP__\n')
const structural = (svc: Record<string, unknown>) => structuralComposeHash(JSON.parse(cfg(svc)))
const BASE_CFG = structural({})
const WARN = { POWDER_COMPOSE_GUARD: 'warn' }
const BASE = '1'.repeat(40)

describe('warn mode compares the probed config with the last successful deploy', () => {
	it('no stored hash (first guarded deploy): warn only, nothing refused', async () => {
		state.probes = [probe({ network_mode: 'host' }, 'c')]
		const r = await checkComposeForDeploy(server, '', { ...p, approvedHash: null }, WARN)
		expect(r.log).toContain('[compose-guard] WARN myapp network_mode')
		expect(r.structuralHash).toBe(structural({ network_mode: 'host' }))
	})
	it('enforce mode stays fail-closed without a stored hash', async () => {
		state.probes = [probe({ network_mode: 'host' }, 'c')]
		await expect(
			checkComposeForDeploy(server, '', { ...p, approvedHash: null }, {}),
		).rejects.toThrow(/network_mode/)
	})
	it('a hostile tree left by a refused push (structure != last success): refused', async () => {
		state.probes = [probe({ privileged: true }, 'c')]
		await expect(
			checkComposeForDeploy(server, '', { ...p, approvedHash: BASE_CFG }, WARN),
		).rejects.toThrow(/differs from the last successful deploy[\s\S]*privileged/)
	})
	it('the same structure as the last success keeps plain warn', async () => {
		state.probes = [probe({ network_mode: 'host' }, 'a')]
		const r = await checkComposeForDeploy(
			server,
			'',
			{ ...p, approvedHash: structural({ network_mode: 'host' }) },
			WARN,
		)
		expect(r.log).toContain('[compose-guard] WARN myapp network_mode')
	})
	it('an env value change (env_file contents, inline values) or a new image tag is not a compose change', async () => {
		const shape = { network_mode: 'host', env_file: ['/opt/apps/shared/myapp.env'] }
		const approvedHash = structural({ ...shape, environment: { A: '1' } })
		for (const changed of [
			{ ...shape, environment: { A: '2', NEW_KEY: 'x' } },
			{ ...shape, environment: { A: '1' }, image: 'myapp:deploy-42' },
			{ ...shape, environment: { A: '1' }, image: `myapp@sha256:${'e'.repeat(64)}` },
		]) {
			state.probes = [probe(changed, 'f')]
			const r = await checkComposeForDeploy(server, '', { ...p, approvedHash }, WARN)
			expect(r.log, JSON.stringify(changed)).toContain('[compose-guard] WARN myapp network_mode')
			expect(r.structuralHash).toBe(approvedHash)
		}
	})
	it('a structural change (a new bind, another env_file path) triggers the check', async () => {
		const shape = { network_mode: 'host', env_file: ['/opt/apps/shared/myapp.env'] }
		const approvedHash = structural(shape)
		for (const changed of [
			{ ...shape, env_file: ['/opt/apps/other.env'] },
			{ ...shape, volumes: [{ type: 'bind', source: '/opt/apps/myapp/data', target: '/data' }] },
		]) {
			state.probes = [probe(changed, 'f')]
			await expect(
				checkComposeForDeploy(server, '', { ...p, approvedHash }, WARN),
				JSON.stringify(changed),
			).rejects.toThrow(/high-severity/)
		}
	})
})

describe('rebuildDeploy, two pushes', () => {
	beforeEach(() => {
		state.scripts = []
		state.cmds = []
		process.env.POWDER_COMPOSE_GUARD = 'warn'
	})
	const run = (approvedComposeHash: string | null) =>
		rebuildDeploy(
			server as never,
			'/opt/apps/myapp',
			'/opt/apps/myapp/docker-compose.yml',
			'myapp',
			'dep_2',
			undefined,
			{
				deadlineAt: Date.now() + 3_600_000,
				baseSha: BASE,
				approvedComposeHash,
			},
		)

	it('push 2 on the tree push 1 left (no hash movement in its own sync) is refused and src/ is reset', async () => {
		// The probe already sees the hostile config; the git sync of push 2 does not move it.
		state.probes = [probe({ network_mode: 'host' }, 'c')]
		state.scriptRuns = [{ code: 0, stdout: '' }]
		await expect(run('a'.repeat(64))).rejects.toThrow(
			/high-severity[\s\S]*network_mode[\s\S]*reset to the last successful commit/,
		)
		expect(state.scripts).toHaveLength(0)
		expect(state.cmds.some((c) => c.includes(`reset -q --hard '${BASE}'`))).toBe(true)
	})
	it('a successful deploy returns the structural hash (stored as compose_config_hash)', async () => {
		state.probes = [probe({}, 'a')]
		state.scriptRuns = [{ code: 0, stdout: '' }]
		const r = await run(BASE_CFG)
		expect(r.composeHash).toBe(BASE_CFG)
		expect(r.composeHash).not.toBe('a'.repeat(64))
	})
	it('warn + no stored hash: the deploy goes through and returns the baseline to store', async () => {
		state.probes = [probe({ network_mode: 'host' }, 'a')]
		state.scriptRuns = [{ code: 0, stdout: '' }]
		const r = await run(null)
		expect(r.composeHash).toBe(structural({ network_mode: 'host' }))
		expect(r.output).toContain('[compose-guard] WARN myapp network_mode')
	})
	it('the run after a re-check refuses when the hash moves again, and resets src/', async () => {
		state.probes = [probe({}, 'a'), probe({}, 'c')]
		state.scriptRuns = [
			{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' },
			{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' },
		]
		await expect(run(BASE_CFG)).rejects.toThrow(/reset to the last successful commit/)
		expect(state.scripts).toHaveLength(2)
		expect(state.scripts[1]).toContain('deploy: refusing, the resolved compose config changed')
	})
})
