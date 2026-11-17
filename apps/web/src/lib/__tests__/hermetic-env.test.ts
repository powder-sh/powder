// Guard: no unit test inherits host state (vitest.setup.ts -> hermetic.ts). The
// suite once passed on one machine and failed on another because spawned
// scripts saw the host's docker CLI, global git config, ~/.pgpass, locale, a
// shared /tmp and real nginx config. If one of these checks fails, fix
// hermetic.ts, not the test that tripped over the host.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_STATE_ENV, hermeticRoot, pathWithout } from './hermetic'

const SET_BY_HERMETIC = new Set(['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME'])
const sh = (cmd: string, env: NodeJS.ProcessEnv = process.env) =>
	spawnSync('bash', ['-c', cmd], { env, encoding: 'utf8' })

describe('hermetic test env', () => {
	it('no host-state variable reaches a test or a spawned script', () => {
		const leaked = Object.keys(process.env).filter((k) => HOST_STATE_ENV.test(k) && !SET_BY_HERMETIC.has(k))
		expect(leaked).toEqual([])
		const spawned = sh('env')
			.stdout.split('\n')
			.map((l) => l.split('=')[0] as string)
			.filter((k) => HOST_STATE_ENV.test(k) && !SET_BY_HERMETIC.has(k))
		expect(spawned).toEqual([])
	})

	it('HOME and TMPDIR are private to this test file', () => {
		const root = realpathSync(hermeticRoot())
		expect(realpathSync(homedir()).startsWith(`${root}/`)).toBe(true)
		expect(realpathSync(tmpdir()).startsWith(`${root}/`)).toBe(true)
		expect(sh('printf %s "$HOME"').stdout).toBe(homedir())
		expect(sh('printf %s "$TMPDIR"').stdout).toBe(tmpdir())
		// the .db tests put a postgres unix socket under tmpdir()/<name>-pg-XXXXXX/;
		// macOS caps a socket path at 104 bytes
		expect(tmpdir().length).toBeLessThanOrEqual(40)
		// a script's bare mktemp lands there too, on every mktemp flavour
		for (const cmd of ['mktemp', 'mktemp -d', `PATH='${pathWithout([])}' mktemp`])
			expect(sh(cmd).stdout.startsWith(`${tmpdir()}/tmp.`)).toBe(true)
		expect(readdirSync(homedir()).sort()).toEqual(['.config', '.gitconfig', '.ssh'])
		expect(readFileSync(join(homedir(), '.ssh', 'id_ed25519'), 'utf8')).toBe('not-a-key\n')
	})

	it('git sees no host config at all', () => {
		const r = sh('cd "$TMPDIR" && git config --list --show-origin')
		expect(r.stdout).toBe('')
		expect(readFileSync(process.env.GIT_CONFIG_GLOBAL as string, 'utf8')).toBe('')
	})

	it('the host docker CLI is never reached; pathWithout can remove docker entirely', () => {
		const r = sh('command -v docker && docker info')
		expect(r.stdout.trim()).toBe(join(hermeticRoot(), 'guard-bin', 'docker'))
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain('blocked in unit tests')
		const sys = pathWithout([])
		expect(sh('docker info', { ...process.env, PATH: sys }).stderr).toContain('blocked in unit tests')
		expect(sh('command -v docker', { ...process.env, PATH: pathWithout(['docker']) }).status).not.toBe(0)
		expect(sh('command -v bash sort', { ...process.env, PATH: pathWithout(['docker']) }).status).toBe(0)
		// a daemon call through compose is blocked too
		expect(sh('docker compose -f x.yml --profile "*" ps').stderr).toContain('blocked in unit tests')
	})

	it('pathWithout builds one dir per distinct name set, so a loop of probes adds no dirs', () => {
		expect(pathWithout(['docker'])).toBe(pathWithout(['docker']))
		expect(pathWithout(['docker', 'nginx'])).toBe(pathWithout(['nginx', 'docker', 'nginx']))
		expect(pathWithout([])).not.toBe(pathWithout(['docker']))
		const dirs = () => readdirSync(hermeticRoot()).filter((d) => d.startsWith('path-')).length
		const before = dirs()
		for (let i = 0; i < 20; i++) pathWithout(['docker'])
		expect(dirs()).toBe(before)
	})

	it('the client-only compose calls reach the host CLI, so real-compose tests run where compose exists', () => {
		const host = process.env.POWDER_TEST_HOST_DOCKER ?? ''
		const hostHasCompose =
			host !== '' &&
			spawnSync(host, ['compose', 'version'], {
				env: { ...process.env, DOCKER_CONFIG: process.env.POWDER_TEST_HOST_DOCKER_CONFIG },
			}).status === 0
		// the probe compose-override / r15-compose-profiles use to decide skipIf
		expect(spawnSync('docker', ['compose', 'version', '--short']).status === 0).toBe(hostHasCompose)
		if (!hostHasCompose) return
		const d = mkdtempSync(join(tmpdir(), 'cmp-'))
		writeFileSync(join(d, 'docker-compose.yml'), 'services:\n  a:\n    image: busybox\n')
		const r = sh(`cd '${d}' && docker compose -f docker-compose.yml --profile '*' config --services`)
		expect(r.stdout.trim()).toBe('a')
	})

	it('byte-order locale (no LC_*/LANG: POSIX), as on the servers', () => {
		expect(sh("printf '%s\\n' ./lib ./.powder ./A | sort").stdout).toBe('./.powder\n./A\n./lib\n')
	})

	it('no test hard-codes a system PATH (it would reach the host docker): use pathWithout()', () => {
		// `PATH: '...:/usr/bin'`, `PATH=/bin:...` in a shell string, `:/usr/bin:/bin` anywhere
		const SYSTEM_PATH = /(?:PATH:\s*[`'"]|PATH=)[^`'"\n]*\/(?:usr\/)?(?:local\/)?s?bin(?=[:`'"\s;]|$)|:\/usr\/bin:\/bin\b/m
		const offenders = readdirSync(__dirname)
			.filter((f) => f.endsWith('.ts') && f !== 'hermetic.ts' && f !== 'hermetic-env.test.ts')
			.filter((f) => SYSTEM_PATH.test(readFileSync(join(__dirname, f), 'utf8')))
		expect(offenders).toEqual([])
	})
})
