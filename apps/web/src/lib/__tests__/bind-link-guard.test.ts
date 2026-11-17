// mount sources and the host files compose reads may not go through a symlink a
// container (or the repo) planted, and a mount source may not sit inside another
// writable bind of the project. The compose project name must be the app name.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMPOSE_JSON_MOUNTS_AWK, bindLinkGuardShell, composeUpCommand } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

describe('bind link guard (shell, temp tree shaped like the powder server)', () => {
	let root: string
	let vol: string
	let apps: string
	let bin: string
	let json: string
	let json2: string
	let compose: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'bindguard-')))
		// The powder server: the apps base is itself a link to a volume. Links above the root never count.
		vol = join(root, 'vol', 'apps')
		apps = join(root, 'apps')
		mkdirSync(join(vol, 'shop', 'data'), { recursive: true })
		mkdirSync(join(vol, 'shop', 'src', 'docker'), { recursive: true })
		mkdirSync(join(vol, 'shop-uploads'), { recursive: true })
		mkdirSync(join(root, 'var', 'shop-content'), { recursive: true })
		symlinkSync(vol, apps)
		writeFileSync(join(vol, 'shop.build-env'), 'A=1\n')
		writeFileSync(join(vol, 'shop', 'src', 'docker', 'Dockerfile'), 'FROM scratch\n')
		// a container-planted link inside a bound folder
		symlinkSync('/', join(vol, 'shop', 'data', 'r'))
		// a tracked in-repo link that stays inside the checkout
		symlinkSync('docker/Dockerfile', join(vol, 'shop', 'src', 'Dockerfile'))
		// a tracked in-repo link that leaves the app
		symlinkSync('/etc', join(vol, 'shop', 'src', 'etc'))
		bin = join(root, 'bin')
		mkdirSync(bin)
		json = join(root, 'cfg.json')
		json2 = join(root, 'cfg2.json')
		compose = join(root, 'compose.yml')
		writeFileSync(compose, 'services:\n  shop:\n    image: shop\n')
		writeFileSync(join(root, 'ps.txt'), '')
		writeFileSync(join(root, 'mounts.txt'), '')
		// Fake docker: `ps -q` lists ps.txt, `inspect` prints mounts.txt, `compose ...
		// --no-interpolate` prints the JSON fixture, a plain `compose config` the second one.
		writeFileSync(join(root, 'vdev.txt'), '')
		writeFakeDocker(bin, `#!/bin/sh\ncase "$1" in ps) cat ${JSON.stringify(join(root, 'ps.txt'))}; exit 0;; volume) case "$*" in *' -- '*) exit 1;; esac; cat ${JSON.stringify(join(root, 'vdev.txt'))}; exit 0;; inspect) case "$*" in *'"volume"'*) [ -s ${JSON.stringify(join(root, 'vdev.txt'))} ] && echo vol1; exit 0;; esac; cat ${JSON.stringify(join(root, 'mounts.txt'))}; exit 0;; esac\ncase "$*" in *no-interpolate*) cat ${JSON.stringify(json)};; *) cat ${JSON.stringify(json2)};; esac\n`)
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))

	const bind = (source: string, ro = false) => ({
		type: 'bind',
		source,
		target: '/x',
		...(ro ? { read_only: true } : {}),
		bind: { create_host_path: true },
	})
	type Cfg = {
		name?: string
		volumes?: unknown[]
		build?: unknown
		top?: Record<string, unknown>
		running?: string[]
		runningVolumeDevices?: string[]
		interpolated?: unknown
		app?: string
		checkName?: boolean
	}
	const guard = (c: Cfg = {}) => {
		const doc = {
			name: c.name ?? 'shop',
			services: {
				shop: {
					...(c.build ? { build: c.build } : {}),
					image: 'shop',
					...(c.volumes ? { volumes: c.volumes } : {}),
				},
			},
			...(c.top ?? {}),
		}
		writeFileSync(json, JSON.stringify(doc, null, 2))
		writeFileSync(json2, JSON.stringify(c.interpolated ?? doc, null, 2))
		writeFileSync(join(root, 'ps.txt'), c.running?.length ? 'cid1\n' : '')
		writeFileSync(join(root, 'mounts.txt'), (c.running ?? []).map((m) => `${m}\n`).join(''))
		writeFileSync(
			join(root, 'vdev.txt'),
			(c.runningVolumeDevices ?? []).map((m) => `${m}\n`).join(''),
		)
		if (c.runningVolumeDevices?.length) writeFileSync(join(root, 'ps.txt'), 'cid1\n')
		const r = spawnSync(
			'bash',
			[
				'-c',
				`set -e; ${bindLinkGuardShell(`-f '${compose}'`, c.app ?? 'shop', join(apps, 'shop'), apps, c.checkName ?? true)} && echo PASSED`,
			],
			{
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			},
		)
		return {
			ok: r.status === 0 && r.stdout.toString().includes('PASSED'),
			out: r.stdout.toString() + r.stderr.toString(),
		}
	}

	it('passes the common shapes: binds in the app dir, under <base>/<app>-*, under /var, a build-env secret, with the base itself a link', () => {
		const r = guard({
			volumes: [
				bind(join(apps, 'shop', 'data')),
				bind(join(apps, 'shop-uploads')),
				bind(join(root, 'var', 'shop-content')),
				bind(join(apps, 'shop', 'missing', 'deeper'), true),
			],
			build: { context: join(apps, 'shop', 'src'), dockerfile: 'Dockerfile' },
			top: { secrets: { env: { file: join(apps, 'shop.build-env') } } },
		})
		expect(r.out).not.toContain('refusing')
		expect(r.ok).toBe(true)
	})
	it('passes the same paths in their resolved (volume) form and a missing source', () => {
		expect(
			guard({ volumes: [bind(join(vol, 'shop', 'data')), bind(join(apps, 'shop', 'nope', 'x'))] })
				.ok,
		).toBe(true)
	})
	it('refuses a bind through a container-planted link (data/r -> /)', () => {
		const r = guard({ volumes: [bind(join(apps, 'shop', 'data', 'r'), true)] })
		expect(r.ok).toBe(false)
		expect(r.out).toContain('goes through the symlink')
	})
	it('refuses a path below the planted link too, and a driver_opts device through it', () => {
		expect(guard({ volumes: [bind(join(apps, 'shop', 'data', 'r', 'etc'))] }).ok).toBe(false)
		expect(
			guard({
				top: {
					volumes: {
						v: {
							driver: 'local',
							driver_opts: { type: 'none', o: 'bind', device: join(apps, 'shop', 'data', 'r') },
						},
					},
				},
			}).ok,
		).toBe(false)
	})
	it('allows an in-repo dockerfile link that stays in the app, refuses one that leaves it', () => {
		expect(
			guard({ build: { context: join(apps, 'shop', 'src'), dockerfile: 'Dockerfile' } }).ok,
		).toBe(true)
		expect(
			guard({ build: { context: join(apps, 'shop', 'src'), dockerfile: 'etc/passwd' } }).ok,
		).toBe(false)
		expect(
			guard({
				build: {
					context: join(apps, 'shop', 'src'),
					additional_contexts: { x: join(apps, 'shop', 'src', 'etc'), y: 'docker-image://alpine' },
				},
			}).ok,
		).toBe(false)
	})
	it('refuses an in-repo link when the folder is a writable bind', () => {
		const r = guard({
			volumes: [bind(join(apps, 'shop', 'src'))],
			build: { context: join(apps, 'shop', 'src'), dockerfile: 'Dockerfile' },
		})
		expect(r.ok).toBe(false)
	})
	it('refuses a secret file through a link out of the app', () => {
		expect(
			guard({ top: { secrets: { s: { file: join(apps, 'shop', 'src', 'etc', 'shadow') } } } }).ok,
		).toBe(false)
	})
	it('refuses a mount source inside another writable bind (new config or a running container), not the same one', () => {
		expect(
			guard({
				volumes: [bind(join(apps, 'shop', 'data')), bind(join(apps, 'shop', 'data', 'sub'), true)],
			}).out,
		).toContain('sits inside')
		expect(
			guard({
				volumes: [bind(join(apps, 'shop', 'data', 'sub'))],
				running: [join(vol, 'shop', 'data')],
			}).ok,
		).toBe(false)
		expect(
			guard({ volumes: [bind(join(apps, 'shop', 'data')), bind(join(apps, 'shop', 'data'), true)] })
				.ok,
		).toBe(true)
		expect(
			guard({
				volumes: [
					bind(join(apps, 'shop', 'data'), true),
					bind(join(apps, 'shop', 'data', 'sub'), true),
				],
			}).ok,
		).toBe(true)
	})
	it('reads a source built from a variable from the interpolated config', () => {
		const interpolated = {
			name: 'shop',
			services: { shop: { image: 'shop', volumes: [bind(join(apps, 'shop', 'data', 'r'))] } },
		}
		expect(guard({ volumes: [bind('${DATA}/r')], interpolated }).ok).toBe(false)
		const fine = {
			name: 'shop',
			services: { shop: { image: 'shop', volumes: [bind(join(apps, 'shop', 'data'))] } },
		}
		expect(guard({ volumes: [bind('${DATA}')], interpolated: fine }).ok).toBe(true)
	})
	it('refuses odd characters, relative paths and dot components', () => {
		expect(guard({ volumes: [bind(`${apps}/shop/a"b`)] }).out).toContain('cannot check the path')
		expect(guard({ volumes: [bind('shop/data')] }).out).toContain('not absolute')
		expect(guard({ volumes: [bind(`${apps}/shop/../x`)] }).out).toContain('. or .. component')
	})
	it('refuses a compose project name other than the app name', () => {
		const r = guard({ name: 'web' })
		expect(r.ok).toBe(false)
		expect(r.out).toContain("not 'shop' (the app name shop")
	})
	it('compares against the name compose derives from the app name (dots, uppercase)', () => {
		expect(guard({ name: 'shopcom', app: 'Shop.com' }).ok).toBe(true)
		expect(guard({ name: 'shop.com', app: 'Shop.com' }).ok).toBe(false)
	})
	it('skips the name check when the caller cannot name the app', () => {
		expect(guard({ name: 'web', checkName: false }).ok).toBe(true)
	})
	it('a named-volume bind device counts as a writable bind (new config and running volumes)', () => {
		const dev = {
			v: { driver_opts: { type: 'none', o: 'bind', device: join(apps, 'shop', 'data') } },
		}
		expect(
			guard({ top: { volumes: dev }, volumes: [bind(join(apps, 'shop', 'data', 'sub'), true)] })
				.out,
		).toContain('sits inside')
		expect(
			guard({
				volumes: [bind(join(apps, 'shop', 'data', 'sub'), true)],
				runningVolumeDevices: [join(vol, 'shop', 'data')],
			}).out,
		).toContain('sits inside')
		expect(guard({ top: { volumes: dev } }).ok).toBe(true)
	})
	it('refuses every local build cache entry (any case), keeps registry caches', () => {
		const build = (spec: string) => ({
			context: join(apps, 'shop', 'src'),
			dockerfile: 'Dockerfile',
			cache_to: [spec],
		})
		for (const spec of [
			`type=local,src=${join(apps, 'shop', 'c1')},dest=${join(apps, 'shop', 'c2')}`,
			'type=local,dest=./cache',
			'TYPE=local,DEST=/etc/x',
			"type=Local,'dest=/etc/x'",
			'ref=x/y,Dest=/etc/x',
		]) {
			const r = guard({ build: build(spec) })
			expect(r.ok, spec).toBe(false)
			expect(r.out).toContain('is a local cache')
		}
		expect(guard({ build: build('type=registry,ref=x/y') }).ok).toBe(true)
	})
	it('runs under bash -o pipefail (the composeUpCommand shell)', () => {
		writeFileSync(
			json,
			JSON.stringify(
				{
					name: 'shop',
					services: { shop: { image: 'shop', volumes: [bind(join(apps, 'shop', 'data'))] } },
				},
				null,
				2,
			),
		)
		writeFileSync(
			json2,
			JSON.stringify({ name: 'shop', services: { shop: { image: 'shop' } } }, null, 2),
		)
		const r = spawnSync(
			'bash',
			[
				'-o',
				'pipefail',
				'-c',
				`${bindLinkGuardShell(`-f '${compose}'`, 'shop', join(apps, 'shop'), apps)} && echo PASSED`,
			],
			{
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			},
		)
		expect(r.stdout.toString()).toContain('PASSED')
	})
})

