// Guard for the overlapping-deploys race: an OLDER deploy whose build finishes
// last must never retag the shared image or swap containers over a newer one.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	SUPERSEDED_MARKER,
	appLockPath,
	isSupersededBy,
	stageImageTag,
	swapGateShell,
	swapStampPath,
} from '../deploy-supersede'
import { buildDeployScript, composeFileArgs } from '../ssh'
import { writeFakeDocker } from './fixtures/fake-docker'

describe('isSupersededBy', () => {
	const t = (s: number) => new Date(2026, 9, 21, 16, s)
	const me = { id: 'A', startedAt: t(20) }
	it('newer running or successful deploy supersedes', () => {
		expect(isSupersededBy(me, [{ id: 'B', status: 'running', kind: 'git_deploy', startedAt: t(30) }])).toEqual({ id: 'B' })
		expect(isSupersededBy(me, [{ id: 'B', status: 'success', kind: 'git_deploy', startedAt: t(30) }])).toEqual({ id: 'B' })
	})
	it('a merely queued newer deploy does not (normal burst coalescing)', () => {
		expect(isSupersededBy(me, [{ id: 'B', status: 'queued', kind: 'git_deploy', startedAt: t(30) }])).toBeNull()
	})
	it('restart/apply/env rows do not count, only code deploys', () => {
		expect(isSupersededBy(me, [{ id: 'B', status: 'success', kind: 'restart', startedAt: t(30) }])).toBeNull()
	})
	it('older / failed / self never supersede', () => {
		expect(isSupersededBy(me, [{ id: 'Z', status: 'success', kind: 'git_deploy', startedAt: t(10) }])).toBeNull()
		expect(isSupersededBy(me, [{ id: 'B', status: 'failed', kind: 'git_deploy', startedAt: t(30) }])).toBeNull()
		expect(isSupersededBy(me, [{ id: 'A', status: 'running', kind: 'git_deploy', startedAt: t(30) }])).toBeNull()
	})
})

describe('stageImageTag', () => {
	it('swaps the tag for a unique build tag', () => {
		expect(stageImageTag('ghcr.io/example/app:latest', 'dep_abc')).toBe('ghcr.io/example/app:build-abc')
		expect(stageImageTag('shop', 'dep_abc')).toBe('shop:build-abc')
		expect(stageImageTag('reg:5000/shop', 'dep_abc')).toBe('reg:5000/shop:build-abc')
	})
})

