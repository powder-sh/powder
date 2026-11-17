// The in-script tripwire hashes the full config (inlined env values,
// image tags), so an env-only edit fires the re-check too. The re-check enforces the
// high-severity codes only when the STRUCTURAL hash moved (vs the last successful
// deploy's, else vs this deploy's first check); an env-only edit with an old finding
// stays warn.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
	probes: [] as string[],
	scriptRuns: [] as Array<{ code: number; stdout: string }>,
	scripts: [] as string[],
}
const runCommand = vi.fn(async (_s: unknown, cmd: string) => {
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

vi.mock('../builder', () => ({
	resolveComposeBuildFacts: async () => ({
		image: 'myapp:latest',
		context: '/opt/apps/myapp/src',
		dockerfile: 'Dockerfile',
		args: {},
		hasSecrets: false,
		hasAdditionalContexts: false,
	}),
	runBuilderPhase: async () => ({ stageImage: 'myapp:stage-b1', sha: null }),
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
// network "other" is an old finding (code network, high severity)
const cfg = (env: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		name: 'myapp',
		networks: { other: { external: true, name: 'otherapp_net' } },
		services: {
			myapp: {
				image: 'myapp:latest',
				container_name: 'myapp',
				environment: { A: env },
				networks: { other: null },
				...extra,
			},
		},
	})
const probe = (c: string, hash: string) => [hash.repeat(64), c, c, ''].join('\n__POWDER_CG_SEP__\n')
const WARN = { POWDER_COMPOSE_GUARD: 'warn' }
const S = (c: string) => structuralComposeHash(JSON.parse(c))

describe('re-check after the tripwire: structure decides', () => {
	beforeEach(() => {
		state.scripts = []
		state.probes = []
		state.scriptRuns = []
	})
	it('env-only edit with an old finding: warn (baseline stored)', async () => {
		const before = cfg('1')
		const after = cfg('2')
		expect(S(after)).toBe(S(before))
		state.probes = [probe(after, 'c')]
		const r = await checkComposeForDeploy(
			server,
			'',
			{ ...p, repoChanged: true, approvedHash: S(before), priorStructuralHash: S(before) },
			WARN,
		)
		expect(r.log).toContain('[compose-guard] WARN myapp network')
	})
	it('env-only edit, no baseline: the prior structural hash decides (warn)', async () => {
		const before = cfg('1')
		state.probes = [probe(before, 'a')]
		const first = await checkComposeForDeploy(server, '', { ...p, approvedHash: null }, WARN)
		expect(first.log).toContain('[compose-guard] WARN myapp network')
		state.probes = [probe(cfg('2'), 'c')]
		const again = await checkComposeForDeploy(
			server,
			'',
			{ ...p, repoChanged: true, approvedHash: null, priorStructuralHash: first.structuralHash },
			WARN,
		)
		expect(again.log).toContain('[compose-guard] WARN myapp network')
	})
	it('a structural change with a high finding: refuse', async () => {
		const before = cfg('1')
		const after = cfg('1', { network_mode: 'host' })
		state.probes = [probe(after, 'c')]
		await expect(
			checkComposeForDeploy(
				server,
				'',
				{ ...p, repoChanged: true, approvedHash: S(before), priorStructuralHash: S(before) },
				WARN,
			),
		).rejects.toThrow(/high-severity[\s\S]*network_mode/)
		// no baseline: vs the first check's structure
		state.probes = [probe(after, 'c')]
		await expect(
			checkComposeForDeploy(
				server,
				'',
				{ ...p, repoChanged: true, approvedHash: null, priorStructuralHash: S(before) },
				WARN,
			),
		).rejects.toThrow(/high-severity/)
	})
	it('rebuildDeploy: an env-only change during the sync runs again (warn), no baseline', async () => {
		process.env.POWDER_COMPOSE_GUARD = 'warn'
		try {
			state.probes = [probe(cfg('1'), 'a'), probe(cfg('2'), 'c')]
			state.scriptRuns = [
				{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' },
				{ code: 0, stdout: '' },
			]
			const r = await rebuildDeploy(
				server as never,
				'/opt/apps/myapp',
				'/opt/apps/myapp/docker-compose.yml',
				'myapp',
				'dep_1',
				undefined,
				{ deadlineAt: Date.now() + 3_600_000 },
			)
			expect(state.scripts).toHaveLength(2)
			expect(r.output).toContain('[compose-guard] WARN myapp network')
		} finally {
			Reflect.deleteProperty(process.env, 'POWDER_COMPOSE_GUARD')
		}
	})
	it('rebuildDeploy: a structural change during the sync is refused', async () => {
		process.env.POWDER_COMPOSE_GUARD = 'warn'
		try {
			state.probes = [probe(cfg('1'), 'a'), probe(cfg('1', { network_mode: 'host' }), 'c')]
			state.scriptRuns = [{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' }]
			await expect(
				rebuildDeploy(
					server as never,
					'/opt/apps/myapp',
					'/opt/apps/myapp/docker-compose.yml',
					'myapp',
					'dep_1',
					undefined,
					{ deadlineAt: Date.now() + 3_600_000 },
				),
			).rejects.toThrow(/high-severity/)
			expect(state.scripts).toHaveLength(1)
		} finally {
			Reflect.deleteProperty(process.env, 'POWDER_COMPOSE_GUARD')
		}
	})
})
