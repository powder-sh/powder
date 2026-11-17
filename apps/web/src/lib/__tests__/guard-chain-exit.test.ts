// a top-level `;` after the guard chain (the dockerfile check starts with plain
// statements) split it: a guard that RETURNED non-zero instead of calling exit was a
// failed && list, which set -e ignores, so the deploy went on to build and swap.
// The real generated script runs under bash with stub docker/git/flock, and the compose
// hash guard replaced by one that returns 3 without exit.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const guard = vi.hoisted(() => ({ fail: false }))
vi.mock('../deploy/compose-hash', async (importOriginal) => {
	const real = await importOriginal<typeof import('../deploy/compose-hash')>()
	return {
		...real,
		// Only the first guard (during the git sync) fails, so a run that wrongly goes on
		// reaches the pre-up guard, passes it and swaps.
		composeHashGuardShell: (...a: Parameters<typeof real.composeHashGuardShell>) =>
			guard.fail && a[2] === 'during the git sync' ? '{ echo GUARD-RAN; ( exit 3 ); }' : '{ echo GUARD-RAN; true; }',
	}
})

import { composeFileArgs } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

function run(fail: boolean, ordinal: boolean) {
	guard.fail = fail
	const D = mkdtempSync(join(tmpdir(), 'powder-r25gc-'))
	const bin = join(D, 'bin')
	mkdirSync(bin)
	mkdirSync(join(D, 'app/src'), { recursive: true })
	writeFileSync(join(D, 'app/src/Dockerfile'), 'FROM scratch\n')
	const calls = join(D, 'calls.log')
	const stub = (n: string, body: string) => {
		writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`)
		chmodSync(join(bin, n), 0o755)
	}
	const ctx = join(D, 'app/src')
	const cfg = `printf 'name: app\\nservices:\\n  shop:\\n    build:\\n      context: ${ctx}\\n      dockerfile: Dockerfile\\n    image: shop:latest\\n'`
	stub(
		'docker',
		`echo "[docker] $*" >> ${calls}
case "$*" in
  info*) exit 0;;
  *"config --services"*) echo shop; exit 0;;
  *"config --no-interpolate --format json"*) printf '{\\n  "name": "shop"\\n}\\n'; exit 0;;
  *" config"*) ${cfg}; exit 0;;
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
		prebuilt: false,
		stageImage: null,
		infra: [],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
		swapOrdinal: ordinal ? 1_700_000_000_000 : undefined,
		swapStampDir: join(D, 'swap'),
		stageId: 'dep_t',
		composeHash: 'a'.repeat(64),
	})
	const f = join(D, 'd.sh')
	writeFileSync(f, script.replaceAll('/var/lib/powder/locks', join(D, 'locks')))
	const r = spawnSync('bash', [f], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
	return { rc: r.status, out: `${r.stdout}${r.stderr}`, log: existsSync(calls) ? readFileSync(calls, 'utf8') : '' }
}

describe('a guard that returns non-zero stops the deploy', { timeout: 30_000 }, () => {
	for (const ordinal of [true, false]) {
		it(`compose hash guard returns 3 without exit (${ordinal ? 'ordinal' : 'legacy'} script)`, () => {
			const r = run(true, ordinal)
			expect(r.out).toContain('GUARD-RAN')
			expect(r.rc).not.toBe(0)
			expect(r.out).toMatch(/__POWDER_FAIL__ step=compose guard code=[1-9]/)
			for (const later of ['dockerfile check', 'docker compose pull', 'test gate', 'swap gate', 'db migrate', 'release', 'docker compose up'])
				expect(r.out).not.toContain(`── ${later}`)
			expect(r.log).not.toMatch(/ (build|pull|up) /)
			expect(r.log).not.toMatch(/^\[docker\] tag /m)
		})
	}
	it('control: the same script with the guard passing reaches the dockerfile check and the build', () => {
		const r = run(false, true)
		expect(r.out).toContain('GUARD-RAN')
		expect(r.out).toContain('── dockerfile check ──')
		expect(r.log).toMatch(/ build /)
	})
})
