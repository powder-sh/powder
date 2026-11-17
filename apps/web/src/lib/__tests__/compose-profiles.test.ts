// a service behind an inactive compose profile was left out of the resolved
// `docker compose config` (the input of every rule) while `up --no-deps <service>` (the
// deploy TARGETS, rollbacks, domain and container apply) starts it by name. Now:
//  (a) every compose config powder reads runs with `--profile '*'`;
//  (b) `profiles` is a refused service key (high, never exemptable);
//  (c) a service the uninterpolated view has and the resolved one lacks is refused;
//  (d) the on-server guard refuses when `config --services` depends on the profiles.

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'

const state = { stdout: '', cmds: [] as string[] }
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		state.cmds.push(cmd)
		const sep = cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0] ?? '__POWDER_CG_SEP__'
		return { stdout: state.stdout.split('__POWDER_CG_SEP__').join(sep), stderr: '', code: 0 }
	},
}))

const { composeViolations, isHighSeverity } = await import('../compose-safety')
const { checkComposeForDeploy, deployGuardContext, mergeFilePaths, unresolvedServicesOf } = await import('../deploy/compose-check')
const { ALL_PROFILES, composeConfigHashShell } = await import('../deploy/compose-hash')
const { composeFileArgs, composeProfileGuardShell, composeUpCommand, onServerComposeGuardShell } = await import('../deploy/fragments')
const { buildDeployScript } = await import('../deploy/script')

const server = { id: 'boxa', host: 'h', user: 'root' } as never
const evil = { image: 'alpine', privileged: true, volumes: [{ type: 'bind', source: '/', target: '/host' }] }
const plain = { name: 'acme', services: { acme: { image: 'acme:latest' } } }
const raw = { name: 'acme', services: { acme: { image: 'acme:latest' }, acme_x: { ...evil, profiles: ['x'] } } }
const ctxP = { appName: 'acme', workingDir: '/opt/apps/acme', composeFiles: ['/opt/apps/acme/docker-compose.yml'], serverId: 'boxa', routeHosts: null }
const input = (resolved: unknown, rawCfg: unknown) => ({ resolved, raw: rawCfg, hash: 'a'.repeat(64), containers: [] })

describe('(b) profiles is a refused key', () => {
	it('a profiled service is a high finding no exemption opens', () => {
		const cfg = { name: 'acme', services: { acme: { image: 'acme:latest', profiles: ['x'] } } }
		const v = composeViolations(cfg, { appName: 'acme', exempt: ['profiles'] })
		expect(v.map((x) => x.code)).toEqual(['profiles'])
		expect(v[0] && isHighSeverity(v[0])).toBe(true)
	})
	it('a plain compose has no profiles finding', () => {
		expect(composeViolations(plain, { appName: 'acme' })).toEqual([])
	})
})

describe('(c) a service missing from the resolved view', () => {
	it('unresolvedServicesOf names it; a plain compose has none', () => {
		expect(unresolvedServicesOf(plain, raw)).toEqual(['acme_x'])
		expect(unresolvedServicesOf(plain, plain)).toEqual([])
		expect(unresolvedServicesOf(plain, null)).toEqual([])
	})
	it('mergeFilePaths copies it in, so every rule runs on it', () => {
		const merged = mergeFilePaths(plain, raw) as { services: Record<string, unknown> }
		expect(Object.keys(merged.services).sort()).toEqual(['acme', 'acme_x'])
		const codes = composeViolations(merged, { appName: 'acme' }).map((v) => v.code)
		expect(codes).toContain('privileged')
		expect(codes).toContain('bind')
		expect(codes).toContain('profiles')
	})
	it('composeViolations refuses it from the context alone (without the merge), never exempt', () => {
		const ctx = deployGuardContext(input(plain, raw), ctxP)
		expect(ctx.unresolvedServices).toEqual(['acme_x'])
		const v = composeViolations(plain, { ...ctx, exempt: ['profiles'] })
		expect(v.map((x) => `${x.code}:${x.service}`)).toEqual(['profiles:acme_x'])
	})
	it('a plain probe sets no unresolved services', () => {
		expect(deployGuardContext(input(plain, plain), ctxP).unresolvedServices).toEqual([])
	})
})

