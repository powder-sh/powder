// the bind guard inspects the server copy of every named volume the config uses (a
// device it binds is walked like a bind source; an existing volume whose driver or
// options differ from the config's is refused, since compose keeps the old one).
// the writable-bind set W of the env file and bind guards counts containers of
// any compose project in any state, and the infra `up --no-recreate` is refused when an
// existing infra container mounts what the checked config does not give it.
// Real bash, a fake docker. Invented app names only.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { COMPOSE_JSON_SVC_MOUNTS_AWK, bindLinkGuardShell, envFileLinkGuardShell, infraMountGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

const FAKE_DOCKER = String.raw`#!/bin/sh
D=__D__
cmd=$1; shift
case "$cmd" in
ps)
  all=0; filt=""
  for a in "$@"; do case "$a" in -a|-aq) all=1;; label=*) filt="$filt $a";; esac; done
  [ -f "$D/containers" ] || exit 0
  while read -r id state proj svc; do
    [ -n "$id" ] || continue
    [ "$state" = running ] || [ "$all" = 1 ] || continue
    ok=1
    for f in $filt; do case "$f" in
      label=com.docker.compose.project) [ "$proj" != - ] || ok=0;;
      label=com.docker.compose.project=*) [ "$proj" = "${"${"}f#label=com.docker.compose.project=}" ] || ok=0;;
      label=com.docker.compose.service=*) [ "$svc" = "${"${"}f#label=com.docker.compose.service=}" ] || ok=0;;
    esac; done
    [ "$ok" = 1 ] && echo "$id"
  done < "$D/containers"
  exit 0;;
inspect)
  fmt=""; ids=""
  while [ $# -gt 0 ]; do case "$1" in --format) fmt=$2; shift 2;; --) shift;; *) ids="$ids $1"; shift;; esac; done
  for id in $ids; do
    case "$fmt" in
      *'{{.Name}}{{println}}'*) cat "$D/im-$id" || exit 1;;
      *'eq .Type "bind"'*) [ -f "$D/rwbind-$id" ] && cat "$D/rwbind-$id";;
      *'eq .Type "volume"'*) [ -f "$D/vols-$id" ] && cat "$D/vols-$id";;
    esac
  done
  exit 0;;
volume)
  if [ "$1" = ls ]; then [ -f "$D/vol-ls-fails" ] && exit 1; ls "$D/vol"; exit 0; fi
  shift
  fmt=""; names=""
  while [ $# -gt 0 ]; do case "$1" in --format) fmt=$2; shift 2;; --) shift;; *) names="$names $1"; shift;; esac; done
  rc=0
  for n in $names; do
    V="$D/vol/$n"
    [ -d "$V" ] && [ ! -f "$V/broken" ] || { rc=1; continue; }
    case "$fmt" in
      *'{{$k}}={{$v}}'*) printf '%s\t%s' "$(cat "$V/driver")" "$(cat "$V/opts")";;
      *';{{$k}}'*) printf '%s%s' "$(cat "$V/driver")" "$(cat "$V/anon" 2>/dev/null)";;
      *'println'*) [ -s "$V/device" ] && cat "$V/device" && echo;;
      *'"device"'*) [ -f "$V/device" ] && cat "$V/device";;
      *'"o"'*) [ -f "$V/o" ] && cat "$V/o";;
    esac
  done
  exit $rc;;
compose)
  case "$*" in *no-interpolate*) cat "$D/cfg.json";; *config\ --services*) echo shop;; *) cat "$D/cfg2.json";; esac
  exit 0;;
esac
exit 0
`