describe('COMPOSE_JSON_MOUNTS_AWK', () => {
	const run = (doc: unknown) =>
		spawnSync('awk', [COMPOSE_JSON_MOUNTS_AWK], {
			input: JSON.stringify(doc, null, 2),
			encoding: 'utf8',
		})
			.stdout.trim()
			.split('\n')
			.filter(Boolean)
	it('prints binds, build paths, secrets, configs and devices', () => {
		expect(
			run({
				name: 'shop',
				services: {
					web: {
						build: {
							context: '/opt/apps/shop/src',
							dockerfile: 'Dockerfile',
							args: { A: '/not/a/path' },
							additional_contexts: { a: '/opt/apps/shop/lib', b: 'service:x' },
						},
						volumes: [
							{
								type: 'bind',
								source: '/opt/apps/shop/data',
								target: '/d',
								bind: { create_host_path: true },
							},
							{ type: 'bind', source: '/opt/apps/shop-files', target: '/f', read_only: true },
							{ type: 'volume', source: 'v', target: '/v' },
						],
					},
				},
				volumes: {
					v: {
						name: 'shop_v',
						driver_opts: { type: 'none', o: 'bind', device: '/opt/apps/shop/v' },
					},
					t: { driver_opts: { type: 'tmpfs', device: 'tmpfs' } },
				},
				secrets: { s: { file: '/opt/apps/shop.build-env', name: 'shop_s' } },
				configs: { c: { file: '/opt/apps/shop/c.conf' } },
			}),
		).toEqual([
			'N shop',
			'C /opt/apps/shop/lib',
			'C /opt/apps/shop/src',
			'C /opt/apps/shop/src/Dockerfile',
			'B /opt/apps/shop/data',
			'W /opt/apps/shop/data',
			'B /opt/apps/shop-files',
			'O /opt/apps/shop/v',
			'W /opt/apps/shop/v',
			'D 0\t\ttype=none;o=bind;device=/opt/apps/shop/v;\tshop_v',
			'D 0\t\ttype=tmpfs;device=tmpfs;\tshop_t',
			'S /opt/apps/shop.build-env',
			'S /opt/apps/shop/c.conf',
		])
	})
})

describe('the bind guard runs wherever the env file guard runs', () => {
	it('composeUpCommand and the deploy script el_guard', () => {
		expect(composeUpCommand('/opt/apps/a/docker-compose.yml', 'a', '/opt/apps/a', { approval: { hash: '', app: null, log: '' } })).toContain(
			'bind guard: refusing',
		)
		const s = buildDeployScript({
			workingDir: '/opt/apps/a',
			configFile: '/opt/apps/a/docker-compose.yml',
			service: 'a',
			cf: "-f '/opt/apps/a/docker-compose.yml'",
			declaredMode: 'build',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		const def = s.slice(s.indexOf('el_guard() {'), s.indexOf('release_restore() {'))
		expect(def).toContain('env file guard: refusing')
		expect(def).toContain('bind guard: refusing')
	})
})
