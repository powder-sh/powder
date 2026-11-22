// The test gate's outcome (deploys.test_gate) comes from the deploy script's own nonced
// mark, never from a log search: a plain "[test-gate] passed" line in build or test
// output counts for nothing. Local path, builder path, prebuilt path, failures.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { buildBuilderScript } from '../builder'
import { DeployStepError, deployFailureFromError, storedTestGate } from '../deploy-failure'
import { composeFileArgs, testGateShell } from '../deploy/fragments'
import { testGateOutcome } from '../deploy/run'
import { buildDeployScript } from '../deploy/script'
import { parseStabilityMarkers, stabilityMarkerFor, testGateResultMark } from '../deploy/stability'
import { writeFakeDocker } from './fixtures/fake-docker'

const NONCE = 'gatenonce1234'
const M = stabilityMarkerFor(NONCE)
const DIGEST = `docker.io/library/node@sha256:${'c'.repeat(64)}`

/** The shared gate fragment under bash with a stub docker; `run` = what `docker run` does. */
function runGate(run: string) {
	const d = mkdtempSync(join(tmpdir(), 'tgr-'))
	mkdirSync(join(d, 'ctx', '.powder'), { recursive: true })
	writeFileSync(join(d, 'ctx', '.powder', 'test.sh'), '#!/bin/sh\necho ok\n')
	writeFakeDocker(
		d,
		`#!/bin/bash\nif [ "$1" = run ]; then ${run}; fi\nif [ "$1 $2" = "image inspect" ]; then case "$*" in *RepoDigests*) echo '${DIGEST}';; *) echo '{}';; esac; fi\nexit 0\n`,
	)
	const frag = testGateShell({ dir: `'${join(d, 'ctx')}'`, label: '/opt/apps/x|x', run: '', tag: '[test-gate]', app: 'x', resultMark: testGateResultMark(NONCE) })
	const r = spawnSync('bash', ['-c', `set -e; ${frag}`], { encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}` } })
	return { status: r.status, out: r.stdout }
}

const scriptOpts = {
	workingDir: '/opt/apps/shop',
	configFile: '/opt/apps/shop/docker-compose.yml',
	service: 'shop',
	cf: composeFileArgs('/opt/apps/shop/docker-compose.yml'),
	declaredMode: 'auto' as const,
	infra: [],
	wantBranch: 'main',
	wantSha: null,
	shaIsStrict: false,
	shaNonce: NONCE,
}

describe('the gate prints its own nonced result', () => {
	it('a real pass: passed', () => {
		const r = runGate('echo "tests ok"; exit 0')
		expect(r.status).toBe(0)
		expect(r.out).toContain('[test-gate] passed')
		expect(parseStabilityMarkers(r.out, NONCE).testGateResult).toBe('passed')
	})
	it('a real failure: failed, even when the tests print a plain pass line', () => {
		const r = runGate('echo "[test-gate] passed"; exit 1')
		expect(r.status).not.toBe(0)
		expect(parseStabilityMarkers(r.out, NONCE).testGateResult).toBe('failed')
	})
	it('a mark printed by the tests without the nonce is ignored', () => {
		const forged = `${stabilityMarkerFor('othernonce99')} test-gate-result passed\n[test-gate] passed\n`
		expect(parseStabilityMarkers(forged, NONCE).testGateResult).toBeNull()
	})
})

describe('the deploy script (local path)', () => {
	const s = buildDeployScript({ ...scriptOpts, prebuilt: false })
	it('runs the gate with the result marks, and the no-test.sh branch prints none', () => {
		expect(s).toContain(`echo '${M} test-gate-result passed'; `)
		expect(s).toContain(`echo '${M} test-gate-result failed'; `)
		expect(s).toContain(`echo '${M} test-gate absent'; echo '${M} test-gate-result none'; fi && `)
	})
	it('a prebuilt deploy prints no result of its own (the builder ran the gate)', () => {
		const pre = buildDeployScript({ ...scriptOpts, prebuilt: true })
		expect(pre).not.toContain('test-gate-result')
	})
})

describe('the builder script', () => {
	const base = {
		dir: '/tmp/b',
		keyPath: '/tmp/k',
		repoUrl: 'git@github.com:o/r.git',
		branch: 'main',
		sha: null,
		image: 'o/r',
		uniq: 'o-r:1',
		ctx: '/tmp/b/src',
		df: '/tmp/b/src/Dockerfile',
		buildArgs: '',
	}
	it('prints the result marks with its own nonce, and none without .powder/test.sh', () => {
		const s = buildBuilderScript({ ...base, shaNonce: NONCE })
		expect(s).toContain(`echo '${M} test-gate-result passed'; `)
		expect(s).toContain(`echo '${M} test-gate-result failed'; `)
		expect(s).toContain(`no .powder/test.sh - skipped"; echo '${M} test-gate-result none'; fi`)
	})
})

