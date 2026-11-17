// ONE writable set ("the folders a container can write") for every on-server guard
// (pw_wset, writableSetFnShell in deploy/fragments.ts) and its TypeScript twin
// (writableFoldersOf, compose-safety.ts). A set built from bind mounts only would
// miss a named volume bound to a host folder (docker inspect: type volume): an old
// container mounting volume `conf` (device <app>/conf) could
// swap ./conf/x.env for a link to another app's env file between the guard and compose.
// the guards fail closed when docker cannot list or read the containers.
// Real bash, a fake docker. Invented app names only.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeViolations, writableFoldersOf } from '../compose-safety'
import { serverWritableOf, deployGuardContext, parseDetailProbe } from '../deploy/compose-check'
import { bindLinkGuardShell, envFileLinkGuardShell, writableSetFnShell } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

const FAKE_DOCKER = String.raw`#!/bin/sh
D=__D__
cmd=$1; shift
case "$cmd" in
ps)
  [ -f "$D/ps-fails" ] && exit 1
  filt=""
  for a in "$@"; do case "$a" in label=*) filt="$filt $a";; esac; done
  [ -f "$D/containers" ] || exit 0
  while read -r id proj; do
    [ -n "$id" ] || continue
    ok=1
    for f in $filt; do case "$f" in
      label=com.docker.compose.project) [ "$proj" != - ] || ok=0;;
      label=com.docker.compose.project=*) [ "$proj" = "${"${"}f#label=com.docker.compose.project=}" ] || ok=0;;
    esac; done
    [ "$ok" = 1 ] && echo "$id"
  done < "$D/containers"
  exit 0;;
inspect)
  [ -f "$D/inspect-fails" ] && exit 1
  fmt=""; ids=""
  while [ $# -gt 0 ]; do case "$1" in --format) fmt=$2; shift 2;; --) shift;; *) ids="$ids $1"; shift;; esac; done
  for id in $ids; do
    case "$fmt" in
      *'eq .Type "bind"'*) [ -f "$D/rwbind-$id" ] && cat "$D/rwbind-$id";;
      *'eq .Type "volume"'*) [ -f "$D/vols-$id" ] && cat "$D/vols-$id";;
    esac
  done
  exit 0;;
volume)
  if [ "$1" = ls ]; then ls "$D/vol"; exit 0; fi
  shift
  fmt=""; names=""
  while [ $# -gt 0 ]; do case "$1" in --format) fmt=$2; shift 2;; --) shift;; *) names="$names $1"; shift;; esac; done
  rc=0
  for n in $names; do
    V="$D/vol/$n"
    [ -d "$V" ] || { rc=1; continue; }
    case "$fmt" in
      *'{{$k}}={{$v}}'*) printf '%s\t%s' "$(cat "$V/driver")" "$(cat "$V/opts")";;
      *'println'*) [ -s "$V/device" ] && cat "$V/device" && echo;;
      *'"device"'*) [ -f "$V/device" ] && cat "$V/device";;
      *'"o"'*) [ -f "$V/o" ] && cat "$V/o";;
    esac
  done
  exit $rc;;
compose)
  case "$*" in *no-interpolate*) cat "$D/cfg.json";; *config\ --services*) echo shop;; *) cat "$D/cfg.json";; esac
  exit 0;;
esac
exit 0
`

