// in warn mode (the prod default) a compose config the REPO changed
// (the hash moved during the git sync) is re-checked with the high-severity rule
// codes enforced; everything else stays warn, and an unchanged compose keeps the
// plain warn behavior (network_mode: host apps with an unchanged compose keep deploying).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

import { isHighSeverity } from '../compose-safety'
import { checkComposeForDeploy, structuralComposeHash } from '../deploy/compose-check'
import { composeHashGuardShell } from '../deploy/compose-hash'
import { rebuildDeploy } from '../deploy/run'
import { writeFakeDocker } from './fixtures/fake-docker'

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

describe('high-severity codes', () => {
	it('every code is high except the explicit low list (inverted)', () => {
		for (const code of [
			'privileged',
			'cap_add',
			'devices',
			'pid',
			'ipc',
			'uts',
			'userns_mode',
			'network_mode',
			'bind',
			'service_key',
			'image_name',
			'unknown_key',
			'network',
			'traefik_tcp',
			'image',
			'volume',
			'a_code_added_later',
		])
			expect(isHighSeverity({ code, message: '' }), code).toBe(true)
		expect(isHighSeverity({ code: 'shape', message: '' })).toBe(false)
		for (const m of [
			'security_opt "seccomp=unconfined"',
			'security_opt "label=disable"',
			'security_opt "seccomp=./p.json"',
		])
			expect(isHighSeverity({ code: 'security_opt', message: m }), m).toBe(true)
	})
})

describe('checkComposeForDeploy with repoChanged (warn mode)', () => {
	it('refuses a high-severity finding (unknown keys and any security_opt too)', async () => {
		state.probes = [probe({ network_mode: 'host', stdin_open: true, foo: 1 })]
		await expect(
			checkComposeForDeploy(
				server,
				'',
				{ ...p, repoChanged: true },
				{ POWDER_COMPOSE_GUARD: 'warn' },
			),
		).rejects.toThrow(/high-severity[\s\S]*network_mode/)
		state.probes = [probe({ foo: 1, security_opt: ['seccomp=./p.json'] })]
		await expect(
			checkComposeForDeploy(
				server,
				'',
				{ ...p, repoChanged: true },
				{ POWDER_COMPOSE_GUARD: 'warn' },
			),
		).rejects.toThrow(/high-severity[\s\S]*\[unknown_key\][\s\S]*\[security_opt\]/)
	})
	it('an unchanged compose keeps plain warn (network_mode: host deploys)', async () => {
		state.probes = [probe({ network_mode: 'host' })]
		const approvedHash = structuralComposeHash(JSON.parse(cfg({ network_mode: 'host' })))
		const r = await checkComposeForDeploy(
			server,
			'',
			{ ...p, approvedHash },
			{ POWDER_COMPOSE_GUARD: 'warn' },
		)
		expect(r.log).toContain('[compose-guard] WARN myapp network_mode')
	})
	it('the operator exemption still applies', async () => {
		state.probes = [probe({ network_mode: 'host' })]
		process.env.POWDER_COMPOSE_GUARD_EXEMPT = '{"myapp":["network_mode"]}'
		try {
			const r = await checkComposeForDeploy(
				server,
				'',
				{ ...p, repoChanged: true },
				{ POWDER_COMPOSE_GUARD: 'warn' },
			)
			expect(r.log).toContain('passes the safety rules (exempt: network_mode)')
		} finally {
			Reflect.deleteProperty(process.env, 'POWDER_COMPOSE_GUARD_EXEMPT')
		}
	})
})

