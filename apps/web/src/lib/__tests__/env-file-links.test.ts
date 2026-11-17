// an app must not read another app's env file through an env_file or
// label_file that a container replaced with a symlink in a bind-mounted folder.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeViolations } from '../compose-safety'
import { ENV_LINK_MARKER, envLinkRefusal } from '../deploy/compose-check'
import { COMPOSE_JSON_PATHS_AWK, composeUpCommand, envFileLinkGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { ENV_READ_GUARD_FN } from '../ssh/files'
import { writeFakeDocker } from './fixtures/fake-docker'

describe('compose guard: a bind may not contain an env_file / label_file', () => {
	const ctx = { appName: 'a', projectDir: '/opt/apps/a', resolved: true }
	const svc = (extra: Record<string, unknown>) => ({ services: { a: { image: 'a', ...extra } } })

	it('refuses a bind of the folder holding a second env_file (the exploit)', () => {
		const v = composeViolations(
			svc({ env_file: ['/opt/apps/a.env', './cfg/extra.env'], volumes: ['./cfg:/cfg'] }),
			ctx,
		)
		expect(v.some((x) => x.code === 'bind' && x.message.includes('/opt/apps/a/cfg/extra.env'))).toBe(true)
	})
	it('reads the path form and label_file, from any service', () => {
		const v = composeViolations(
			{
				services: {
					a: { image: 'a', volumes: [{ type: 'bind', source: '/opt/apps/a/data', target: '/d' }] },
					w: { image: 'w', label_file: '/opt/apps/a/data/l.env', env_file: [{ path: './data/x.env', required: false }] },
				},
			},
			ctx,
		)
		expect(v.filter((x) => x.code === 'bind').length).toBe(2)
	})
	it('allows binding the env file itself and binds that hold no env file', () => {
		expect(
			composeViolations(
				svc({ env_file: ['./conf/app.env'], volumes: ['./conf/app.env:/app/.env:ro', './data:/data'] }),
				ctx,
			).filter((x) => x.code === 'bind'),
		).toEqual([])
	})
})

describe('env_file path extraction (compose config --no-interpolate --format json)', () => {
	const run = (doc: unknown) =>
		execFileSync('awk', [COMPOSE_JSON_PATHS_AWK], { input: JSON.stringify(doc, null, 2) }).toString().split('\n').filter(Boolean)
	it('reads both list forms and skips other keys', () => {
		const doc = {
			name: 'a',
			services: {
				app: {
					env_file: [
						{ path: '/opt/apps/a.env', required: true },
						{ path: '/opt/apps/a/cfg/x y.env', required: false },
					],
					environment: { env_file: '/not/a/path' },
					image: 'a',
					labels: { env_file: '/not/a/path' },
					label_file: ['/opt/apps/a/l.env'],
				},
				db: { env_file: ['/opt/apps/a-db.env'], label_file: [] },
			},
			networks: { default: { name: 'a_default' } },
		}
		expect(run(doc)).toEqual([
			'N a',
			'F /opt/apps/a.env',
			'BF "/opt/apps/a/cfg/x y.env"',
			'F /opt/apps/a/l.env',
			'F /opt/apps/a-db.env',
		])
	})
	it('marks escapes and variables as unreadable (e.g. "./d2/x\\ty.env")', () => {
		const doc = { services: { app: { env_file: [{ path: '/opt/apps/a/data/x\ty.env' }, { path: '/opt/apps/a/${X}.env' }, { path: '/opt/apps/a/q: z.env' }] } } }
		expect(run(doc)).toEqual(['BF "/opt/apps/a/data/x\\ty.env"', 'BF "/opt/apps/a/${X}.env"', 'BF "/opt/apps/a/q: z.env"'])
	})
	it('refuses a layout it does not know', () => {
		expect(run({ services: {} })).toEqual([])
		expect(execFileSync('awk', [COMPOSE_JSON_PATHS_AWK], { input: '{"services":{}}' }).toString()).toMatch(/^E /)
	})
})

describe('env file link guard (shell, on a temp tree)', () => {
	let root: string
	let app: string
	let own: string
	let other: string
	let bin: string
	let yamlFile: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'envlink-')))
		app = join(root, 'apps', 'a')
		own = join(root, 'apps', 'a.env')
		other = join(root, 'apps', 'b.env')
		bin = join(root, 'bin')
		yamlFile = join(root, 'cfg.json')
		writeFileSync(join(root, 'compose.yml'), 'services:\n  a:\n    image: a\n')
		mkdirSync(join(app, 'cfg'), { recursive: true })
		mkdirSync(bin)
		writeFileSync(own, 'A=1\n')
		writeFileSync(other, 'SECRET=b\n')
		// Fake docker: `docker compose ... config --no-interpolate --format json` prints the fixture.
		writeFakeDocker(bin, `#!/bin/sh\ncase "$1" in ps|inspect) exit 0;; esac\ncat ${JSON.stringify(yamlFile)}\n`)
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))

	const guard = (paths: string[]) => {
		writeFileSync(
			yamlFile,
			JSON.stringify({ name: 'a', services: { a: { env_file: paths.map((p) => ({ path: p, required: true })), image: 'a' } } }, null, 2),
		)
		const r = spawnSync('bash', ['-c', `${envFileLinkGuardShell(`-f '${join(root, 'compose.yml')}'`, 'a', app, own)} && echo PASSED`], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		return { ok: r.status === 0 && r.stdout.toString().includes('PASSED'), out: r.stdout.toString() }
	}

	it('passes plain files inside the app and the own env file', () => {
		writeFileSync(join(app, 'cfg', 'plain.env'), 'X=1\n')
		expect(guard([own, join(app, 'cfg', 'plain.env')]).ok).toBe(true)
	})
	it('refuses a link inside the app dir to another app env file, in every mode, with a clear message', () => {
		symlinkSync(other, join(app, 'cfg', 'extra.env'))
		const r = guard([own, join(app, 'cfg', 'extra.env')])
		expect(r.ok).toBe(false)
		expect(r.out).toContain('env file guard: refusing')
		expect(r.out).toContain(other)
	})
	it('refuses a linked folder component that leaves the app', () => {
		symlinkSync(join(root, 'apps'), join(app, 'up'))
		expect(guard([join(app, 'up', 'b.env')]).ok).toBe(false)
	})
	it('allows .env -> the own /opt/apps/<app>.env (an operator-made link to the own env file)', () => {
		symlinkSync(own, join(app, '.env'))
		expect(guard([join(app, '.env')]).ok).toBe(true)
	})
	it('refuses even a link that stays inside the app dir (any symlink below the root)', () => {
		symlinkSync(join(app, 'cfg', 'plain.env'), join(app, 'inner.env'))
		expect(guard([join(app, 'inner.env')]).ok).toBe(false)
	})
	it('a path built from a variable is refused (hard, every mode)', () => {
		const r = guard([`${app}/\${EF:-x}.env`])
		expect(r.ok).toBe(false)
		expect(r.out).toContain('characters outside [A-Za-z0-9._/-]')
	})
	it('a missing optional env file passes', () => {
		expect(guard([join(app, 'nope', 'x.env')]).ok).toBe(true)
	})
})

