// Memory failures get a stable kind and the right fix: a V8 heap limit (heap-oom: raise
// NODE_OPTIONS=--max-old-space-size on the step) is not a SIGKILL from a memory limit
// (container-oom: raise the limit; the heap flag does not help), and an ordinary test
// failure gets neither hint. Fixtures are trimmed tsc and npm test outputs.
import { describe, expect, it } from 'vitest'
import { DeployStepError, classifyMemoryFailure, parseDeployFailure } from '../deploy-failure'

const gate = (body: string, tag = '[test-gate]', rc = 134) =>
	`── docker compose build ──\nok\n── test gate ──\n${tag} .powder/test.sh present - running in node:22-alpine\n${body}\n${tag} FAILED (exit ${rc}) - NOT swapping; the old container keeps serving the previous version\n__POWDER_FAIL__ step=test gate code=1\n`

const TSC_HEAP = `> shop@0.1.0 typecheck
> tsc --noEmit

<--- Last few GCs --->

[42:0x7f3c1c000]    91234 ms: Mark-Compact 2032.1 (2083.4) -> 2030.9 (2084.1) MB, 1712.33 / 0.00 ms  (average mu = 0.112, current mu = 0.019) allocation failure; scavenge might not succeed

<--- JS stacktrace --->

FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
----- Native stack trace -----
Aborted (core dumped)`

const VITEST_HEAP = `> blog@1.0.0 test
> vitest run

FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`

const KILLED = `> app@1.0.0 test
> vitest run
Killed`

const ORDINARY = ` FAIL  src/lib/price.test.ts > rounds to cents
AssertionError: expected 10.005 to be 10.01
 Test Files  1 failed | 41 passed (42)
      Tests  1 failed | 380 passed (381)`

describe('classifyMemoryFailure', () => {
	it('tsc heap OOM in the test gate is heap-oom with the NODE_OPTIONS hint', () => {
		const r = classifyMemoryFailure(TSC_HEAP, 'test gate')
		expect(r?.kind).toBe('heap-oom')
		expect(r?.summary).toMatch(/^heap-oom: /)
		expect(r?.summary).toContain('NODE_OPTIONS=--max-old-space-size=<MB>')
		expect(r?.summary).toContain('.powder/test.sh')
		expect(r?.summary).toContain('not a code bug')
	})
	it('each V8 signature on its own is heap-oom', () => {
		for (const line of [
			'JavaScript heap out of memory',
			'Reached heap limit',
			'FATAL ERROR: Ineffective mark-compacts near heap limit',
			'Allocation failed - JavaScript heap',
		]) {
			expect(classifyMemoryFailure(line, 'test gate')?.kind).toBe('heap-oom')
		}
	})
	it('a heap OOM in the build names the Dockerfile ENV', () => {
		const r = classifyMemoryFailure(TSC_HEAP, 'docker compose build')
		expect(r?.kind).toBe('heap-oom')
		expect(r?.summary).toContain('docker compose build')
		expect(r?.summary).toContain('ENV before the RUN')
	})
	it('exit 137 from the test gate is container-oom, not the heap flag', () => {
		const r = classifyMemoryFailure(gate(KILLED, '[test-gate]', 137), 'test gate')
		expect(r?.kind).toBe('container-oom')
		expect(r?.summary).toMatch(/^container-oom: /)
		expect(r?.summary).toContain('add memory or swap on the server')
		// the cap is unset by default: the hint holds without knowing the server's env
		expect(r?.summary).toContain('if POWDER_TESTGATE_MEM is set, raise it')
		expect(r?.summary).toContain('NODE_OPTIONS will not help')
	})
	it('a build killed with 137 says add memory or swap and does not name the test gate cap', () => {
		const run = 'ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137'
		const r = classifyMemoryFailure(run, 'docker compose build')
		expect(r?.summary).toContain('add memory or swap on the server')
		expect(r?.summary).not.toContain('POWDER_TESTGATE_MEM')
	})
	it('a docker build RUN killed with 137 and an OOMKilled inspect are container-oom', () => {
		const run = 'ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137'
		expect(classifyMemoryFailure(run, 'docker compose build')?.kind).toBe('container-oom')
		expect(classifyMemoryFailure('"OOMKilled": true', null)?.kind).toBe('container-oom')
	})
	it('the heap signature wins over an exit 137 in the same output', () => {
		expect(classifyMemoryFailure(gate(TSC_HEAP, '[test-gate]', 137), 'test gate')?.kind).toBe('heap-oom')
	})
	it('an ordinary test failure gets no memory hint', () => {
		expect(classifyMemoryFailure(gate(ORDINARY, '[test-gate]', 1), 'test gate')).toBeNull()
		expect(classifyMemoryFailure(ORDINARY, null)).toBeNull()
		// exit 1x7 that is not 137
		expect(classifyMemoryFailure(gate(ORDINARY, '[test-gate]', 1370), 'test gate')).toBeNull()
	})
})

describe('parseDeployFailure carries the memory kind', () => {
	it('local test gate heap OOM', () => {
		const f = parseDeployFailure(gate(TSC_HEAP))
		expect(f.failedStep).toBe('test gate')
		expect(f.errorSummary).toMatch(/^heap-oom: the test gate ran out of Node heap/)
		expect(f.errorSummary).toContain('NODE_OPTIONS=--max-old-space-size=<MB>')
		// not the generic "add memory or swap" OOM line
		expect(f.errorSummary).not.toContain('OOM-killed')
	})
	it('builder test gate heap OOM (the DeployStepError deploy/run.ts throws)', () => {
		const log = `── builder phase (b1) ──\n── test gate ──\n${VITEST_HEAP}\n[builder test-gate] FAILED (exit 134) - NOT swapping\n[builder] the tests in .powder/test.sh failed on the builder - not falling back to a local build (the same tests would fail there)\n__POWDER_FAIL__ step=test gate code=1`
		const e = new DeployStepError(log)
		expect(e.errorSummary).toMatch(/^heap-oom: /)
	})
	it('test gate exit 137', () => {
		expect(parseDeployFailure(gate(KILLED, '[test-gate]', 137)).errorSummary).toMatch(/^container-oom: the test gate was killed/)
	})
	it('ordinary test failure keeps the plain step summary', () => {
		const s = parseDeployFailure(gate(ORDINARY, '[test-gate]', 1)).errorSummary
		expect(s).toBe('failed during: test gate')
		expect(s).not.toMatch(/heap-oom|container-oom|NODE_OPTIONS/)
	})
	it('a heap message in an earlier step does not leak into a later failure', () => {
		const log = `── docker compose build ──\nJavaScript heap out of memory (retried, ok)\n── test gate ──\n${ORDINARY}\n__POWDER_FAIL__ step=test gate code=1\n`
		expect(parseDeployFailure(log).errorSummary).toBe('failed during: test gate')
	})
})
