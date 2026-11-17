import { gitHardenShellFunctions } from '../git-harden'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { composeProjectStableShell, trackedDotenvGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

// a tracked top-level .env in a workdir-clone layout is
// compose's project .env; COMPOSE_*/DOCKER_* keys there must not retarget the deploy.

function repo(files: Record<string, string>, track = true) {
	const dir = mkdtempSync(join(tmpdir(), 'dotenv-'))
	const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
	git('init', '-q')
	for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v)
	if (track) git('add', '-A', '-f')
	return dir
}
const run = (dir: string, body: string) => {
	try {
		return {
			rc: 0,
			out: execFileSync('bash', ['-c', `${gitHardenShellFunctions()}cd '${dir}' && ${body} && echo PASSED`], {
				encoding: 'utf8',
			}),
		}
	} catch (e) {
		const x = e as { status: number; stdout: string }
		return { rc: x.status, out: x.stdout }
	}
}

describe('tracked .env guard', () => {
	it('refuses a tracked .env that sets COMPOSE_PROJECT_NAME or DOCKER_HOST', () => {
		const r = run(
			repo({ '.env': 'PORT=3000\nCOMPOSE_PROJECT_NAME=victim\nexport DOCKER_HOST=tcp://x\n' }),
			trackedDotenvGuardShell("'*'"),
		)
		expect(r.rc).toBe(1)
		expect(r.out).toContain('COMPOSE_PROJECT_NAME DOCKER_HOST')
	})
	it('refuses COMPOSE_ / DOCKER_ anywhere on a line, any case', () => {
		for (const body of ['A="x" COMPOSE_PROJECT_NAME=victim\n', 'PORT=1 compose_project_name=victim\n', 'X=1;Docker_Host=tcp://x\n', 'MY_DOCKER_TAG=1\n']) {
			const r = run(repo({ '.env': body }), trackedDotenvGuardShell("'*'"))
			expect(r.rc, body).toBe(1)
			expect(r.out).toMatch(/refusing, the repo tracks a top-level \.env that sets (COMPOSE|DOCKER)_/i)
		}
	})
	it('keeps a tracked .env with plain interpolation keys, and an untracked .env', () => {
		expect(
			run(repo({ '.env': 'PORT=3000\nIMAGE=app:1\n' }), trackedDotenvGuardShell("'*'")).out,
		).toContain('PASSED')
		expect(
			run(repo({ '.env': 'COMPOSE_PROJECT_NAME=x\n' }, false), trackedDotenvGuardShell("'*'")).out,
		).toContain('PASSED')
	})
	it('refuses a tracked .env symlink', () => {
		const dir = repo({ 'a.txt': 'x' }, false)
		symlinkSync('/etc/hostname', join(dir, '.env'))
		execFileSync('git', ['-C', dir, 'add', '-A', '-f'])
		expect(run(dir, trackedDotenvGuardShell("'*'")).rc).toBe(1)
	})
	it('refuses when the compose project name changed during the sync', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cproj-'))
		writeFileSync(join(dir, 'docker'), '#!/bin/bash\necho "name: victim"\n', { mode: 0o755 })
		const env = `PATH='${dir}':$PATH`
		expect(
			run(dir, `export ${env}; CP_PROJ=demo; ${composeProjectStableShell('-f c.yml')}`).rc,
		).toBe(1)
		expect(
			run(dir, `export ${env}; CP_PROJ=victim; ${composeProjectStableShell('-f c.yml')}`).out,
		).toContain('PASSED')
		expect(readFileSync(join(dir, 'docker'), 'utf8')).toContain('victim')
	})
	it('the deploy script runs both guards in the workdir layout', () => {
		const sc = buildDeployScript({
			workingDir: '/opt/apps/demo',
			configFile: '/opt/apps/demo/docker-compose.yml',
			service: 'app',
			cf: '-f /opt/apps/demo/docker-compose.yml',
			declaredMode: 'build',
			prebuilt: false,
			migrateApp: 'demo',
			infra: ['db'],
			wantBranch: 'main',
			wantSha: null,
			shaIsStrict: false,
		})
		const legacy = sc.indexOf('elif [ -d .git ]; then')
		expect(sc.indexOf('step "tracked .env guard"')).toBeGreaterThan(legacy)
		expect(sc).toContain('the compose project changed during the git sync')
	})
})

describe('cron log grep', () => {
	it('ends grep options before the user-derived needle', () => {
		const src = readFileSync(join(__dirname, '../../app/api/crons/logs/route.ts'), 'utf8')
		expect(src).toContain('| grep -F -- ${shq(needle)}')
		expect(src).not.toMatch(/grep -F \$\{shq\(needle\)\}/)
	})
})
