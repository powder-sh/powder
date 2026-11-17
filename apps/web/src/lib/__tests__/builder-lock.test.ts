import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILD_LOCK, USER_BUILD_LOCK, buildLockShell } from '../build-lock'
import { builderBuildSlots, plockFn } from '../builder'

const ROOT = join(__dirname, '../../../../..')
// plock against a temp dir: /run is root-only, and the tests must not write to HOME
const tmpPlock = (n: number) => {
	const d = join(mkdtempSync(join(tmpdir(), 'plock-')), 'l')
	return plockFn(n).replaceAll(BUILD_LOCK, d).replaceAll(USER_BUILD_LOCK, d)
}

const hasFlock = spawnSync('which', ['flock']).status === 0

describe('builder build slots', () => {
	it('defaults to 2 and clamps the env value', () => {
		const old = process.env.POWDER_BUILD_SLOTS
		delete process.env.POWDER_BUILD_SLOTS
		expect(builderBuildSlots()).toBe(2)
		process.env.POWDER_BUILD_SLOTS = '0'
		expect(builderBuildSlots()).toBe(1)
		process.env.POWDER_BUILD_SLOTS = '99'
		expect(builderBuildSlots()).toBe(8)
		process.env.POWDER_BUILD_SLOTS = 'x'
		expect(builderBuildSlots()).toBe(2)
		if (old === undefined) delete process.env.POWDER_BUILD_SLOTS
		else process.env.POWDER_BUILD_SLOTS = old
	})
	it('plock loops over slot lock files with a busy sentinel', () => {
		const f = plockFn(3)
		expect(f).toContain(`flock -n -E 213 ${buildLockShell('.$__pi')} sh`)
		expect(f).not.toContain('/tmp/')
		expect(f).toContain('-lt 3')
		expect(f).toContain('flock -n -E 213')
	})
	it.skipIf(!hasFlock)('plock is valid shell and propagates the command exit code', () => {
		const out = execFileSync('bash', ['-c', `${tmpPlock(2)} plock 5 sh -c 'exit 7'; echo rc=$?`]).toString()
		expect(out).toContain('rc=7')
	})
	it.skipIf(!hasFlock)('plock does not rerun a command that exits 213, and survives set -e', () => {
		const out = execFileSync('bash', ['-c', `set -e; ${tmpPlock(2)} plock 5 sh -c 'echo ran; exit 213' || echo rc=$?`]).toString()
		expect(out.match(/ran/g)?.length).toBe(1)
		expect(out).toContain('rc=212')
	})
})

describe('server build lock path', () => {
	it('is /run/powder-build.lock, the same in the TS builders and both upgrade scripts', () => {
		expect(BUILD_LOCK).toBe('/run/powder-build.lock')
		for (const f of ['bin/install.sh', 'bin/self-deploy.sh']) {
			const sh = readFileSync(join(ROOT, f), 'utf8')
			expect(sh, f).toContain(`BUILD_LOCK=${BUILD_LOCK}\n`)
			// the lock at the older /tmp path only when it is a regular root-owned file, never a link
			expect(sh, f).toContain('OLDER_BUILD_LOCK=/tmp/powder-build.lock\n')
			expect(sh, f).toMatch(/-f "?\$OLDER_BUILD_LOCK"? \] && \[ ! -L "?\$OLDER_BUILD_LOCK"? \] && \[ \\?"\\?\$\(stat -c %u "?\$OLDER_BUILD_LOCK"? 2>\/dev\/null\)\\?" = 0 \]/)
			expect(sh.replaceAll('OLDER_BUILD_LOCK=/tmp/powder-build.lock', ''), f).not.toContain('/tmp/powder-build.lock')
		}
	})
	it('the rendered path is the /run lock for root, else a lock under HOME, refused when that is a symlink', () => {
		const home = mkdtempSync(join(tmpdir(), 'lockhome-'))
		const path = (uid: string) =>
			spawnSync('sh', ['-c', `id() { echo ${uid}; }; printf '<%s>' ${buildLockShell('.1')}`], {
				encoding: 'utf8',
				env: { ...process.env, HOME: home },
			})
		expect(path('0').stdout).toBe('</run/powder-build.lock.1>')
		expect(path('1000').stdout).toBe(`<${home}/.powder-build.lock.1>`)
		symlinkSync('/etc/passwd', join(home, '.powder-build.lock.1'))
		const r = path('1000')
		expect(r.stdout).toBe('<>')
		expect(r.stderr).toContain('is a symlink')
		// no source names the lock path itself: one place (build-lock.ts)
		for (const f of ['builder.ts', 'deploy/script.ts', 'deploy/self-deploy.ts']) {
			const src = readFileSync(join(ROOT, 'apps/web/src/lib', f), 'utf8')
			expect(src, f).not.toContain('powder-build.lock')
			expect(src, f).toContain('buildLockShell(')
		}
	})
	it('no other source names a /tmp build lock', () => {
		const bad: string[] = []
		const walk = (d: string) => {
			for (const e of readdirSync(d)) {
				const p = join(d, e)
				if (e === 'node_modules' || e === '__tests__' || e === '.next') continue
				if (statSync(p).isDirectory()) walk(p)
				else if (/\.(ts|tsx|sh)$/.test(e) && p !== join(ROOT, 'apps/web/src/lib/build-lock.ts')) {
					if (/\/tmp\/powder-build\.lock/.test(readFileSync(p, 'utf8'))) bad.push(p)
				}
			}
		}
		walk(join(ROOT, 'apps/web/src'))
		walk(join(ROOT, 'infra'))
		for (const f of readdirSync(join(ROOT, 'bin'))) {
			if (f === 'install.sh' || f === 'self-deploy.sh') continue
			if (/\/tmp\/powder-build\.lock/.test(readFileSync(join(ROOT, 'bin', f), 'utf8'))) bad.push(f)
		}
		expect(bad).toEqual([])
	})
})
