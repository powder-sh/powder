import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn()
vi.mock('../ssh/connection', () => ({ runCommand: (...a: unknown[]) => runCommand(...a) }))
vi.mock('../ssh/files', () => ({ writeFileViaSftp: async () => {} }))

import { buildLockShell } from '../build-lock'
import { budgetExhausted } from '../deploy-budget'
import { swapStampPath } from '../deploy-supersede'
import { rebuildDeploy, restoreSharedTagAfterAbort } from '../deploy/run'
import { childTimeoutPrefix } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

const base = {
	workingDir: '/opt/apps/app',
	configFile: '/opt/apps/app/docker-compose.yml',
	service: 'app',
	cf: "-f '/opt/apps/app/docker-compose.yml'",
	declaredMode: 'build',
	prebuilt: false,
	infra: [],
	wantBranch: null,
	wantSha: null,
	shaIsStrict: false,
	swapOrdinal: 1700000000000,
	stageId: 'dep_x',
}

describe('deploy script budget guards', () => {
	const script = buildDeployScript(base)
	it('refuses to start the swap with less than 120s of budget left', () => {
		const i = script.indexOf('step "budget check"')
		expect(i).toBeGreaterThan(-1)
		expect(script).toContain('[ "$(left 0)" -lt 120 ]')
		expect(i).toBeLessThan(script.indexOf('step "docker compose up"'))
		expect(i).toBeGreaterThan(script.indexOf('step "release"'))
	})
	it('build and test-gate timeouts are computed inside the flock child, not before the lock wait', () => {
		expect(script).not.toContain('timeout "$(cap 1800 240)"')
		expect(script).not.toContain('timeout "$(cap 900 150)"')
		expect(script).toContain(`flock -w "$(left 300)" ${buildLockShell()} env DL="$DEADLINE" bash -c`)
	})
	it('writes the abort record next to the swap stamp and removes it in the EXIT trap', () => {
		expect(script).toContain(`${swapStampPath('/opt/apps/app', 'app', 'app')}.prev`)
		expect(script).toContain('rm -f "$PREVF"')
	})
	// GNU timeout is a Linux tool (absent on a stock macOS dev machine); CI/servers have it.
	const hasTimeout = spawnSync('bash', ['-c', 'command -v timeout']).status === 0
	it.skipIf(!hasTimeout)('child timeout: derived from DEADLINE at exec time', () => {
		const run = (deadlineOffset: number) => {
			const t0 = Date.now()
			const r = spawnSync('bash', ['-c', `DEADLINE=$(( $(date +%s) + ${deadlineOffset} )); ${childTimeoutPrefix(1800, 0)} sleep 5`], { encoding: 'utf8' })
			return { status: r.status, ms: Date.now() - t0 }
		}
		const spent = run(-10) // budget gone while waiting for the lock: killed after ~1s
		expect(spent.status).toBe(124)
		expect(spent.ms).toBeLessThan(4000)
		const ok = run(2)
		expect(ok.status).toBe(124)
		expect(ok.ms).toBeLessThan(4500)
	})
})

describe('budget exhausted', () => {
	it('is true at or past the deadline only', () => {
		expect(budgetExhausted(1000, 1000)).toBe(true)
		expect(budgetExhausted(1000, 2000)).toBe(true)
		expect(budgetExhausted(2000, 1000)).toBe(false)
		expect(budgetExhausted(undefined)).toBe(false)
	})
	it('rebuildDeploy refuses to start with a spent budget, as a pre-swap step', async () => {
		runCommand.mockReset()
		await expect(
			rebuildDeploy({ id: 's' } as never, '/opt/apps/app', '/opt/apps/app/docker-compose.yml', 'app', 'dep_1', undefined, {
				deadlineAt: Date.now() - 1000,
			}),
		).rejects.toThrow(/step=budget/)
		expect(runCommand).not.toHaveBeenCalled()
	})
})

describe('restoreSharedTagAfterAbort', () => {
	function exec(prevImage: string, running: string) {
		const root = mkdtempSync(join(tmpdir(), 'rst-'))
		const swap = join(root, 'swap')
		mkdirSync(swap)
		const app = join(root, 'app')
		mkdirSync(app)
		const stubs = join(root, 'stubs')
		mkdirSync(stubs)
		const calls = join(root, 'calls.log')
		writeFileSync(calls, '')
		writeFileSync(join(stubs, 'docker'), `#!/bin/bash\necho "docker $*" >> "$CALLS"\ncase "$1" in inspect) echo "$RUNNING";; esac\n`)
		writeFileSync(join(stubs, 'flock'), '#!/bin/bash\nexit 0\n')
		chmodSync(join(stubs, 'docker'), 0o755)
		chmodSync(join(stubs, 'flock'), 0o755)
		writeFileSync(join(swap, `${swapStampPath('/opt/apps/app', 'app', 'app').split('/').pop()}.prev`), `${prevImage}\napp:latest\n`)
		let cmd = ''
		runCommand.mockImplementation(async (_s: unknown, c: string) => {
			cmd = c.replaceAll('/var/lib/powder/swap', swap).replaceAll('/var/lib/powder/locks', join(root, 'locks')).replaceAll('/opt/apps/app', app)
			const r = spawnSync('bash', ['-c', cmd], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, CALLS: calls, RUNNING: running }, encoding: 'utf8' })
			return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
		})
		return { go: () => restoreSharedTagAfterAbort({ id: 's' } as never, { workingDir: '/opt/apps/app', service: 'app', containerName: 'app' }), calls: () => readFileSync(calls, 'utf8'), rec: join(swap, `${swapStampPath('/opt/apps/app', 'app', 'app').split('/').pop()}.prev`) }
	}
	it('restores the tag when the app is still on the pre-swap image', async () => {
		const t = exec('sha256:old', 'sha256:old')
		const note = await t.go()
		expect(t.calls()).toContain('docker tag sha256:old app:latest')
		expect(note).toContain('restored')
		expect(existsSync(t.rec)).toBe(false)
	})
	it('leaves the tag alone when the swap happened', async () => {
		const t = exec('sha256:old', 'sha256:new')
		await t.go()
		expect(t.calls()).not.toContain('docker tag')
		expect(existsSync(t.rec)).toBe(false)
	})
})
