import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))

import { swapGateShell } from '../deploy-supersede'
import { buildDeployScript, composeFileArgs } from '../ssh'

const run = (script: string, cwd: string) => {
	try {
		execFileSync('bash', ['-c', script], { cwd, stdio: 'pipe' })
		return 0
	} catch (e) {
		return (e as { status: number }).status
	}
}

describe('deploy-time symlink sinks', () => {
	it('swap gate refuses to write the stamp through a symlink', () => {
		const dir = mkdtempSync(join(tmpdir(), 'sym-'))
		const victim = join(dir, 'victim')
		writeFileSync(victim, 'keep')
		const stamp = join(dir, 'stamp')
		symlinkSync(victim, stamp)
		const rc = run(swapGateShell(stamp, 5, 'app'), dir)
		expect(rc).not.toBe(0)
		expect(readFileSync(victim, 'utf8')).toBe('keep')
	})
	it('swap gate writes a normal stamp', () => {
		const dir = mkdtempSync(join(tmpdir(), 'sym-'))
		const stamp = join(dir, 'stamp')
		expect(run(swapGateShell(stamp, 5, 'app'), dir)).toBe(0)
		expect(readFileSync(stamp, 'utf8').trim()).toBe('5')
	})
	it('deploy script guards lock, compose restore and deploy key', () => {
		mkdirSync(tmpdir(), { recursive: true })
		const s = buildDeployScript({
			workingDir: '/opt/apps/demo',
			configFile: '/opt/apps/demo/docker-compose.yml',
			service: 'app',
			cf: composeFileArgs('/opt/apps/demo/docker-compose.yml'),
			declaredMode: 'build',
			prebuilt: false,
			infra: null,
			wantBranch: 'main',
			wantSha: null,
			shaIsStrict: false,
			swapOrdinal: 7,
		})
		expect(s).toContain('the per-app deploy lock path is a symlink')
		expect(s).toContain('[ -f "$KEY" ] && [ ! -L "$KEY" ]')
		expect(s).not.toContain('cp -f "$CP_KEEP" docker-compose.yml;')
	})
})
