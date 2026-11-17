// the swap-check candidate and the bridge are removed only when the
// container carries THIS app's powder label, never by name alone (another app may
// be called `<app>-next` or `<app>-powder-bridge`).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeShellFunctions, swapCheckShellFunctions } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

function stubRun(script: string, label: string) {
	const d = mkdtempSync(join(tmpdir(), 'cand-'))
	writeFileSync(join(d, 'calls'), '')
	writeFakeDocker(d, `#!/bin/bash\necho "$*" >> '${join(d, 'calls')}'\ncase "$*" in *"index .Config.Labels"*) echo '${label}';; "inspect "*) exit 0;; esac\nexit 0\n`)
	spawnSync('bash', ['-c', script], {
		env: { ...process.env, PATH: `${d}:${process.env.PATH}` },
		encoding: 'utf8',
	})
	return readFileSync(join(d, 'calls'), 'utf8')
}

const plan = { path: '/api/health', strict: true, host: 'demo.example.com' }

describe('candidate + bridge removal requires the powder label', () => {
	it('swap_stop leaves a foreign container named <app>-next alone', () => {
		const fns = swapCheckShellFunctions('', 'app', '/opt/apps/demo', 'demo', plan)
		expect(stubRun(`${fns} SC_ON=1; swap_stop`, '')).not.toContain('rm -f demo-next')
		expect(stubRun(`${fns} SC_ON=1; swap_stop`, '/opt/apps/other|app')).not.toContain(
			'rm -f demo-next',
		)
		expect(stubRun(`${fns} SC_ON=1; swap_stop`, '/opt/apps/demo|app')).toContain('rm -f demo-next')
	})
	it('bridge_stop leaves a foreign container named like the bridge alone', () => {
		const fns = bridgeShellFunctions('', 'app', '/opt/apps/demo')
		expect(stubRun(`${fns} BRIDGE=demo-powder-bridge; bridge_stop`, '')).not.toContain(
			'rm -f demo-powder-bridge',
		)
		expect(
			stubRun(`${fns} BRIDGE=demo-powder-bridge; bridge_stop`, '/opt/apps/demo|app'),
		).toContain('rm -f demo-powder-bridge')
	})
})
