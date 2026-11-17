import { appLockPath } from '../deploy-supersede'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))

import { composeUpCommand } from '../deploy/fragments'

// Bug 3: the post-deploy domain sync / applyDomain recreate must (a) fail when
// `compose up` fails (pipefail beats `| tail`) and (b) hold the per-app flock.

function runUp(upRc: number) {
	const d = mkdtempSync(join(tmpdir(), 'powder-up-'))
	const app = join(d, 'app')
	spawnSync('mkdir', ['-p', app, join(d, 'bin')])
	const stubs: Record<string, string> = {
		docker: `#!/bin/bash\necho "[docker] $*" >> "${d}/calls"\ncase "$*" in *" config "*) printf '{\\n  "name": "app"\\n}\\n'; exit 0;; esac\necho boom\nexit ${upRc}\n`,
		flock: `#!/bin/bash\necho "[flock] $*" >> "${d}/calls"\nexit 0\n`,
	}
	writeFileSync(join(app, 'docker-compose.yml'), 'services:\n  shop:\n    image: shop\n')
	for (const [n, b] of Object.entries(stubs)) {
		writeFileSync(join(d, 'bin', n), b)
		chmodSync(join(d, 'bin', n), 0o755)
	}
	const cmd = composeUpCommand(join(app, 'docker-compose.yml'), 'shop', app, { approval: { hash: '', app: null, log: '' } }).replaceAll('/var/lib/powder/locks', join(d, 'locks'))
	const r = spawnSync('bash', ['-c', cmd], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH}` },
	})
	return { rc: r.status, calls: spawnSync('cat', [join(d, 'calls')], { encoding: 'utf8' }).stdout, lock: appLockPath(app, 'shop', join(d, 'locks')) }
}

describe('composeUpCommand', () => {
	it('a failing compose up is NOT hidden by | tail', () => {
		expect(runUp(1).rc).not.toBe(0)
	})
	it('a passing compose up exits 0', () => {
		expect(runUp(0).rc).toBe(0)
	})
	it('takes the per-app flock before running up', () => {
		const r = runUp(0)
		expect(r.calls).toContain('[flock] -w 90 9')
		expect(r.calls.indexOf('[flock]')).toBeLessThan(r.calls.indexOf('[docker]'))
	})
})