describe('testGateOutcome (what is stored)', () => {
	it('a forged plain pass line in build output with no .powder/test.sh stores none', () => {
		const out = `#12 RUN echo "[test-gate] passed"\n[test-gate] passed\n[test-gate] no .powder/test.sh in /opt/apps/x/src - skipped\n${M} test-gate absent\n${M} test-gate-result none\n`
		expect(testGateOutcome(out, NONCE, null)).toBe('none')
	})
	it('a plain pass line and no mark at all stores nothing', () => {
		expect(testGateOutcome('[test-gate] passed\n[builder test-gate] passed\n', NONCE, null)).toBeNull()
	})
	it('a real pass on the app server: passed', () => {
		expect(testGateOutcome(`[test-gate] passed\n${M} test-gate-result passed\n`, NONCE, null)).toBe('passed')
	})
	it('prebuilt: the target has no result of its own, so the builder result is stored', () => {
		const target = `[test-gate] ran on the builder host - skipped here\n${M} test-gate present\n`
		expect(testGateOutcome(target, NONCE, 'passed')).toBe('passed')
		expect(testGateOutcome(`${M} test-gate absent\n`, NONCE, 'none')).toBe('none')
	})
	it("the target's own mark wins over a builder result (a local fallback build ran the gate)", () => {
		expect(testGateOutcome(`${M} test-gate-result failed\n`, NONCE, 'passed')).toBe('failed')
	})
})

describe('failed deploys', () => {
	it('passed the gate, then failed at db migrate: stores passed', () => {
		const err = new DeployStepError('── test gate ──\n[test-gate] passed\n── db migrate ──\nERROR: relation exists\n__POWDER_FAIL__ step=db migrate code=1').withTestGate('passed')
		const f = deployFailureFromError(err)
		expect(f.failedStep).toBe('db migrate')
		expect(f.testGate).toBe('passed')
	})
	it('failed at the test gate: failed, with or without a mark (a refusal inside the gate prints none)', () => {
		expect(deployFailureFromError(new DeployStepError('__POWDER_FAIL__ step=test gate code=1')).testGate).toBe('failed')
		expect(storedTestGate(null, 'test gate')).toBe('failed')
	})
	it('died before the gate: not recorded', () => {
		expect(deployFailureFromError(new DeployStepError('__POWDER_FAIL__ step=build code=1')).testGate).toBeNull()
		expect(deployFailureFromError(new Error('ssh dropped')).testGate).toBeNull()
	})
	it('a builder test failure is stored as failed', () => {
		expect(new DeployStepError('__POWDER_FAIL__ step=test gate code=1').withTestGate('failed').testGate).toBe('failed')
	})
	it('a failure carries the commit the run built (for the commit status), only a full sha', () => {
		const B = 'b'.repeat(40)
		expect(deployFailureFromError(new DeployStepError('__POWDER_FAIL__ step=test gate code=1').withBuiltSha(B)).builtSha).toBe(B)
		expect(new DeployStepError('x').withBuiltSha('not-a-sha').builtSha).toBeNull()
		expect(deployFailureFromError(new Error('ssh dropped')).builtSha).toBeNull()
	})
})
