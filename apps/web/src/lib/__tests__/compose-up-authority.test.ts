import { appLockPath } from '../deploy-supersede'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		calls.push(cmd)
		// resolveInfraServices reads `config --format json`; fail it so the heuristic path is used
		return cmd.includes('--format json') && !cmd.includes('rollback target') ? { stdout: '', stderr: '', code: 1 } : { stdout: 'ok', stderr: '', code: 0 }
	},
}))

import { composeUpCommand } from '../deploy/fragments'
import { rollbackToImage } from '../deploy/health'

const SRC = join(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f)
		if (statSync(p).isDirectory()) {
			if (f !== '__tests__') walk(p, out)
		} else if (/\.tsx?$/.test(f)) out.push(p)
	}
	return out
}

// buildDeployScript owns its own `up`; runSelfDeploy fires a detached one for
// powder itself. Everything else must go through composeUpCommand (pipefail +
// per-app flock).
const ALLOWED = new Set(['lib/deploy/script.ts', 'lib/deploy/self-deploy.ts', 'lib/deploy/fragments.ts'])

describe('compose up has one authority', () => {
	it('no source file runs `docker compose ... up -d` outside the allowed set', () => {
		const offenders: string[] = []
		for (const f of walk(SRC)) {
			const rel = relative(SRC, f)
			if (ALLOWED.has(rel)) continue
			const lines = readFileSync(f, 'utf8').split('\n')
			lines.forEach((l, i) => {
				if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
				if (/docker compose[^`'"\n]*\bup -d\b/.test(l) && /[`'"]docker compose/.test(l)) offenders.push(`${rel}:${i + 1}`)
			})
		}
		// Docs/prose strings that show an operator a manual command are not runners.
		const real = offenders.filter((o) => !/context\/route\.ts|sync-deployment-md\.ts|recreate-hint\.ts/.test(o))
		expect(real).toEqual([])
	})
})

describe('composeUpCommand options', () => {
	it('defaults: single -f file, quoted service, tail -10, lock in the root-only lock dir', () => {
		const c = composeUpCommand('/opt/apps/a/docker-compose.yml', 'app', '/opt/apps/a', { approval: { hash: '', app: null, log: '' } })
		expect(c).toMatch(/^bash -o pipefail -c /)
		expect(c).toContain('flock -w 90 9')
		expect(c).toContain('| tail -10')
		expect(c).toContain(appLockPath('/opt/apps/a', 'app'))
		expect(c).toMatch(/\/var\/lib\/powder\/locks\/[0-9a-f]{16}-app\.lock/)
		expect(c).toContain('--force-recreate --no-deps ')
	})
	it('the lock lives in the WORKING dir, even when the compose file sits in a subdirectory', () => {
		const c = composeUpCommand('/opt/apps/a/conf/docker-compose.yml', 'app', '/opt/apps/a', { approval: { hash: '', app: null, log: '' } })
		expect(c).toContain(appLockPath('/opt/apps/a', 'app'))
		expect(c).not.toContain(appLockPath('/opt/apps/a/conf', 'app'))
	})
	it('tail: null drops the pipe, cf and targets pass through', () => {
		const c = composeUpCommand('/opt/apps/a/docker-compose.yml', 'app', '/opt/apps/a', { approval: { hash: '', app: null, log: '' },
			cf: "-f 'a.yml' -f 'b.yml'",
			targets: '$TARGETS',
			tail: null,
		})
		expect(c).not.toContain('tail')
		expect(c).toContain('--force-recreate ${TARGETS:+--no-deps} $TARGETS')
		expect(c).toContain('b.yml')
	})
})

describe('rollbackToImage routes its recreate through composeUpCommand', () => {
	it('exports TARGETS, runs up under pipefail + flock, and parses as bash', async () => {
		calls.length = 0
		await rollbackToImage({ host: 'h', user: 'root' } as never, '/opt/apps/a/docker-compose.yml', 'app', 'img:old', 'img:cur', undefined, { approval: { hash: '', app: null, log: '' },
			composeFiles: ['/opt/apps/a/docker-compose.yml', '/opt/apps/a/o.yml'],
			workingDir: '/opt/apps/a',
		})
		const cmd = calls.find((c) => c.includes('rollback target')) ?? ''
		expect(cmd).toContain('export TARGETS && bash -o pipefail -c ')
		expect(cmd).toContain('flock -w 90 9')
		// the lock is taken once, before the retag, and covers the up
		expect(cmd.match(/flock -w 90 9/g)).toHaveLength(1)
		expect(cmd.indexOf('flock -w 90 9')).toBeLessThan(cmd.indexOf('docker tag'))
		expect(cmd).toContain('o.yml')
		execFileSync('bash', ['-n', '-c', cmd])
	})
})