describe('one writable set for every guard (shell, fake docker)', () => {
	let root: string
	let apps: string
	let D: string
	let bin: string
	let compose: string
	let wd: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'wset-')))
		apps = join(root, 'apps')
		wd = join(apps, 'shop')
		for (const d of ['conf', 'data', 'dev']) mkdirSync(join(wd, d), { recursive: true })
		mkdirSync(join(apps, 'shop-uploads'), { recursive: true })
		mkdirSync(join(apps, 'mill', 'files'), { recursive: true })
		mkdirSync(join(apps, 'mill', 'cache'), { recursive: true })
		writeFileSync(join(wd, 'conf', 'x.env'), 'A=1\n')
		D = join(root, 'd')
		bin = join(root, 'bin')
		mkdirSync(bin)
		compose = join(wd, 'docker-compose.yml')
		writeFileSync(compose, 'services:\n  shop:\n    image: shop\n')
		writeFakeDocker(bin, FAKE_DOCKER.replace('__D__', JSON.stringify(D)))
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	beforeEach(() => {
		rmSync(D, { recursive: true, force: true })
		mkdirSync(join(D, 'vol'), { recursive: true })
	})

	const cfg = (doc: Record<string, unknown>) => writeFileSync(join(D, 'cfg.json'), JSON.stringify({ name: 'shop', ...doc }, null, 2))
	/** id project ('-' = no compose label) */
	const containers = (rows: string[]) => writeFileSync(join(D, 'containers'), `${rows.join('\n')}\n`)
	const serverVolume = (name: string, device?: string) => {
		const dir = join(D, 'vol', name)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'driver'), 'local')
		writeFileSync(join(dir, 'opts'), device ? `device=${device};o=bind;type=none;` : '')
		if (device) {
			writeFileSync(join(dir, 'device'), device)
			writeFileSync(join(dir, 'o'), 'bind')
		}
	}
	const run = (shell: string) => {
		const r = spawnSync('bash', ['-c', `cd ${JSON.stringify(wd)}; ${shell} && echo PASSED`], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		const out = r.stdout.toString() + r.stderr.toString()
		return { ok: r.status === 0 && out.includes('PASSED'), out }
	}
	const cf = () => `-f '${compose}'`
	const envGuard = (trace?: string) =>
		run(envFileLinkGuardShell(cf(), 'shop', wd, undefined, { appsBase: apps, ...(trace ? { wsetTrace: trace } : {}) }))
	const bindGuard = (trace?: string) =>
		run(bindLinkGuardShell(cf(), 'shop', wd, apps, true, trace ? { wsetTrace: trace } : {}))
	const confVolume = () => ({ conf: { name: 'shop_conf', driver: 'local', driver_opts: { type: 'none', o: 'bind', device: join(wd, 'conf') } } })

	describe('the env file guard sees named volumes bound to a host folder', () => {
		it('deploy 1 / deploy 2: an old container mounting volume conf (device ./conf) makes ./conf/x.env refused', () => {
			// deploy 1: a side service mounts the device-bound volume; no env file there yet
			cfg({ services: { shop: { image: 'shop' }, side: { image: 'alpine', volumes: [{ type: 'volume', source: 'conf', target: '/conf' }] } }, volumes: confVolume() })
			expect(envGuard().ok).toBe(true)
			// what deploy 1 left on the server: the exited side container and the volume
			containers(['c1 shop', 'c2 shop'])
			writeFileSync(join(D, 'vols-c1'), 'shop_conf\n')
			serverVolume('shop_conf', join(wd, 'conf'))
			// deploy 2: the volume is gone from the config; the app reads ./conf/x.env
			cfg({ services: { shop: { image: 'shop', env_file: [{ path: join(wd, 'conf', 'x.env'), required: true }] }, side: { image: 'alpine' } } })
			const r = envGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain(`writable bind of ${join(wd, 'conf')}`)
		})
		it('the same with the volume still declared and no container left (the server copy of a declared volume)', () => {
			serverVolume('shop_conf', join(wd, 'conf'))
			cfg({ services: { shop: { image: 'shop', env_file: [{ path: join(wd, 'conf', 'x.env'), required: true }] } }, volumes: confVolume() })
			expect(envGuard().ok).toBe(false)
			// a volume of the config bound elsewhere, and a read-only mount of conf, pass
			cfg({ services: { shop: { image: 'shop', env_file: [{ path: join(wd, 'conf', 'x.env'), required: true }] } } })
			containers(['c1 shop'])
			writeFileSync(join(D, 'vols-c1'), '')
			expect(envGuard().ok).toBe(true)
		})
	})

	describe('both guards get the identical set', () => {
		it('every part (a)-(d) lands in the env file guard and the bind guard alike', () => {
			cfg({
				services: {
					shop: {
						image: 'shop',
						volumes: [
							{ type: 'bind', source: join(wd, 'data'), target: '/data' },
							{ type: 'bind', source: join(wd, 'conf'), target: '/conf', read_only: true },
							{ type: 'volume', source: 'dev', target: '/dev2' },
							{ type: 'volume', source: 'old', target: '/old' },
						],
					},
				},
				volumes: {
					dev: { name: 'shop_dev', driver: 'local', driver_opts: { type: 'none', o: 'bind', device: join(wd, 'dev') } },
					old: { name: 'shop_old' },
				},
			})
			// (c) another project's exited container: a writable bind and a device-bound volume
			containers(['m1 mill', 'h1 -'])
			writeFileSync(join(D, 'rwbind-m1'), `${join(apps, 'mill', 'files')}\n`)
			writeFileSync(join(D, 'vols-m1'), 'mill_cache\n')
			serverVolume('mill_cache', join(apps, 'mill', 'cache'))
			// a container with no compose project does not count
			writeFileSync(join(D, 'rwbind-h1'), '/srv/hand\n')
			// (d) the server copy of a declared volume binds a folder the config does not name
			serverVolume('shop_old', join(apps, 'shop-uploads'))
			const t1 = join(root, 'trace-env')
			const t2 = join(root, 'trace-bind')
			envGuard(t1)
			bindGuard(t2)
			const a = readFileSync(t1, 'utf8')
			const b = readFileSync(t2, 'utf8')
			expect(a).toBe(b)
			const set = a.split('\n').filter(Boolean)
			expect(set).toEqual(
				[join(apps, 'mill', 'cache'), join(apps, 'mill', 'files'), join(apps, 'shop-uploads'), join(wd, 'data'), join(wd, 'dev')].sort(),
			)
			// the TypeScript twin: the same set from the config and the probe's view of the server
			const details = parseDetailProbe(
				[
					`/mill-1\tmill\tmill\tsha256:a\t{}\t${JSON.stringify([
						{ Type: 'bind', Source: join(apps, 'mill', 'files'), RW: true },
						{ Type: 'volume', Name: 'mill_cache', Source: '/var/lib/docker/volumes/mill_cache/_data', RW: true },
					])}`,
					`/hand\t\talpine\tsha256:b\t{}\t${JSON.stringify([{ Type: 'bind', Source: '/srv/hand', RW: true }])}`,
				].join('\n'),
			)
			const volumeDevices = { mill_cache: join(apps, 'mill', 'cache'), shop_old: join(apps, 'shop-uploads'), shop_dev: join(wd, 'dev') }
			const serverWritable = serverWritableOf({ details, volumeDevices })
			const doc = JSON.parse(readFileSync(join(D, 'cfg.json'), 'utf8'))
			expect(
				writableFoldersOf(doc, { appName: 'shop', projectDir: wd, serverWritable, serverVolumeDevices: volumeDevices } as never),
			).toEqual(set)
		})
	})

	describe('fail closed when docker cannot be read', () => {
		it('docker ps failing refuses both guards (never read as "no container")', () => {
			cfg({ services: { shop: { image: 'shop' } } })
			expect(envGuard().ok).toBe(true)
			expect(bindGuard().ok).toBe(true)
			writeFileSync(join(D, 'ps-fails'), '')
			const e = envGuard()
			expect(e.ok).toBe(false)
			expect(e.out).toContain('env file guard: refusing, cannot list the containers on this server (docker ps failed)')
			const b = bindGuard()
			expect(b.ok).toBe(false)
			expect(b.out).toContain('bind guard: refusing, cannot list the containers of the compose project shop (docker ps failed)')
		})
		it('docker inspect failing (twice) refuses both guards', () => {
			cfg({ services: { shop: { image: 'shop' } } })
			containers(['c1 shop'])
			writeFileSync(join(D, 'inspect-fails'), '')
			expect(envGuard().out).toContain('cannot read the bind mounts of the containers on this server')
			expect(bindGuard().ok).toBe(false)
		})
	})

	it('the shell function is one text, used by both guards', () => {
		const fn = writableSetFnShell()
		const e = envFileLinkGuardShell(cf(), 'shop', wd)
		const b = bindLinkGuardShell(cf(), 'shop', wd)
		expect(e).toContain(fn)
		expect(b).toContain(fn)
		// neither guard lists containers for its writable set on its own
		for (const g of [e, b].map((s) => s.replace(fn, '')))
			expect(g).not.toMatch(/docker ps -aq --filter "label=com\.docker\.compose\.project" /)
	})
})