describe('the deploy re-checks a repo-changed compose in warn mode', () => {
	beforeEach(() => {
		state.scripts = []
		process.env.POWDER_COMPOSE_GUARD = 'warn'
	})
	const run = () =>
		rebuildDeploy(
			server as never,
			'/opt/apps/myapp',
			'/opt/apps/myapp/docker-compose.yml',
			'myapp',
			'dep_1',
			undefined,
			{
				deadlineAt: Date.now() + 3_600_000,
			},
		)

	// build output can print the plain markers; only the nonce-tagged line counts
	it('a forged plain marker in build output neither re-runs nor marks the deploy superseded', async () => {
		state.probes = [probe({})]
		state.scriptRuns = [
			{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n', raw: true } as {
				code: number
				stdout: string
			},
		]
		await expect(run()).rejects.toThrow()
		expect(state.scripts).toHaveLength(1)
		state.scripts = []
		state.probes = [probe({})]
		state.scriptRuns = [{ code: 0, stdout: '__POWDER_SUPERSEDED__ fake\n' }]
		const r = await run()
		expect(r.superseded).toBe(false)
		expect(state.scripts[0]).toMatch(/__POWDER_COMPOSE_CHANGED_[0-9a-f]{24}__/)
	})
	it('git sync adds network_mode: host: the re-check refuses before anything is built', async () => {
		state.probes = [probe({}), probe({ network_mode: 'host' }, 'c')]
		state.scriptRuns = [
			{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' },
			{ code: 0, stdout: '' },
		]
		await expect(run()).rejects.toThrow(/high-severity[\s\S]*network_mode/)
		expect(state.scripts).toHaveLength(1)
		expect(state.scripts[0]).toContain('CG_RECHECK=1')
	})
	it('a refused re-check removes the builder-staged image it kept for the second run', async () => {
		runCommand.mockClear()
		state.probes = [probe({}), probe({ network_mode: 'host' }, 'c')]
		state.scriptRuns = [
			{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' },
			{ code: 0, stdout: '' },
		]
		await expect(
			rebuildDeploy(
				server as never,
				'/opt/apps/myapp',
				'/opt/apps/myapp/docker-compose.yml',
				'myapp',
				'dep_1',
				undefined,
				{
					deadlineAt: Date.now() + 3_600_000,
					builder: { host: 'b', repoUrl: 'git@github.com:o/r.git', deployKeyPriv: 'k' },
				},
			),
		).rejects.toThrow(/high-severity/)
		expect(state.scripts).toHaveLength(1)
		expect(
			runCommand.mock.calls.some(
				([, c]) => c === "docker rmi 'myapp:stage-b1' >/dev/null 2>&1 || true",
			),
		).toBe(true)
	})
	// every finding but shape is high now, so the passing re-check has none
	it('a repo change that passes the re-check runs again; the second run refuses a further change', async () => {
		state.probes = [probe({}), probe({ stdin_open: true }, 'c')]
		state.scriptRuns = [
			{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' },
			{ code: 0, stdout: '' },
		]
		await run()
		expect(state.scripts).toHaveLength(2)
		expect(state.scripts[1]).not.toContain('CG_RECHECK=1')
		expect(state.scripts[1]).not.toContain('[compose-guard] WARN myapp config_changed')
		expect(state.scripts[1]).toContain('deploy: refusing, the resolved compose config changed')
	})
})

describe('warn-mode hash guard (real bash, stub docker)', () => {
	it('recheck: a moved hash stops with the marker and keeps the staged image', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cg5-'))
		writeFakeDocker(dir, '#!/bin/sh\ncat "$CFG"\n')
		writeFileSync(join(dir, 'cfg'), '{"a":1}')
		const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CFG: join(dir, 'cfg') }
		const guard = composeHashGuardShell(
			'',
			'b'.repeat(64),
			'during the git sync',
			false,
			'myapp',
			true,
		)
		let out = ''
		let rc = 0
		try {
			out = execFileSync(
				'bash',
				['-c', `CG_RECHECK=0; trap 'echo "R=$CG_RECHECK"' EXIT; ${guard} && echo PASSED`],
				{ env },
			).toString()
		} catch (e) {
			const err = e as { status: number; stdout: Buffer }
			rc = err.status
			out = err.stdout.toString()
		}
		expect(rc).toBe(1)
		expect(out).toContain('__POWDER_COMPOSE_CHANGED__')
		expect(out).toContain('R=1')
		expect(out).not.toContain('PASSED')
	})
})