describe('volume and infra guards (shell, fake docker)', () => {
	let root: string
	let apps: string
	let D: string
	let bin: string
	let compose: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'guards-')))
		apps = join(root, 'apps')
		mkdirSync(join(apps, 'shop', 'data'), { recursive: true })
		mkdirSync(join(apps, 'shop', 'conf'), { recursive: true })
		mkdirSync(join(apps, 'shop-w', 'sub'), { recursive: true })
		mkdirSync(join(apps, 'shop-w2'), { recursive: true })
		symlinkSync('/', join(apps, 'shop-w2', 'sub'))
		writeFileSync(join(apps, 'shop', 'conf', 'app.env'), 'A=1\n')
		D = join(root, 'd')
		bin = join(root, 'bin')
		mkdirSync(bin)
		compose = join(apps, 'shop', 'docker-compose.yml')
		writeFileSync(compose, 'services:\n  shop:\n    image: shop\n')
		writeFakeDocker(bin, FAKE_DOCKER.replace('__D__', JSON.stringify(D)))
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	beforeEach(() => {
		rmSync(D, { recursive: true, force: true })
		mkdirSync(join(D, 'vol'), { recursive: true })
	})

	const bind = (source: string, ro = false, target = '/x') => ({
		type: 'bind',
		source,
		target,
		...(ro ? { read_only: true } : {}),
	})
	const cfg = (services: Record<string, unknown>, top: Record<string, unknown> = {}) => {
		const doc = JSON.stringify({ name: 'shop', services, ...top }, null, 2)
		writeFileSync(join(D, 'cfg.json'), doc)
		writeFileSync(join(D, 'cfg2.json'), doc)
	}
	/** id state project service; project '-' = no compose label */
	const containers = (rows: string[]) => writeFileSync(join(D, 'containers'), `${rows.join('\n')}\n`)
	const serverVolume = (name: string, v: { driver?: string; opts?: string; device?: string; o?: string; anon?: string }) => {
		const dir = join(D, 'vol', name)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'driver'), v.driver ?? 'local')
		writeFileSync(join(dir, 'opts'), v.opts ?? '')
		if (v.device !== undefined) writeFileSync(join(dir, 'device'), v.device)
		if (v.o !== undefined) writeFileSync(join(dir, 'o'), v.o)
		if (v.anon !== undefined) writeFileSync(join(dir, 'anon'), v.anon)
	}
	const run = (shell: string) => {
		const r = spawnSync('bash', ['-c', `cd ${JSON.stringify(join(apps, 'shop'))}; ${shell} && echo PASSED`], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		const out = r.stdout.toString() + r.stderr.toString()
		return { ok: r.status === 0 && out.includes('PASSED'), out }
	}
	const bindGuard = () => run(bindLinkGuardShell(`-f '${compose}'`, 'shop', join(apps, 'shop'), apps))
	const envGuard = () => run(envFileLinkGuardShell(`-f '${compose}'`, 'shop', join(apps, 'shop')))
	const infraGuard = (svcs = 'db') => run(infraMountGuardShell(`-f '${compose}'`, svcs))

	describe('named volume server copies (bind guard)', () => {
		it('refuses an external volume whose server copy binds a folder inside a writable bind (the deploy-0 / deploy-1 attack)', () => {
			cfg(
				{ shop: { image: 'shop', volumes: [bind(join(apps, 'shop-w')), { type: 'volume', source: 'v', target: '/v' }] } },
				{ volumes: { v: { name: 'shop_v', external: true } } },
			)
			const dev = join(apps, 'shop-w', 'sub')
			serverVolume('shop_v', { opts: `device=${dev};o=bind;type=none;`, device: dev, o: 'bind' })
			const r = bindGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain(`${dev} sits inside ${join(apps, 'shop-w')}`)
		})
		it('refuses a server volume device that goes through a symlink (container-planted link to /)', () => {
			cfg(
				{ shop: { image: 'shop', volumes: [{ type: 'volume', source: 'v', target: '/v' }] } },
				{ volumes: { v: { name: 'shop_v', external: true } } },
			)
			const dev = join(apps, 'shop-w2', 'sub')
			serverVolume('shop_v', { opts: `device=${dev};o=bind;type=none;`, device: dev, o: 'bind' })
			const r = bindGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain('goes through the symlink')
		})
		it('refuses an existing volume whose options differ from the config (compose would keep the old one)', () => {
			cfg(
				{ shop: { image: 'shop', volumes: [{ type: 'volume', source: 'v', target: '/v' }] } },
				{ volumes: { v: { name: 'shop_v', driver_opts: { device: join(apps, 'shop', 'data'), o: 'bind', type: 'none' } } } },
			)
			const dev = join(apps, 'shop-w', 'sub')
			serverVolume('shop_v', { opts: `device=${dev};o=bind;type=none;`, device: dev, o: 'bind' })
			const r = bindGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain('already exists on this server')
			// the same options pass
			serverVolume('shop_v', { opts: `device=${join(apps, 'shop', 'data')};o=bind;type=none;`, device: join(apps, 'shop', 'data'), o: 'bind' })
			expect(bindGuard().ok).toBe(true)
		})
		it('refuses an existing plain volume when the config adds driver_opts, and a driver change', () => {
			cfg(
				{ shop: { image: 'shop', volumes: [{ type: 'volume', source: 'v', target: '/v' }] } },
				{ volumes: { v: { name: 'shop_v', driver_opts: { type: 'tmpfs', device: 'tmpfs' } } } },
			)
			serverVolume('shop_v', {})
			expect(bindGuard().out).toContain('already exists on this server')
			cfg({ shop: { image: 'shop', volumes: [{ type: 'volume', source: 'v', target: '/v' }] } }, { volumes: { v: { name: 'shop_v' } } })
			serverVolume('shop_v', { driver: 'nfsplug' })
			expect(bindGuard().out).toContain("driver 'nfsplug'")
		})
		it('common shapes pass: external volumes without a device, a plain existing volume, a volume not created yet', () => {
			cfg(
				{
					shop: { image: 'shop', volumes: [{ type: 'volume', source: 'up', target: '/up' }, { type: 'volume', source: 'pg', target: '/pg' }] },
				},
				{ volumes: { up: { name: 'acmestack_shop-uploads', external: true }, pg: { name: 'shop_pg' }, fresh: { name: 'shop_fresh' } } },
			)
			serverVolume('acmestack_shop-uploads', {})
			serverVolume('shop_pg', {})
			const r = bindGuard()
			expect(r.out).not.toContain('refusing')
			expect(r.ok).toBe(true)
		})
		it('a server volume device counts as a writable bind: a bind inside it is refused', () => {
			cfg(
				{ shop: { image: 'shop', volumes: [bind(join(apps, 'shop', 'data', 'sub'), true), { type: 'volume', source: 'v', target: '/v' }] } },
				{ volumes: { v: { name: 'shop_v', external: true } } },
			)
			const dev = join(apps, 'shop', 'data')
			serverVolume('shop_v', { opts: `device=${dev};o=bind;type=none;`, device: dev, o: 'bind' })
			const r = bindGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain(`${join(apps, 'shop', 'data', 'sub')} sits inside ${dev}`)
		})
		it('an inspect failure counts as "not created yet" only when the volume list lacks the name', () => {
			cfg({ shop: { image: 'shop', volumes: [{ type: 'volume', source: 'v', target: '/v' }] } }, { volumes: { v: { name: 'shop_v' } } })
			expect(bindGuard().ok).toBe(true)
			serverVolume('shop_v', {})
			writeFileSync(join(D, 'vol', 'shop_v', 'broken'), '')
			const r = bindGuard()
			expect(r.ok).toBe(false)
			// the writable set (pw_wset) reads the server copy first and fails closed
			expect(r.out).toContain('cannot read the options of the volumes shop_v')
			rmSync(join(D, 'vol', 'shop_v'), { recursive: true })
			writeFileSync(join(D, 'vol-ls-fails'), '')
			expect(bindGuard().out).toContain('cannot list the volumes on this server (docker volume ls failed)')
		})
		it('walks the device of a volume an exited container of the project mounts', () => {
			cfg({ shop: { image: 'shop' } })
			containers(['c1 exited shop db'])
			writeFileSync(join(D, 'vols-c1'), 'shop_old\n')
			const dev = join(apps, 'shop-w2', 'sub')
			serverVolume('shop_old', { opts: `device=${dev};o=bind;type=none;`, device: dev, o: 'bind' })
			expect(bindGuard().out).toContain('goes through the symlink')
		})
	})

	describe('W counts every compose project in any state', () => {
		it('an exited container of the project with a rw bind of the parent folder refuses a subpath bind', () => {
			cfg({ shop: { image: 'shop', volumes: [bind(join(apps, 'shop', 'data', 'sub'), true)] } })
			containers(['c1 exited shop worker'])
			writeFileSync(join(D, 'rwbind-c1'), `${join(apps, 'shop', 'data')}\n`)
			const r = bindGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain('sits inside')
			// no compose label: not counted (an exited container with binds may have none)
			containers(['c1 exited - -'])
			expect(bindGuard().ok).toBe(true)
		})
		it('a container of ANOTHER compose project counts too', () => {
			cfg({ shop: { image: 'shop', volumes: [bind(join(apps, 'shop', 'data', 'sub'), true)] } })
			containers(['c9 running acme web'])
			writeFileSync(join(D, 'rwbind-c9'), `${join(apps, 'shop', 'data')}\n`)
			expect(bindGuard().out).toContain('sits inside')
		})
		it('env file guard: an env file in a folder an exited container binds rw is refused', () => {
			cfg({ shop: { image: 'shop', env_file: [join(apps, 'shop', 'conf', 'app.env')] } })
			containers(['c1 exited shop worker'])
			writeFileSync(join(D, 'rwbind-c1'), `${join(apps, 'shop', 'conf')}\n`)
			const r = envGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain('can write (writable bind of')
			rmSync(join(D, 'rwbind-c1'))
			expect(envGuard().ok).toBe(true)
		})
	})

	describe('infra mount guard', () => {
		const dbCfg = (ro = false) =>
			cfg(
				{
					shop: { image: 'shop' },
					db: {
						image: 'postgres:17',
						volumes: [bind(join(apps, 'shop', 'pg'), ro, '/var/lib/postgresql/data'), { type: 'volume', source: 'cache', target: '/cache' }],
					},
				},
				{ volumes: { cache: { name: 'shop_cache' } } },
			)
		const mounts = (id: string, name: string, rows: Array<[string, string, string, boolean]>) =>
			writeFileSync(join(D, `im-${id}`), `/${name}\n${rows.map(([t, s, n, rw]) => `"${t}"\t"${s}"\t"${n}"\t${rw}`).join('\n')}\n`)
		it('passes when the existing infra container mounts what the config gives it (anonymous image volumes and tmpfs too)', () => {
			dbCfg()
			containers(['d1 exited shop db'])
			const anon = 'a'.repeat(64)
			serverVolume(anon, {})
			mounts('d1', 'shop-db', [
				['bind', join(apps, 'shop', 'pg'), '', true],
				['volume', '/var/lib/docker/volumes/shop_cache/_data', 'shop_cache', true],
				['volume', `/var/lib/docker/volumes/${anon}/_data`, anon, true],
				['tmpfs', '', '', true],
			])
			const r = infraGuard()
			expect(r.out).not.toContain('refusing')
			expect(r.ok).toBe(true)
		})
		it('refuses a stale (exited) infra container with an extra rw bind', () => {
			dbCfg()
			containers(['d1 exited shop db'])
			mounts('d1', 'shop-db', [
				['bind', join(apps, 'shop', 'pg'), '', true],
				['bind', join(apps, 'shop'), '', true],
			])
			const r = infraGuard()
			expect(r.ok).toBe(false)
			expect(r.out).toContain(`existing container shop-db of the infra service db mounts the bind ${join(apps, 'shop')}`)
			expect(r.out).toContain('docker rm shop-db')
		})
		it('refuses a writable mount the config makes read-only, a foreign volume and an anonymous volume with options', () => {
			dbCfg(true)
			containers(['d1 exited shop db'])
			mounts('d1', 'shop-db', [['bind', join(apps, 'shop', 'pg'), '', true]])
			expect(infraGuard().out).toContain('writable, while the config mounts it read-only')
			mounts('d1', 'shop-db', [['bind', join(apps, 'shop', 'pg'), '', false]])
			expect(infraGuard().ok).toBe(true)
			mounts('d1', 'shop-db', [['volume', '/x', 'acme_data', true]])
			expect(infraGuard().out).toContain('the volume acme_data, which the compose config does not give')
			const anon = 'b'.repeat(64)
			serverVolume(anon, { anon: ';device;o;type' })
			mounts('d1', 'shop-db', [['volume', '/x', anon, true]])
			expect(infraGuard().out).toContain(`the anonymous volume ${anon}`)
		})
		it('only the named infra services, and only this project', () => {
			dbCfg()
			containers(['d1 exited acme db', 'w1 exited shop worker'])
			mounts('d1', 'acme-db', [['bind', '/', '', true]])
			mounts('w1', 'shop-worker', [['bind', '/', '', true]])
			expect(infraGuard('db').ok).toBe(true)
		})
		it('the deploy script runs it before the infra up --no-recreate', () => {
			const s = buildDeployScript({
				workingDir: '/opt/apps/shop',
				configFile: '/opt/apps/shop/docker-compose.yml',
				service: 'shop',
				cf: "-f '/opt/apps/shop/docker-compose.yml'",
				declaredMode: 'build',
				prebuilt: false,
				infra: ['db'],
				wantBranch: null,
				wantSha: null,
				shaIsStrict: false,
				swapOrdinal: 1700000000000,
				stageId: 'dep_x',
			})
			const g = s.indexOf('infra guard: refusing, cannot read the compose config')
			const up = s.indexOf('--no-recreate $INFRA_SVCS')
			expect(g).toBeGreaterThan(0)
			expect(up).toBeGreaterThan(g)
		})
	})

	it('COMPOSE_JSON_SVC_MOUNTS_AWK resolves named volumes to their docker names', () => {
		const doc = {
			name: 'shop',
			services: {
				db: {
					volumes: [
						{ type: 'bind', source: '/opt/apps/shop/pg', target: '/d', read_only: true },
						{ type: 'volume', source: 'data', target: '/data' },
						{ type: 'volume', target: '/anon' },
						{ type: 'volume', source: 'ext', target: '/e' },
					],
				},
			},
			volumes: { data: { name: 'shop_data' }, ext: { name: 'acmestack_files', external: true } },
		}
		const out = spawnSync('awk', [COMPOSE_JSON_SVC_MOUNTS_AWK], { input: JSON.stringify(doc, null, 2), encoding: 'utf8' }).stdout
		expect(out.trim().split('\n')).toEqual([
			'N shop',
			'M\tdb\tbind\t/opt/apps/shop/pg\t1',
			'M\tdb\tvolume\tshop_data\t0',
			'M\tdb\tvolume\t\t0',
			'M\tdb\tvolume\tacmestack_files\t0',
		])
	})
})