describe('(a)+(c) the deploy check', () => {
	const probe = (resolved: unknown, rawCfg: unknown) =>
		['a'.repeat(64), JSON.stringify(resolved), JSON.stringify(rawCfg), ''].join('\n__POWDER_CG_SEP__\n')
	beforeEach(() => {
		state.cmds = []
	})
	const p = { appName: 'acme', workingDir: '/opt/apps/acme', composeFiles: ['/opt/apps/acme/docker-compose.yml'], routeHosts: null }
	it('reads every config with every profile active', async () => {
		state.stdout = probe(plain, plain)
		await checkComposeForDeploy(server, "-f 'c.yml'", p, { POWDER_COMPOSE_GUARD: 'warn' })
		const cmd = state.cmds.at(-1) ?? ''
		// the only plain listing is the profile guard's own `config --services`
		expect(cmd.match(/docker compose -f 'c\.yml' config(?! --services 2>\/dev\/null\) && PG_AOK)/g)).toBeNull()
		expect(cmd).toContain(`docker compose -f 'c.yml' ${ALL_PROFILES} config --format json`)
		expect(cmd).toContain(`docker compose -f 'c.yml' ${ALL_PROFILES} config --no-interpolate --format json`)
	})
	it('refuses a hidden service in warn mode, even with the stored hash unchanged', async () => {
		state.stdout = probe(plain, raw)
		const { structuralComposeHash } = await import('../deploy/compose-check')
		await expect(
			checkComposeForDeploy(server, "-f 'c.yml'", { ...p, approvedHash: structuralComposeHash(plain, raw) }, { POWDER_COMPOSE_GUARD: 'warn' }),
		).rejects.toThrow(/acme_x .*missing from the resolved one/)
	})
	it('a plain compose passes unchanged', async () => {
		state.stdout = probe(plain, plain)
		const r = await checkComposeForDeploy(server, "-f 'c.yml'", p, {})
		expect(r.log).toContain('passes the safety rules')
	})
	it('the hash pins the all-profiles config', () => {
		expect(composeConfigHashShell("-f 'c.yml'")).not.toMatch(/'c\.yml' config/)
	})
})

describe('(d) on-server profile guard', () => {
	let root: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'prof-')))
		mkdirSync(join(root, 'bin'))
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	// Fake docker: `config --services` prints PLAIN (or fails when PLAIN is "FAIL"), the
	// same with `--profile '*'` prints ALL.
	const run = (plainOut: string, allOut: string) => {
		writeFileSync(
			join(root, 'bin', 'docker'),
			`#!/bin/sh\ncase "$*" in *"--profile * config --services"*) [ "$ALL" = FAIL ] && exit 1; printf '%s\\n' $ALL;; *"config --services"*) [ "$PLAIN" = FAIL ] && exit 1; printf '%s\\n' $PLAIN;; esac\n`,
		)
		chmodSync(join(root, 'bin', 'docker'), 0o755)
		const r = spawnSync('bash', ['-c', `set -e; ${composeProfileGuardShell("-f 'c.yml'")} && echo PASSED`], {
			env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, PLAIN: plainOut, ALL: allOut },
			encoding: 'utf8',
		})
		return { ok: r.status === 0 && r.stdout.includes('PASSED'), out: r.stdout }
	}
	it('passes equal lists (any order)', () => {
		expect(run('acme db', 'db acme').ok).toBe(true)
	})
	it('refuses a service only every-profile mode lists', () => {
		const r = run('acme', 'acme acme_x')
		expect(r.ok).toBe(false)
		expect(r.out).toContain('profile guard: refusing')
	})
	it('refuses when only the plain listing fails (a service depends on a profiled one)', () => {
		expect(run('FAIL', 'acme acme_x').ok).toBe(false)
	})
	it('refuses when only the every-profile listing fails', () => {
		expect(run('acme', 'FAIL').ok).toBe(false)
	})
	it('both failing passes to compose (it cannot parse the file, the next step fails)', () => {
		expect(run('FAIL', 'FAIL').ok).toBe(true)
	})
	it('runs in the shared on-server guard, after the env file guard and before the bind guard', () => {
		const g = onServerComposeGuardShell("-f 'c.yml'", 'acme', '/opt/apps/acme')
		const at = g.indexOf('profile guard: refusing')
		expect(at).toBeGreaterThan(g.indexOf('env file guard'))
		expect(at).toBeLessThan(g.indexOf('bind guard'))
	})
	it('every recreate (composeUpCommand) runs it before the up', () => {
		const c = composeUpCommand('/opt/apps/acme/docker-compose.yml', 'acme', '/opt/apps/acme', { approval: { hash: '', app: 'acme', log: '' } })
		expect(c.indexOf('profile guard')).toBeGreaterThan(0)
		expect(c.indexOf('profile guard')).toBeLessThan(c.indexOf(' up -d'))
	})
	it('the deploy script runs it (el_guard) before its first compose config and every up', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/acme',
			configFile: '/opt/apps/acme/docker-compose.yml',
			service: 'acme',
			cf: composeFileArgs('/opt/apps/acme/docker-compose.yml'),
			declaredMode: 'build',
			prebuilt: false,
			migrateApp: 'acme',
			infra: ['db'],
			wantBranch: 'main',
			wantSha: null,
			shaIsStrict: false,
		})
		const def = s.indexOf('el_guard() {')
		expect(s.indexOf('profile guard', def)).toBeGreaterThan(def)
		expect(s.indexOf('el_guard && if ! CP_ERR')).toBeGreaterThan(0)
		expect(s).not.toMatch(/docker compose -f '[^']*'(?: \$\(\[ -f [^)]*\))? config(?! --services 2>\/dev\/null\) && PG_AOK)/)
	})
})

