// the in-app self-deploy and src/check-config.ts. A weak secret must stop the
// self-deploy BEFORE the recreate (the new containers would refuse to start and
// crash-loop), checked in the NEW image with the server's powder.env.
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selfConfigPreflightShell } from '../deploy/self-deploy'
import { writeFakeDocker } from './fixtures/fake-docker'

const WEB = resolve(__dirname, '../../..')

function preflight(stubOut: string, stubRc = 0, services = 'powder\nworker') {
	const d = mkdtempSync(join(tmpdir(), 'cfg-'))
	writeFakeDocker(d, `#!/bin/bash\ncase "$*" in *"config --services"*) printf '%b\\n' ${JSON.stringify(services)}; exit 0;; *" run --rm"*) printf '%b\\n' ${JSON.stringify(stubOut)}; exit ${stubRc};; esac\nexit 0\n`)
	const script = `step() { echo "── $1 ──"; }; ${selfConfigPreflightShell("-f '/opt/apps/powder/src/docker-compose.yml'", 'worker')}echo RECREATE_REACHED`
	return spawnSync('bash', ['-c', script], {
		env: { ...process.env, PATH: `${d}:${process.env.PATH}` },
		encoding: 'utf8',
	})
}

describe('self-deploy config preflight (in-app)', () => {
	it('refuses on a config finding, before the recreate', () => {
		const r = preflight(
			'__POWDER_CONFIG_BAD__ the new powder would refuse to start:\n - BETTER_AUTH_SECRET is only 8 characters',
			1,
		)
		expect(r.status).toBe(1)
		expect(r.stdout).toContain('BETTER_AUTH_SECRET is only 8 characters')
		expect(r.stdout).not.toContain('RECREATE_REACHED')
	})
	it('passes a good config; a probe that cannot run refuses too (the gate is never skipped)', () => {
		expect(preflight('[config-check] powder.env passes').stdout).toContain('RECREATE_REACHED')
		const broken = preflight('exec: "pnpm": executable file not found in $PATH', 1)
		expect(broken.status).toBe(1)
		expect(broken.stdout).toContain('could not run the config check')
		expect(broken.stdout).not.toContain('RECREATE_REACHED')
		expect(preflight('', 0, 'powder').stdout).toContain('skipped')
	})
})

describe('src/check-config.ts', () => {
	const runCheck = (env: Record<string, string>) =>
		spawnSync(join(WEB, 'node_modules/.bin/tsx'), ['src/check-config.ts'], {
			cwd: WEB,
			env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...env },
			encoding: 'utf8',
		})
	it('runs the way the worker image runs it: node --import tsx (no package manager)', () => {
		const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/check-config.ts'], {
			cwd: WEB,
			env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', BETTER_AUTH_SECRET: 'short' },
			encoding: 'utf8',
		})
		expect(r.status).toBe(1)
		expect(r.stderr).toContain('__POWDER_CONFIG_BAD__')
	})
	it('exits 1 with the marker on a weak secret, 0 on a good config', () => {
		const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9f'
		const bad = runCheck({ BETTER_AUTH_SECRET: 'short', POWDER_ENCRYPTION_KEY: key })
		expect(bad.status).toBe(1)
		expect(bad.stderr).toContain('__POWDER_CONFIG_BAD__')
		expect(bad.stderr).toContain('BETTER_AUTH_SECRET is only 5 characters')
		const good = runCheck({
			BETTER_AUTH_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
			POWDER_ENCRYPTION_KEY: key,
			BETTER_AUTH_URL: 'https://deploy.example.com',
		})
		expect(good.stderr).toBe('')
		expect(good.status).toBe(0)
		expect(good.stdout).toContain('[config-check]')
		const noUrl = runCheck({
			BETTER_AUTH_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
			POWDER_ENCRYPTION_KEY: key,
		})
		expect(noUrl.status).toBe(1)
		expect(noUrl.stderr).toContain('BETTER_AUTH_URL is not set')
	})
})
