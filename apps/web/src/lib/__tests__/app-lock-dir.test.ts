// the per-app deploy lock never lives in the app workdir, which in the workdir layout is
// the git checkout (a repo-trackable path). It lives in /var/lib/powder/locks (root
// only, 0700), and every caller derives the same path from (workingDir, service).
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_LOCK_DIR, appLockPath } from '../deploy-supersede'
import { appLockShell, composeFileArgs, composeUpCommand } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

const tmp = () => mkdtempSync(join(tmpdir(), 'powder-r25lock-'))

function stubBin(d: string): string {
	const bin = join(d, 'bin')
	mkdirSync(bin)
	writeFileSync(join(bin, 'flock'), '#!/bin/bash\nexit 0\n')
	chmodSync(join(bin, 'flock'), 0o755)
	return bin
}

describe('per-app deploy lock outside the workdir', () => {
	it('the lock path is in the root-only lock dir, keyed by workdir and service', () => {
		const p = appLockPath('/opt/apps/shopfront', 'web')
		expect(APP_LOCK_DIR).toBe('/var/lib/powder/locks')
		expect(p).toMatch(/^\/var\/lib\/powder\/locks\/[0-9a-f]{16}-web\.lock$/)
		expect(p.startsWith('/opt/apps/')).toBe(false)
		expect(appLockPath('/opt/apps/shopfront/', 'web')).toBe(p)
		expect(appLockPath('/opt/apps/other', 'web')).not.toBe(p)
		expect(appLockPath('/opt/apps/shopfront', 'worker')).not.toBe(p)
	})
	it('appLockShell creates the dir 0700, tightens an existing one, and leaves the workdir alone', () => {
		const d = tmp()
		const wd = join(d, 'app')
		mkdirSync(wd)
		const locks = join(d, 'locks')
		const bin = stubBin(d)
		const run = () =>
			spawnSync('bash', ['-c', `${appLockShell(appLockPath(wd, 'web', locks))}echo LOCKED`], {
				encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			})
		let r = run()
		expect(r.stdout).toContain('LOCKED')
		expect(statSync(locks).mode & 0o777).toBe(0o700)
		expect(existsSync(appLockPath(wd, 'web', locks))).toBe(true)
		expect(readdirSync(wd)).toEqual([])
		chmodSync(locks, 0o755)
		r = run()
		expect(r.stdout).toContain('LOCKED')
		expect(statSync(locks).mode & 0o777).toBe(0o700)
	})
	it('a symlinked lock dir is refused', () => {
		const d = tmp()
		mkdirSync(join(d, 'elsewhere'))
		symlinkSync(join(d, 'elsewhere'), join(d, 'locks'))
		const bin = stubBin(d)
		const r = spawnSync('bash', ['-c', `${appLockShell(appLockPath('/opt/apps/x', 'web', join(d, 'locks')))}echo LOCKED`], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		expect(r.status).not.toBe(0)
		expect(r.stdout).not.toContain('LOCKED')
		expect(readdirSync(join(d, 'elsewhere'))).toEqual([])
	})
	it('the deploy script and a recreate take the same lock, never one in the workdir', () => {
		const wd = '/opt/apps/shopfront'
		const lock = appLockPath(wd, 'web')
		const script = buildDeployScript({
			workingDir: wd,
			configFile: `${wd}/docker-compose.yml`,
			service: 'web',
			cf: composeFileArgs(`${wd}/docker-compose.yml`),
			declaredMode: 'auto',
			prebuilt: false,
			stageImage: null,
			infra: [],
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
			swapOrdinal: 1_700_000_000_000,
			stageId: 'dep_t',
		})
		const up = composeUpCommand(`${wd}/docker-compose.yml`, 'web', wd, { approval: { hash: '', app: null, log: '' } })
		for (const s of [script, up]) {
			expect(s).toContain(lock)
			expect(s).not.toContain('.powder-app-')
			expect(s).toContain('per-app lock dir unusable')
		}
	})
})
