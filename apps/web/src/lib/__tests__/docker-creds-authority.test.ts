import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Client } from 'ssh2'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ONE authority over root's registry login (lib/docker-env.ts). Every ssh exec starts
// with NOCREDS_PREFIX (DOCKER_CONFIG = a login-free dir); only withRegistryCreds, fed a
// deployPushDecision, gives one `docker push` / `docker pull` root's login. Invented names.

vi.hoisted(() => {
	const fs = require('node:fs') as typeof import('node:fs')
	const os = require('node:os') as typeof import('node:os')
	const p = `${os.tmpdir()}/powder-test-key-${process.pid}`
	fs.writeFileSync(p, 'not a real key')
	process.env.SSH_KEY_PATH = p
})

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({
	getServer: async () => ({ id: 's1', host: '127.0.0.1', user: 'root', baseDomain: 'apps.example.test', tlsMode: 'acme' }),
}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))
vi.mock('../deploys', () => ({ runHealthGate: async () => ({ healthy: true, output: 'ok' }) }))
vi.mock('../recreate-guard', () => ({ checkComposeForRecreate: async () => ({ hash: '', app: 'quillbox', log: '' }) }))
vi.mock('../deploy-push', async () => {
	const p = await import('../deploy-push-policy')
	return { loadDeployPushDecision: async (app: string, image: string) => p.deployPushDecision(app, image, [], [app]) }
})

import { buildBuilderScript } from '../builder'
import { REGISTRY_LOGIN_HOSTS_SHELL } from '../build-cache'
import { deployPushDecision, refusedPush } from '../deploy-push-policy'
import { atomicRollback, spawnSnapshot } from '../deploy-snapshots'
import { NOCREDS_CONFIG_JSON, NOCREDS_DIR, NOCREDS_PREFIX, sshCommand, withRegistryCreds } from '../docker-env'
import { bridgeShellFunctions, composeFileArgs, composeUpCommand, testGateShell } from '../deploy/fragments'
import { rollbackTargetShell, rollbackToImage } from '../deploy/health'
import { tagDeployCommand, tagDeployImage } from '../deploy/run'
import { buildDeployScript } from '../deploy/script'
import { runCommand } from '../ssh/connection'
import { streamContainerLogs } from '../ssh/logs'

const SRC = join(__dirname, '../..')
const rel = (f: string) => relative(SRC, f)
function walk(dir: string, out: string[] = []): string[] {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f)
		if (statSync(p).isDirectory()) {
			if (f !== '__tests__' && f !== 'node_modules') walk(p, out)
		} else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p)
	}
	return out
}
const files = walk(SRC).map((f) => ({ f: rel(f), s: readFileSync(f, 'utf8') }))

/** The text of one top-level `export function <name>` (up to the next top-level export). */
function fnBody(src: string, name: string): string {
	const at = src.indexOf(`export function ${name}(`)
	if (at < 0) return ''
	const next = src.indexOf('\nexport ', at + 1)
	return src.slice(at, next < 0 ? undefined : next)
}

