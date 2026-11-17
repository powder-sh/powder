import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DFR_FOREIGN_AWK, dockerfileAuthorityShell, dockerfileRewriteFunctions, REGISTRY_LOGIN_HOSTS_SHELL } from '../build-cache'
import { type ComposeGuardContext, composeViolations, dockerfileImageAuthority, dockerfileImageForeign } from '../compose-safety'
import { deployGuardContext, parseComposeProbe, parseLoginHostsProbe } from '../deploy/compose-check'
import { writeFakeDocker } from './fixtures/fake-docker'

// builds and pulls run as root with root's registry logins. A ref on a registry
// root is logged in to must be the app's own (last path segment = the app name) or an
// image this compose builds; no build cache import / export at all. Invented names.

const root = mkdtempSync(join(tmpdir(), 'reg-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const base: ComposeGuardContext = { appName: 'demoapp', otherApps: ['otherapp'] }
const codes = (c: unknown, ctx: ComposeGuardContext = base) => composeViolations(c, ctx).map((v) => v.code)
const compose = (services: Record<string, unknown>) => ({ name: 'demoapp', services })

describe('compose: non-build images on a registry root is logged in to', () => {
	it('refuses another repo on ghcr.io (assumed when the probe did not read the logins), digest pins too', () => {
		for (const image of ['ghcr.io/example-org/payroll:latest', `ghcr.io/example-org/payroll@sha256:${'a'.repeat(64)}`, 'ghcr.io/example-org/demoapp-secrets:1'])
			expect(codes(compose({ demoapp: { image, container_name: 'demoapp' } })), image).toContain('image')
	})
	it('passes the app\'s own repo (a worker image shape); build services may tag any ghcr name', () => {
		expect(codes(compose({ worker: { image: 'ghcr.io/example-org/demoapp:latest', container_name: 'demoapp-worker' } }))).toEqual([])
		// common shape: a build tagged under a ghcr name that is not the app name still passes
		expect(
			codes(
				compose({
					demoapp: { image: 'ghcr.io/example-user/linkbuilder', build: { context: '.' }, container_name: 'demoapp' },
					tools: { image: 'demoapp-x', build: { context: '.', tags: ['ghcr.io/example-user/ml-demoappx:2'] }, container_name: 'demoapp-tools' },
				}),
			),
		).toEqual([])
	})
	it('a name a service here builds does not license pulling it on a login host', () => {
		const c = codes(
			compose({
				demoapp: { build: { context: '.' }, container_name: 'demoapp' },
				b: { build: { context: '.' }, image: 'ghcr.io/example-org/other-private', container_name: 'demoapp-b' },
				w: { image: 'ghcr.io/example-org/other-private', container_name: 'demoapp-w' },
			}),
		)
		expect(c).toEqual(['image'])
	})
	it('uses the probed login list: a registry root is not logged in to passes, Docker Hub always passes', () => {
		const ctx = { ...base, registryLoginHosts: ['registry.example.invalid'] }
		expect(codes(compose({ demoapp: { image: 'ghcr.io/example-org/payroll:latest', container_name: 'demoapp' } }), ctx)).toEqual([])
		expect(codes(compose({ demoapp: { image: 'registry.example.invalid/team/payroll:1', container_name: 'demoapp' } }), ctx)).toContain('image')
		for (const image of ['postgres:16-alpine', 'pgvector/pgvector:pg16', 'docker.io/library/redis:7'])
			expect(codes(compose({ db: { image, container_name: 'demoapp-db' } })), image).toEqual([])
	})
	it('refuses every build.cache_to and build.cache_from entry', () => {
		for (const build of [{ context: '.', cache_to: ['type=registry,ref=ghcr.io/example-org/payroll:cache'] }, { context: '.', cache_to: ['type=inline'] }, { context: '.', cache_from: ['type=registry,ref=ghcr.io/example-org/payroll:cache'] }, { context: '.', cache_from: ['ghcr.io/example-org/payroll:cache'] }])
			expect(codes(compose({ demoapp: { image: 'demoapp', build, container_name: 'demoapp' } })), JSON.stringify(build)).toContain('build')
		expect(codes(compose({ demoapp: { image: 'demoapp', build: { context: '.' }, container_name: 'demoapp' } }))).toEqual([])
	})
})

describe('probe: login hosts', () => {
	it('parses the 10th probe section into the context; older probes leave it unset', () => {
		const sep = '__POWDER_CG_SEP_00__'
		const cfg = JSON.stringify({ name: 'demoapp', services: {} })
		const nine = ['h'.repeat(64), cfg, cfg, '', '', '', '', '', '']
		const p10 = parseComposeProbe([...nine, 'ghcr.io registry.example.invalid:5000 BAD$ '].join(`\n${sep}\n`), sep)
		expect(p10?.registryLoginHosts).toEqual(['ghcr.io', 'registry.example.invalid:5000'])
		if (!p10) throw new Error('probe did not parse')
		const ctx = deployGuardContext(p10, { appName: 'demoapp', workingDir: '/opt/apps/demoapp', composeFiles: ['/opt/apps/demoapp/docker-compose.yml'], serverId: 's1', routeHosts: null })
		expect(ctx.registryLoginHosts).toEqual(['ghcr.io', 'registry.example.invalid:5000'])
		expect(dockerfileImageAuthority(ctx).loginHosts).toEqual(['ghcr.io', 'registry.example.invalid:5000'])
		const p9 = parseComposeProbe(nine.join(`\n${sep}\n`), sep)
		expect(p9?.registryLoginHosts).toBeUndefined()
		if (!p9) throw new Error('probe did not parse')
		expect(dockerfileImageAuthority(deployGuardContext(p9, { appName: 'demoapp', workingDir: '/opt/apps/demoapp', composeFiles: [], serverId: 's1', routeHosts: null })).loginHosts).toEqual(['ghcr.io'])
		expect(parseLoginHostsProbe('')).toEqual([])
	})
	it('the server reader prints host names only, never a credential; no config -> ghcr.io', () => {
		const d = join(root, 'dc')
		mkdirSync(d)
		writeFileSync(
			join(d, 'config.json'),
			'{\n\t"auths": {\n\t\t"ghcr.io": {\n\t\t\t"auth": "ZXhhbXBsZTpzZWNyZXQ="\n\t\t},\n\t\t"https://index.docker.io/v1/": {"auth":"QUFBQQ=="},\n\t\t"Registry.Example.invalid:5000": {}\n\t},\n\t"credHelpers": {"123.ecr.example.invalid": "ecr-login"},\n\t"credsStore": "desktop"\n}\n',
		)
		// root's config at its fixed path (pointed at the test dir); $DOCKER_CONFIG is ignored.
		const run = (dc: string) => spawnSync('bash', ['-c', `set -euo pipefail; ${REGISTRY_LOGIN_HOSTS_SHELL.split('/root/.docker/config.json').join(`${dc}/config.json`)}`], { encoding: 'utf8', env: { ...process.env, DOCKER_CONFIG: join(root, 'missing') } }).stdout
		const out = run(d)
		expect(out.trim().split(' ').sort()).toEqual(['123.ecr.example.invalid', 'ghcr.io', 'registry.example.invalid:5000'])
		expect(out).not.toContain('ZXhh')
		expect(out).not.toContain('docker.io')
		expect(run(join(root, 'missing'))).toBe('ghcr.io')
	})
})

describe('Dockerfile refs: TS and awk agree', () => {
	const a = { self: 'demoapp', foreign: [] as string[], others: ['otherapp'], loginHosts: ['ghcr.io'] }
	const awk = (ref: string) =>
		spawnSync('awk', [DFR_FOREIGN_AWK], {
			input: `${ref}\n`,
			encoding: 'utf8',
			env: { ...process.env, LC_ALL: 'C', DFR_FOREIGN: '', DFR_OTHERS: a.others.join(' '), DFR_SELF: a.self, DFR_LOGIN: a.loginHosts.join(' ') },
		}).stdout.trim()
	it('refuses another repo on a logged-in registry, passes the own repo and public bases', () => {
		for (const r of ['ghcr.io/example-org/payroll:1', `ghcr.io/example-org/payroll@sha256:${'b'.repeat(64)}`, 'GHCR.IO/Example-Org/Payroll']) {
			expect(dockerfileImageForeign(r, a), r).not.toBeNull()
			expect(awk(r), r).not.toBe('')
		}
		for (const r of ['ghcr.io/example-org/demoapp:base', 'node:22-alpine', 'alpine/git:latest', 'almir/webhook:latest', 'registry.example.invalid/team/payroll:1', 'docker.io/library/node:22']) {
			expect(dockerfileImageForeign(r, a), r).toBeNull()
			expect(awk(r), r).toBe('')
		}
	})
})

describe('dfr_one end to end', () => {
	const bin = join(root, 'bin')
	mkdirSync(bin)
	writeFakeDocker(bin, '#!/bin/bash\nexit 1\n')
	const dc = join(root, 'dc2')
	mkdirSync(dc)
	writeFileSync(join(dc, 'config.json'), '{"auths":{"ghcr.io":{"auth":"eDp5"}}}')
	let n = 0
	const run = (df: string, own = '', loginHosts: string[] = [], mode = 'enforce') => {
		const dir = join(root, `d${++n}`)
		mkdirSync(dir)
		writeFileSync(join(dir, 'Dockerfile'), df)
		const script = `DFR_NS=d4e5f60718293a4b5c6d7e8f90a1b2c3; DFR_APP=demoapp; DFR_DIR=$(mktemp -d); DFR_MODE=${mode}; DFR_PULL=1; DFR_OWN=${JSON.stringify(own)}; ${dockerfileAuthorityShell({ self: 'demoapp', foreign: [], others: [], loginHosts })}${dockerfileRewriteFunctions('demoapp')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`
		const r = spawnSync('bash', ['-c', script.split('/root/.docker/config.json').join(`${dc}/config.json`)], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
		return { code: r.status, log: r.stdout + r.stderr, out: existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '' }
	}
	it('refuses FROM / COPY --from another ghcr repo with the build server login read on the server', () => {
		expect(run('FROM ghcr.io/example-org/payroll:1\n').code).not.toBe(0)
		expect(run('FROM node:22\nCOPY --from=ghcr.io/example-org/payroll:1 /app /app\n').code).not.toBe(0)
		expect(run('FROM registry.example.invalid/team/payroll:1\n', '', ['registry.example.invalid']).code).not.toBe(0)
	})
	it('passes common public bases, stage names and the own repo (also when it is a built image)', () => {
		const r = run('FROM node:22-alpine AS deps\nFROM alpine/git:latest\nFROM deps\nFROM ghcr.io/example-org/demoapp:base\n')
		expect(r.code, r.log).toBe(0)
		expect(run('FROM ghcr.io/example-user/demoapp:base\n', 'ghcr.io/example-user/demoapp:latest').code).toBe(0)
		// a local image the app builds under a non-ghcr name keeps the dfr_own exemption
		expect(run('FROM demoapp-base:1\n', 'demoapp-base:latest').code).toBe(0)
	})
	it('an image this app builds under another name on a login host is not exempt (warn and enforce)', () => {
		for (const df of ['FROM ghcr.io/example-org/other AS src\nFROM alpine\nCOPY --from=src / /leak\n', 'FROM node:22\nCOPY --from=ghcr.io/example-org/other:1 / /leak\n']) {
			for (const mode of ['enforce', 'warn']) {
				const r = run(df, 'ghcr.io/example-org/other:latest', [], mode)
				expect(r.code, `${mode} ${df}`).not.toBe(0)
				expect(r.log, `${mode} ${df}`).toContain('refused in every guard mode')
			}
		}
	})
})
