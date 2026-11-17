// A builder test gate whose tests fail must fail the deploy, not fall back to a local build on the
// production server: the fallback re-ran the same failing tests there under less memory and died with a
// heap OOM. Infra failures of the run (timeout, docker errors, kills) keep
// exit 1, so the local fallback still covers a broken builder.
import { gitHardenShellFunctions } from '../git-harden'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_GATE_TESTS_FAILED_EXIT, testGateShell } from '../deploy/fragments'
import { buildBuilderScript } from '../builder'
import { writeFakeDocker } from './fixtures/fake-docker'

const DIGEST = `docker.io/library/node@sha256:${'c'.repeat(64)}`

/** Runs the gate with a stub docker whose `run` exits `runRc`. */
function gate(runRc: number, testsFailedExit?: number) {
	const d = mkdtempSync(join(tmpdir(), 'tgnf-'))
	const ctx = join(d, 'ctx')
	mkdirSync(join(ctx, '.powder'), { recursive: true })
	writeFileSync(join(ctx, '.powder/test.sh'), 'exit 1\n')
	writeFakeDocker(d, `#!/bin/bash
if [ "$1 $2" = "image inspect" ]; then case "$*" in *RepoDigests*) echo '${DIGEST}';; *) echo '{}';; esac; exit 0; fi
if [ "$1" = run ]; then exit ${runRc}; fi
exit 0
`)
	const frag = testGateShell({ dir: `'${ctx}'`, label: 'l', run: '', tag: '[tg]', app: 'x', testsFailedExit })
	return spawnSync('bash', ['-c', `set -e; ${gitHardenShellFunctions()}${frag}`], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${d}:${process.env.PATH}` },
	})
}

describe('builder test gate: failing tests are final', () => {
	it('failing tests exit with the tests-failed code when asked (heap OOM abort 134 included)', () => {
		for (const rc of [1, 2, 134]) {
			const r = gate(rc, TEST_GATE_TESTS_FAILED_EXIT)
			expect(r.status, r.stdout + r.stderr).toBe(TEST_GATE_TESTS_FAILED_EXIT)
			expect(r.stdout).toContain('[tg] FAILED')
		}
	})

	it('timeouts, docker errors and kills stay exit 1, so the local fallback still runs', () => {
		for (const rc of [124, 125, 126, 127, 137, 141, 143]) {
			const r = gate(rc, TEST_GATE_TESTS_FAILED_EXIT)
			expect(r.status, `rc ${rc}: ${r.stdout}${r.stderr}`).toBe(1)
		}
	})

	it('the local gate (no testsFailedExit) keeps exit 1; a pass stays 0', () => {
		expect(gate(1).status).toBe(1)
		expect(gate(0, TEST_GATE_TESTS_FAILED_EXIT).status).toBe(0)
	})

	it('the builder script asks for the tests-failed code and nothing else in it exits with it', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/x-demoapp',
			repoUrl: 'git@github.com:example-org/demoapp.git',
			branch: 'main',
			sha: null,
			keyPath: '/tmp/k',
			image: 'demoapp:latest',
			uniq: 'demoapp:latest-b1',
			ctx: '/opt/builds/x-demoapp/src',
			df: '/opt/builds/x-demoapp/src/Dockerfile',
			buildArgs: '',
		})
		expect(s).toContain(`exit ${TEST_GATE_TESTS_FAILED_EXIT}; fi;`)
		expect(s.split(`exit ${TEST_GATE_TESTS_FAILED_EXIT}`).length).toBe(2)
		// the failure summary scans the test output only (parseDeployFailure's step banner)
		expect(s).toContain("echo '── test gate ──'")
		// a build slot that never frees is infra (124), not a test failure
		expect(s).toContain('no free build slot before the wait budget elapsed"; return 124')
	})
})