describe('read side: envread_ok', () => {
	const ok = (p: string) => spawnSync('bash', ['-c', `${ENV_READ_GUARD_FN}envread_ok "$1"`, '_', p]).status === 0
	let root: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'envread-')))
		mkdirSync(join(root, 'x'))
		writeFileSync(join(root, 'x', 'real.env'), 'A=1\n')
		writeFileSync(join(root, 'foreign.env'), 'B=1\n')
		symlinkSync(join(root, 'foreign.env'), join(root, 'x', 'link.env'))
		symlinkSync(join(root, 'x', 'real.env'), join(root, 'x', 'inner.env'))
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	it('reads a plain file and a link inside its own dir, refuses a link out of it', () => {
		expect(ok(join(root, 'x', 'real.env'))).toBe(true)
		expect(ok(join(root, 'x', 'inner.env'))).toBe(true)
		expect(ok(join(root, 'x', 'link.env'))).toBe(false)
	})
})

describe('wiring', () => {
	it('the deploy script runs the guard before config, the release and the swap', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/a',
			configFile: '/opt/apps/a/docker-compose.yml',
			service: 'a',
			cf: '-f /opt/apps/a/docker-compose.yml',
			declaredMode: 'build',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		// defined once as el_guard, called before config, the release and the swap
		expect(s.split('config --no-interpolate failed').length - 1).toBe(1)
		expect(s.indexOf('el_guard() {')).toBeLessThan(s.indexOf('compose file is INVALID'))
		expect(s.indexOf('step \'env file links (before the release)\' && el_guard &&')).toBeGreaterThan(-1)
		expect(s.indexOf("env file links (before the swap)")).toBeLessThan(s.indexOf('step "docker compose up"'))
		expect(s).toContain("EL_APP='a'")
		expect(s).toContain('"/opt/apps/$EL_APP.env"')
	})
	it('rollback / domain apply / manual apply (composeUpCommand) run it before up', () => {
		const c = composeUpCommand('/opt/apps/shop/docker-compose.yml', 'shop', '/opt/apps/shop', { approval: { hash: '', app: null, log: '' } })
		expect(c.indexOf('env file guard')).toBeGreaterThan(-1)
		expect(c.indexOf('env file guard')).toBeLessThan(c.indexOf('up -d --no-build'))
		expect(c).toContain("EL_APP='\\''shop'\\''")
	})
	it('the compose guard probe turns a refusal into a hard error', () => {
		expect(envLinkRefusal(`${ENV_LINK_MARKER}\nenv file guard: refusing, x\n`)).toBe('env file guard: refusing, x')
		expect(envLinkRefusal('abc\n__POWDER_CG_SEP__\n')).toBeNull()
	})
})