// The real compose (when this machine has it): the hostile cases, with invented names.
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0
describe.skipIf(!hasCompose)('with the real docker compose', () => {
	let root: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'real-')))
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	const dir = (name: string, yml: string) => {
		const d = join(root, name)
		mkdirSync(d, { recursive: true })
		writeFileSync(join(d, 'docker-compose.yml'), yml)
		return d
	}
	const PROF = 'name: acme\nservices:\n  acme:\n    image: acme:latest\n  acme_x:\n    image: alpine\n    profiles: ["x"]\n    privileged: true\n    volumes:\n      - /:/host\n'
	const PROF2 = 'name: acme\nservices:\n  acme:\n    image: acme:latest\n    depends_on: [acme_x]\n  acme_x:\n    image: alpine\n    profiles: ["x"]\n    privileged: true\n'
	const PLAIN = 'name: acme\nservices:\n  acme:\n    image: acme:latest\n    environment:\n      A: ${A:-x}\n'
	const services = (d: string, all: boolean) =>
		spawnSync('bash', ['-c', `docker compose -f docker-compose.yml ${all ? ALL_PROFILES : ''} config --services`], { cwd: d, encoding: 'utf8' }).stdout.trim().split('\n').sort()
	it("`--profile '*'` lists the profiled service the plain config drops", () => {
		const d = dir('prof', PROF)
		expect(services(d, false)).toEqual(['acme'])
		expect(services(d, true)).toEqual(['acme', 'acme_x'])
	})
	it("`--profile '*'` does not change the config of a compose without profiles", () => {
		const d = dir('plain', PLAIN)
		for (const extra of ['--format json', '--no-interpolate --format json', '']) {
			const a = spawnSync('bash', ['-c', `docker compose -f docker-compose.yml config ${extra}`], { cwd: d, encoding: 'utf8' })
			const b = spawnSync('bash', ['-c', `docker compose -f docker-compose.yml ${ALL_PROFILES} config ${extra}`], { cwd: d, encoding: 'utf8' })
			expect(a.status).toBe(0)
			expect(b.stdout).toBe(a.stdout)
		}
	})
	// the guards refuse when docker cannot list the containers, so the daemon
	// calls answer as an empty server (no daemon is needed here); compose is the real CLI.
	const wrap = () => {
		const bin = join(root, 'bin')
		mkdirSync(bin, { recursive: true })
		const real = spawnSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim()
		writeFakeDocker(bin, `#!/bin/sh\ncase "$1" in compose) exec ${JSON.stringify(real)} "$@";; esac\nexit 0\n`)
		return bin
	}
	const guard = (d: string) =>
		spawnSync(
			'bash',
			['-c', `set -e; ${onServerComposeGuardShell(`-f '${join(d, 'docker-compose.yml')}'`, 'acme', d, { checkName: false })} && echo PASSED`],
			{ cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${wrap()}:${process.env.PATH}` } },
		)
	it('the on-server guard refuses both bypass cases and passes a plain compose', () => {
		for (const [n, y] of [['g1', PROF], ['g2', PROF2]] as const) {
			const r = guard(dir(n, y))
			expect(r.stdout).toContain('profile guard: refusing')
			expect(r.stdout).not.toContain('PASSED')
		}
		const ok = guard(dir('g3', PLAIN))
		expect(ok.stdout).toContain('PASSED')
	})
})