describe('TypeScript twin: env_file in a folder a container can write', () => {
	const input = (mounts: unknown[], volumeDevices: Record<string, string> = {}) => ({
		resolved: {},
		raw: null,
		hash: 'x',
		containers: [{ name: 'shop-side-1', image: 'alpine', project: 'shop', state: 'exited' }],
		details: parseDetailProbe(`/shop-side-1\tshop\talpine\tsha256:a\t{}\t${JSON.stringify(mounts)}`),
		volumeDevices,
	})
	const ctxOf = (i: ReturnType<typeof input>) =>
		deployGuardContext(i as never, {
			appName: 'shop',
			workingDir: '/opt/apps/shop',
			composeFiles: ['/opt/apps/shop/docker-compose.yml'],
			serverId: 's1',
			routeHosts: null,
			otherApps: ['mill'],
			envTarget: '/opt/apps/shop.env',
		})
	const doc = {
		name: 'shop',
		services: { shop: { image: 'shop', env_file: [{ path: '/opt/apps/shop/conf/x.env', required: true }] } },
	}
	const envFindings = (i: ReturnType<typeof input>) => composeViolations(doc, ctxOf(i)).filter((v) => v.code === 'env_file')
	it('refuses when a container of the project mounts a volume bound to the env file folder', () => {
		const f = envFindings(input([{ Type: 'volume', Name: 'shop_conf', RW: true }], { shop_conf: '/opt/apps/shop/conf' }))
		expect(f.map((v) => v.message).join('\n')).toContain('sits in /opt/apps/shop/conf, a folder a container can write')
	})
	it('a read-only mount, a volume without a device, and no container mounts pass', () => {
		expect(envFindings(input([{ Type: 'volume', Name: 'shop_conf', RW: false }], { shop_conf: '/opt/apps/shop/conf' }))).toEqual([])
		expect(envFindings(input([{ Type: 'volume', Name: 'shop_conf', RW: true }]))).toEqual([])
		expect(envFindings(input([]))).toEqual([])
	})
})