// Runs the real swap-gate shell with a fake `docker` that logs its calls.
function srv() {
	const dir = mkdtempSync(join(tmpdir(), 'powder-supersede-'))
	const log = join(dir, 'docker.log')
	writeFakeDocker(dir, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`)
	const stamp = join(dir, 'swap', 'shop-shop')
	const gate = (ordinal: number, id: string) => {
		const script = `set -e; IMGREF=ghcr.io/x/shop:latest; STAGE_IMG=ghcr.io/x/shop:build-${id}; ${swapGateShell(stamp, ordinal, 'shop')}; echo SWAPPED`
		const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' })
		const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
		writeFileSync(log, '')
		return { code: r.status, out: r.stdout, calls }
	}
	return { gate, stamp }
}

describe('swap gate (race reproduction)', { timeout: 30_000 }, () => {
	it('older deploy A finishing after newer B must not retag :latest or swap', () => {
		const { gate, stamp } = srv()
		const b = gate(2000, 'B') // B (newer) finishes first
		expect(b.out).toMatch(/SWAPPED/)
		expect(b.calls).toMatch(/tag ghcr.io\/x\/shop:build-B ghcr.io\/x\/shop:latest/)
		const a = gate(1000, 'A') // A (older) finishes last
		expect(a.code).toBe(0)
		expect(a.out).toContain(SUPERSEDED_MARKER)
		expect(a.out).not.toMatch(/SWAPPED/)
		expect(a.calls).not.toMatch(/tag /)
		expect(readFileSync(stamp, 'utf8').trim()).toBe('2000')
	})
	it('sequential deploys, and a retry of the same deploy, are unaffected', () => {
		const { gate } = srv()
		expect(gate(1000, 'A').out).toMatch(/SWAPPED/)
		expect(gate(2000, 'B').out).toMatch(/SWAPPED/)
		expect(gate(2000, 'B').out).toMatch(/SWAPPED/)
		expect(gate(3000, 'C').out).toMatch(/SWAPPED/)
	})
})

describe('buildDeployScript ordering + staging', () => {
	const base = {
		workingDir: '/opt/apps/shop',
		configFile: '/opt/apps/shop/docker-compose.yml',
		service: 'shop',
		cf: composeFileArgs('/opt/apps/shop/docker-compose.yml'),
		declaredMode: 'build',
		prebuilt: false,
		infra: ['db'],
		wantBranch: 'main',
		wantSha: null,
		shaIsStrict: false,
		swapOrdinal: 1_700_000_000_000,
		stageId: 'dep_xyz',
	}
	const syntax = (s: string) => {
		const f = join(mkdtempSync(join(tmpdir(), 'powder-ds-')), 'd.sh')
		writeFileSync(f, s)
		expect(spawnSync('bash', ['-n', f]).status).toBe(0)
	}
	it('is valid bash, locks first, builds to a staged tag, retags only at the gate', () => {
		const s = buildDeployScript(base)
		syntax(s)
		syntax(buildDeployScript({ ...base, prebuilt: true, stageImage: 'ghcr.io/x/shop:build-xyz' }))
		expect(s).toContain(appLockPath('/opt/apps/shop', 'shop'))
		expect(s).toContain(swapStampPath('/opt/apps/shop', 'shop'))
		expect(swapStampPath('/opt/apps/shop', 'shop')).toMatch(/^\/var\/lib\/powder\/swap\/[0-9a-f]{16}-shop-shop$/)
		// Names that join to the same slug must not share a stamp
		expect(swapStampPath('/opt/apps/foo', 'bar-app', 'foo')).not.toBe(swapStampPath('/opt/apps/foo-bar', 'app', 'foo-bar'))
		expect(swapStampPath('/opt/apps/foo', 'bar-app')).toBe(swapStampPath('/opt/apps/foo/', 'bar-app'))
		expect(s).not.toContain('.powder-swap-')
		const lock = s.indexOf('step "app lock"')
		const build = s.indexOf('$STAGE_F build')
		const gate = s.indexOf('step "swap gate"')
		const migrate = s.indexOf('step "db migrate"')
		const tag = s.indexOf('docker tag "$STAGE_IMG"')
		expect(lock).toBeGreaterThan(-1)
		expect(lock).toBeLessThan(build)
		expect(build).toBeLessThan(gate)
		expect(gate).toBeLessThan(migrate)
		expect(tag).toBeGreaterThan(gate)
		expect(tag).toBeLessThan(migrate)
		expect(s.indexOf('docker tag ')).toBe(tag) // the only tag in the script is the gated one
	})
	it('without an ordinal the script is unordered (no lock, no gate)', () => {
		const s = buildDeployScript({ ...base, swapOrdinal: undefined })
		expect(s).not.toContain('step "app lock"')
		expect(s).not.toContain('step "swap gate"')
	})
})

// Failure propagation: the ordinal script must still abort (rc != 0, FAIL trailer,
// no migrate/up) when a pull / build / git step fails. A helper that puts a
// top-level `;` into the && chain would let set -e stop protecting it.
describe('ordinal script keeps failing deploys failed', { timeout: 30_000 }, () => {
	function run(opts: { cfg: 'build-image' | 'build-noimage' | 'registry'; fail: 'pull' | 'build' | 'git' | 'none'; prebuilt?: boolean }) {
		const D = mkdtempSync(join(tmpdir(), 'powder-fail-'))
		const bin = join(D, 'bin')
		mkdirSync(bin)
		mkdirSync(join(D, 'app/src'), { recursive: true })
		writeFileSync(join(D, 'app/src/Dockerfile'), 'FROM scratch\n')
		if (opts.fail === 'git') mkdirSync(join(D, 'app/src/.git'))
		const calls = join(D, 'calls.log')
		const stub = (n: string, body: string) => {
			writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`)
			chmodSync(join(bin, n), 0o755)
		}
		const ctx = join(D, 'app/src')
		const buildBlock = `    build:\\n      context: ${ctx}\\n      dockerfile: Dockerfile\\n`
		const cfg =
			opts.cfg === 'registry'
				? `printf 'name: app\\nservices:\\n  shop:\\n    image: shop:latest\\n'`
				: opts.cfg === 'build-image'
					? `printf 'name: app\\nservices:\\n  shop:\\n${buildBlock}    image: shop:latest\\n'`
					: `printf 'name: app\\nservices:\\n  shop:\\n${buildBlock}'`
		stub(
			'docker',
			`echo "[docker] $*" >> ${calls}
case "$*" in
  info*) exit 0;;
  *"config --services"*) echo shop; exit 0;;
  *"config --no-interpolate --format json"*) printf '{\\n  "name": "shop"\\n}\\n'; exit 0;;
  *" config"*) ${cfg}; exit 0;;
  *" pull "*) ${opts.fail === 'pull' ? 'exit 1' : 'exit 0'};;
  *" build "*) ${opts.fail === 'build' ? 'exit 1' : 'exit 0'};;
  *) exit 0;;
esac`,
		)
		stub('git', 'exit 1')
		stub('flock', 'if [ "$1" = -w ]; then shift 2; fi; [ "$1" = 9 ] && exit 0; shift; exec "$@"')
		stub('timeout', '[ "$1" = -k ] && shift 2; shift; exec "$@"')
		stub('sleep', 'exit 0')
		const script = buildDeployScript({
			workingDir: join(D, 'app'),
			configFile: join(D, 'app/docker-compose.yml'),
			service: 'shop',
			cf: composeFileArgs(join(D, 'app/docker-compose.yml')),
			declaredMode: 'auto',
			prebuilt: opts.prebuilt ?? false,
			stageImage: opts.prebuilt ? 'shop:build-x' : null,
			infra: [],
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
			swapOrdinal: 1_700_000_000_000,
			swapStampDir: join(D, 'swap'),
			stageId: 'dep_t',
		})
		const f = join(D, 'd.sh')
		writeFileSync(f, script.replaceAll('/var/lib/powder/locks', join(D, 'locks')))
		const r = spawnSync('bash', [f], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
		const log = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
		return { rc: r.status, out: `${r.stdout}${r.stderr}`, log, stamp: existsSync(swapStampPath(join(D, 'app'), 'shop', 'app', join(D, 'swap'))) }
	}
	const expectAborted = (r: ReturnType<typeof run>) => {
		expect(r.rc).not.toBe(0)
		expect(r.out).toContain('__POWDER_FAIL__')
		expect(r.log).not.toMatch(/ up /)
		expect(r.out).not.toContain('── db migrate ──')
		expect(r.out).not.toContain('── docker compose up ──')
	}
	it('failing registry pull aborts', () => expectAborted(run({ cfg: 'registry', fail: 'pull' })))
	it('failing local build aborts (with and without image:)', () => {
		expectAborted(run({ cfg: 'build-image', fail: 'build' }))
		expectAborted(run({ cfg: 'build-noimage', fail: 'build' }))
	})
	it('failing git sync aborts', () => expectAborted(run({ cfg: 'build-image', fail: 'git' })))
	it('happy path still swaps (stages, gates, ups)', () => {
		const r = run({ cfg: 'build-image', fail: 'none' })
		expect(r.rc).toBe(0)
		expect(r.out).toContain('── swap gate ──')
		expect(r.log).toMatch(/tag shop:build-t shop:latest/)
		expect(r.log).toMatch(/ up -d /)
		expect(r.stamp).toBe(true)
	})
})