describe('(a) every ssh2 exec goes through sshCommand', () => {
	it('each `<x>.exec(` that is not a RegExp exec wraps its command in sshCommand(', () => {
		const bad: string[] = []
		let seen = 0
		for (const { f, s } of files) {
			for (const m of s.matchAll(/(\/|[A-Za-z0-9_$\])]+)\s*\.\s*exec\s*\(\s*/g)) {
				const recv = m[1] ?? ''
				// A RegExp literal (`/x/.exec(`) or a regex variable (`...Re.exec(`, `re.exec(`).
				if (recv === '/' || /(^re|Re|RE|regex|Regex)$/.test(recv)) continue
				seen++
				if (!s.startsWith('sshCommand(', m.index + m[0].length)) bad.push(`${f}: ${s.slice(m.index, m.index + 80)}`)
			}
			// no other way into an ssh channel: shell() or exec via bracket access
			if (/\.shell\s*\(|\[\s*['"]exec['"]\s*\]/.test(s) && /ssh2/.test(s)) bad.push(`${f}: shell()/['exec']`)
		}
		expect(bad).toEqual([])
		expect(seen).toBeGreaterThanOrEqual(4) // runCommand, the log stream, the builder's two
	})
})

describe('(b) root login appears only in the authority, the probe and its two users', () => {
	const allowedTokens: Record<string, string[]> = {
		'lib/docker-env.ts': ['DOCKER_CONFIG', '/root/.docker', '.docker/config.json', 'withRegistryCreds('],
		'lib/build-cache.ts': ['DOCKER_CONFIG', '/root/.docker', '.docker/config.json'],
		'lib/deploy/run.ts': ['withRegistryCreds('],
		'lib/deploy/health.ts': ['withRegistryCreds('],
	}
	it('DOCKER_CONFIG, /root/.docker, .docker/config.json and withRegistryCreds( nowhere else', () => {
		const bad: string[] = []
		for (const { f, s } of files) {
			for (const tok of ['DOCKER_CONFIG', '/root/.docker', '.docker/config.json', 'withRegistryCreds(']) {
				if (s.includes(tok) && !(allowedTokens[f] ?? []).includes(tok)) bad.push(`${f}: ${tok}`)
			}
		}
		expect(bad).toEqual([])
	})
	it('the probe reads /root/.docker explicitly; the creds users are tagDeployCommand and rollbackTargetShell only', () => {
		const bc = readFileSync(join(SRC, 'lib/build-cache.ts'), 'utf8')
		expect(REGISTRY_LOGIN_HOSTS_SHELL.startsWith('__dc=/root/.docker/config.json; ')).toBe(true)
		expect(REGISTRY_LOGIN_HOSTS_SHELL).not.toContain('DOCKER_CONFIG')
		expect(bc.split('/root/.docker').length - 1).toBe(2) // the doc comment and the probe
		const run = readFileSync(join(SRC, 'lib/deploy/run.ts'), 'utf8')
		const health = readFileSync(join(SRC, 'lib/deploy/health.ts'), 'utf8')
		expect(run.split('withRegistryCreds(').length - 1).toBe(1)
		expect(fnBody(run, 'tagDeployCommand')).toContain('withRegistryCreds(`docker push ${shq(tag)}`, push)')
		expect(health.split('withRegistryCreds(').length - 1).toBe(1)
		expect(fnBody(health, 'rollbackTargetShell')).toContain('withRegistryCreds(`docker pull ${img}`, pull)')
	})
	it('no host command resets the environment the prefix set', () => {
		const bad: string[] = []
		for (const { f, s } of files) {
			for (const re of [/env -i\b/, /\bHOME=/, /unset DOCKER_CONFIG/, /env -u DOCKER_CONFIG/, /DOCKER_AUTH_CONFIG=/, /\bsudo -i\b/, /\bsu -\s/, /\bsu -l\b/, /\bsystemd-run\b/]) {
				if (re.test(s)) bad.push(`${f}: ${re}`)
			}
		}
		expect(bad).toEqual([])
	})
})

describe('withRegistryCreds and NOCREDS_PREFIX', () => {
	it('grants only an allowing decision deployPushDecision issued, for one docker push/pull', () => {
		const ok = deployPushDecision('quillbox', 'ghcr.io/example-org/quillbox:1', [], ['quillbox'])
		expect(withRegistryCreds("docker push 'ghcr.io/example-org/quillbox:deploy-1'", ok)).toBe("DOCKER_CONFIG=/root/.docker docker push 'ghcr.io/example-org/quillbox:deploy-1'")
		expect(() => withRegistryCreds("docker pull 'x/y:1'", { allow: true, reason: 'literal' } as never)).toThrow(/deployPushDecision/)
		expect(() => withRegistryCreds("docker pull 'x/y:1'", refusedPush('no'))).toThrow()
		expect(() => withRegistryCreds("docker pull 'x/y:1'", deployPushDecision('quillbox', 'ghcr.io/example-org/other:1', [], ['quillbox']))).toThrow()
		for (const c of ["docker pull 'a/b:1'; docker pull 'c/d:2'", "docker build -t 'a/b' .", 'docker pull a/b:1', "docker compose pull 'x'", "docker pull 'a/b:1' && id"])
			expect(() => withRegistryCreds(c, ok), c).toThrow()
	})

	const root = mkdtempSync(join(tmpdir(), 'nc-'))
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	let n = 0
	/** The prefix with its dir moved under a temp root, run as the current user forced down the root branch. */
	function runPrefix(setup?: (d: string) => void, extraEnv: Record<string, string> = {}) {
		const d = join(root, `p${++n}`)
		setup?.(d)
		const prefix = NOCREDS_PREFIX.split(NOCREDS_DIR).join(d).replace('"$(id -u 2>/dev/null)" = 0', '1 = 1')
		const r = spawnSync('bash', ['-c', `${prefix}echo "DC=$DOCKER_CONFIG AUTH=\${DOCKER_AUTH_CONFIG:-unset}"`], { encoding: 'utf8', env: { ...process.env, DOCKER_AUTH_CONFIG: '{"auths":{"ghcr.io":{}}}', DOCKER_CONFIG: '/root/.docker', ...extraEnv } })
		return { d, code: r.status, out: r.stdout, err: r.stderr }
	}
	it('creates the login-free config, exports DOCKER_CONFIG to it and unsets DOCKER_AUTH_CONFIG', () => {
		const r = runPrefix()
		expect(r.code).toBe(0)
		expect(r.out.trim()).toBe(`DC=${r.d} AUTH=unset`)
		expect(readFileSync(join(r.d, 'config.json'), 'utf8')).toBe(NOCREDS_CONFIG_JSON)
		expect(statSync(r.d).mode & 0o777).toBe(0o755)
		expect(statSync(join(r.d, 'config.json')).mode & 0o777).toBe(0o644)
	})
	it('rewrites a config.json that carries logins', () => {
		const r = runPrefix((d) => {
			mkdirSync(d)
			writeFileSync(join(d, 'config.json'), '{"auths":{"ghcr.io":{"auth":"eDp5"}}}')
		})
		expect(r.code).toBe(0)
		expect(readFileSync(join(r.d, 'config.json'), 'utf8')).toBe(NOCREDS_CONFIG_JSON)
	})
	it('refuses (exit 97, nothing after it runs) when the dir or config.json is a symlink or not a file', () => {
		const real = join(root, 'realcfg')
		mkdirSync(real, { recursive: true })
		writeFileSync(join(real, 'config.json'), '{"auths":{"ghcr.io":{"auth":"eDp5"}}}')
		const a = runPrefix((d) => symlinkSync(real, d))
		expect(a.code).toBe(97)
		expect(a.out).toBe('')
		expect(a.err).toContain('refusing to run')
		const b = runPrefix((d) => {
			mkdirSync(d)
			symlinkSync(join(real, 'config.json'), join(d, 'config.json'))
		})
		expect(b.code).toBe(97)
		expect(readFileSync(join(real, 'config.json'), 'utf8')).toContain('eDp5') // never written through
		const c = runPrefix((d) => mkdirSync(join(d, 'config.json'), { recursive: true }))
		expect(c.code).toBe(97)
		expect(lstatSync(join(c.d, 'config.json')).isDirectory()).toBe(true)
	})
	it('parses as POSIX sh and a non-root user gets a dir under its HOME', () => {
		expect(spawnSync('sh', ['-n', '-c', NOCREDS_PREFIX]).status).toBe(0)
		const home = join(root, 'home')
		mkdirSync(home)
		const r = spawnSync('bash', ['-c', `${NOCREDS_PREFIX.replace('"$(id -u 2>/dev/null)" = 0', '1 = 0')}echo "$DOCKER_CONFIG"`], { encoding: 'utf8', env: { ...process.env, HOME: home } })
		expect(r.status).toBe(0)
		expect(r.stdout.trim()).toBe(join(home, '.powder-docker-nocreds'))
		expect(existsSync(join(home, '.powder-docker-nocreds', 'config.json'))).toBe(true)
	})
})

// ── (c) the wire: what reaches ssh2 ─────────────────────────────────────────────────
const wire: string[] = []
beforeAll(() => {
	vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
		setImmediate(() => this.emit('ready'))
		return this
	})
	vi.spyOn(Client.prototype, 'end').mockImplementation(function (this: Client) {
		return this
	})
	vi.spyOn(Client.prototype, 'exec').mockImplementation(function (this: Client, cmd: string, cb: (e: undefined, s: unknown) => void) {
		wire.push(cmd)
		const body = cmd.startsWith(NOCREDS_PREFIX) ? cmd.slice(NOCREDS_PREFIX.length) : cmd
		const s = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), setEncoding: () => {} })
		cb(undefined, s)
		let out = ''
		if (/json \.Config\.Labels/.test(body)) out = '{"com.docker.compose.project":"quillbox","com.docker.compose.service":"quillbox","com.docker.compose.version":"2.35.1"}\n'
		else if (/ExposedPorts/.test(body)) out = '3000/tcp'
		else if (/config --images/.test(body)) out = 'ghcr.io/example-org/quillbox:latest\n'
		else if (/inspect -f/.test(body)) out = 'sha256:prev\n'
		setImmediate(() => {
			if (out) s.emit('data', out)
			s.emit('close', 0)
		})
		return true
	} as unknown as Client['exec'])
})
beforeEach(() => {
	wire.length = 0
})
const server = { id: 's1', host: '127.0.0.1', user: 'root' } as never
const body = (c: string) => c.slice(NOCREDS_PREFIX.length)
const credentialed = (cmds: string[]) => cmds.flatMap((c) => c.match(/DOCKER_CONFIG=[^ ]+ docker [a-z]+ '[^']+'/g) ?? [])

describe('(c) every remote command starts with the prefix; only the push and the rollback pull carry creds', () => {
	it('runCommand and the log stream', async () => {
		await runCommand(server, 'docker ps')
		const h = await streamContainerLogs(server, 'quillbox', { onData: () => {} })
		h.cancel()
		expect(wire.length).toBe(2)
		for (const c of wire) expect(c.startsWith(NOCREDS_PREFIX)).toBe(true)
		expect(body(wire[1] ?? '')).toMatch(/^docker logs --follow/)
	})
	it('the rollback tag push: one credentialed docker push, only when allowed', async () => {
		await tagDeployImage(server, 'ghcr.io/example-org/quillbox:latest', 'dep_q1', deployPushDecision('quillbox', 'ghcr.io/example-org/quillbox:latest', [], ['quillbox']))
		await tagDeployImage(server, 'ghcr.io/example-org/ledgerly:latest', 'dep_q2', deployPushDecision('quillbox', 'ghcr.io/example-org/ledgerly:latest', [], ['quillbox']))
		for (const c of wire) expect(c.startsWith(NOCREDS_PREFIX)).toBe(true)
		expect(credentialed(wire)).toEqual(["DOCKER_CONFIG=/root/.docker docker push 'ghcr.io/example-org/quillbox:deploy-q1'"])
	})
	it('the rollback: one credentialed docker pull of the owned target; the recreate runs without creds', async () => {
		await rollbackToImage(server, '/opt/apps/quillbox/docker-compose.yml', 'quillbox', 'ghcr.io/example-org/quillbox:deploy-7', 'ghcr.io/example-org/quillbox:latest', undefined, {
			workingDir: '/opt/apps/quillbox',
			app: 'quillbox',
			approval: { hash: '', app: 'quillbox', log: '' },
		})
		for (const c of wire) expect(c.startsWith(NOCREDS_PREFIX)).toBe(true)
		expect(credentialed(wire)).toEqual(["DOCKER_CONFIG=/root/.docker docker pull 'ghcr.io/example-org/quillbox:deploy-7'"])
		const rb = wire.find((c) => c.includes('rollback target')) ?? ''
		expect(body(rb).split('DOCKER_CONFIG=').length - 1).toBe(1)
		expect(rb).toContain('--force-recreate')
	})
	it('snapshot and atomic rollback: no creds, docker run --pull=never', async () => {
		const deploy = { id: 'dep_9', imageTag: 'ghcr.io/example-org/quillbox:deploy-9' } as never
		const repo = { serverId: 's1', containerName: 'quillbox' } as never
		await spawnSnapshot(deploy, repo).catch(() => {}) // the db write after the run is mocked away
		await atomicRollback(deploy, repo).catch(() => {})
		for (const c of wire) expect(c.startsWith(NOCREDS_PREFIX)).toBe(true)
		const runs = wire.map(body).filter((c) => /docker run /.test(c))
		expect(runs.length).toBe(2)
		for (const r of runs) expect(r).toMatch(/docker run -d --pull=never --name /)
		expect(credentialed(wire)).toEqual([])
		expect(wire.some((c) => body(c).includes('DOCKER_CONFIG'))).toBe(false)
	})
})

describe('(c) rendered scripts carry no creds and do not undo the prefix', () => {
	const cf = composeFileArgs('/opt/apps/quillbox/docker-compose.yml')
	const deployScript = buildDeployScript({
		workingDir: '/opt/apps/quillbox',
		configFile: '/opt/apps/quillbox/docker-compose.yml',
		service: 'quillbox',
		cf,
		declaredMode: 'build',
		prebuilt: false,
		migrateApp: 'quillbox',
		infra: ['db'],
		wantBranch: 'main',
		wantSha: null,
		shaIsStrict: false,
		buildPull: true,
	} as never)
	const registryScript = buildDeployScript({
		workingDir: '/opt/apps/quillbox',
		configFile: '/opt/apps/quillbox/docker-compose.yml',
		service: 'quillbox',
		cf,
		declaredMode: 'registry',
		prebuilt: false,
		migrateApp: 'quillbox',
		infra: [],
		wantBranch: 'main',
		wantSha: null,
		shaIsStrict: false,
	} as never)
	const builderScript = buildBuilderScript({
		dir: '/opt/builds/s-quillbox',
		keyPath: '/tmp/k',
		repoUrl: 'git@github.com:example-org/quillbox.git',
		branch: 'main',
		sha: null,
		image: 'quillbox:latest',
		uniq: 'quillbox:latest-b1',
		ctx: '/opt/builds/s-quillbox/src',
		df: '/opt/builds/s-quillbox/src/Dockerfile',
		buildArgs: '',
		app: 'quillbox',
	})
	const up = composeUpCommand('/opt/apps/quillbox/docker-compose.yml', 'quillbox', '/opt/apps/quillbox', { approval: { hash: '', app: 'quillbox', log: '' } })
	const bridge = bridgeShellFunctions(cf, 'quillbox', '/opt/apps/quillbox')
	const gate = testGateShell({ dir: "'/opt/apps/quillbox/src'", label: '/opt/apps/quillbox|quillbox', run: '', tag: '[tg]', app: 'quillbox' })
	const refusedRollback = rollbackTargetShell('ghcr.io/example-org/ledgerly:deploy-3', refusedPush('the app ledgerly pushed it'))
	const refusedTag = tagDeployCommand('ghcr.io/example-org/ledgerly:latest', 'dep_1', refusedPush('not yours'))
	const all: Record<string, string> = { deployScript, registryScript, builderScript, up, bridge, gate, refusedRollback, refusedTag }
	it('each parses, gets the prefix on the wire, and has no DOCKER_CONFIG / env reset of its own', () => {
		for (const [k, s] of Object.entries(all)) {
			expect(sshCommand(s).startsWith(NOCREDS_PREFIX), k).toBe(true)
			// on stdin: Linux caps a single argv string at 128 KiB (MAX_ARG_STRLEN) and the
			// deploy script is larger, so `bash -n -c <script>` fails to spawn (E2BIG) there
			expect(spawnSync('bash', ['-n'], { input: sshCommand(s) }).status, k).toBe(0)
			expect(s, k).not.toContain('DOCKER_CONFIG')
			expect(s, k).not.toContain('DOCKER_AUTH_CONFIG')
			expect(s, k).not.toMatch(/\benv -i\b|\bHOME=|\bsudo\b|\bsu -/)
		}
	})
	it('the release, swap check, label step, compose pull, build and test gate run under the prefix only', () => {
		expect(deployScript).toMatch(/docker compose [^;]* build --pull 'quillbox'/)
		expect(registryScript).toContain("pull --ignore-buildable 'quillbox'")
		expect(deployScript).toContain('docker run')
		expect(builderScript).toContain('docker build --pull')
		expect(gate).toContain('docker run --rm --pull=never')
		expect(bridge).toContain('docker create --pull=never --name "$__name"')
		expect(refusedRollback).not.toContain('docker pull')
		expect(refusedTag).not.toContain('docker push')
	})
})
