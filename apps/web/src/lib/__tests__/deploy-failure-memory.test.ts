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
	it('ordinary test failure names the failed tests, with no memory hint', () => {
		const s = parseDeployFailure(gate(ORDINARY, '[test-gate]', 1)).errorSummary
		expect(s).toBe('test-failure: first failing file: src/lib/price.test.ts, Tests 1 failed | 380 passed (381)')
		expect(s).not.toMatch(/heap-oom|container-oom|NODE_OPTIONS/)
	})
	it('a heap message in an earlier step does not leak into a later failure', () => {
		const log = `── docker compose build ──\nJavaScript heap out of memory (retried, ok)\n── test gate ──\n${ORDINARY}\n__POWDER_FAIL__ step=test gate code=1\n`
		const s = parseDeployFailure(log).errorSummary
		expect(s).toMatch(/^test-failure: first failing file: src\/lib\/price\.test\.ts/)
		expect(s).not.toMatch(/heap|NODE_OPTIONS/)
	})
})

// A side worker printed a V8 heap crash,
// the suite went on and failed one assertion. A memory signature only wins when no
// assertion failures are reported after it.
const SIDE_HEAP_THEN_ASSERTION = `> shop@1.0.0 test
> vitest run

 ✓ __tests__/a.test.ts (12 tests) 40ms
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 ✓ __tests__/b.test.ts (3 tests) 10ms
 FAIL  __tests__/pipeline-content.test.ts > pipeline > renders the summary
AssertionError: expected 'a' to be 'b'
 Test Files  1 failed | 233 passed (234)
      Tests  1 failed | 2301 passed (2302)`

const ASSERTION_THEN_HEAP_ABORT = ` FAIL  src/x.test.ts > y
AssertionError: expected 1 to be 2
<--- JS stacktrace --->
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
Aborted (core dumped)`

const WORKER_CRASH_ONLY = `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 FAIL  src/big.test.ts [ src/big.test.ts ]
Error: Worker exited unexpectedly
 Test Files  1 failed | 10 passed (11)`

const NODE_TEST_FAIL = `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
not ok 3 - parses dates
# tests 40
# pass 39
# fail 1`

const NODE_TEST_PASS_COUNT = `# tests 40
# pass 40
# fail 0
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`

const BUILD_STEP = ['docker', 'compose', 'build'].join(' ')
const build = (body: string) =>
	`── ${BUILD_STEP} ──\n#12 [build 6/8] RUN npm run lint && npm run docs:check && npm test\n${body}\nERROR: process "/bin/sh -c npm run lint && npm run docs:check && npm test" did not complete successfully: exit code: 1\n__POWDER_FAIL__ step=${BUILD_STEP} code=1\n`

describe('a heap message does not win over real test failures', () => {
	it('side-process heap crash + assertion failure: not heap-oom', () => {
		expect(classifyMemoryFailure(SIDE_HEAP_THEN_ASSERTION, BUILD_STEP)).toBeNull()
		expect(classifyMemoryFailure(gate(SIDE_HEAP_THEN_ASSERTION, '[test-gate]', 1), 'test gate')).toBeNull()
	})
	it('parseDeployFailure names it a test failure with the first failing file', () => {
		const s = parseDeployFailure(build(SIDE_HEAP_THEN_ASSERTION)).errorSummary
		expect(s).toMatch(/^test-failure: /)
		expect(s).toContain('__tests__/pipeline-content.test.ts')
		expect(s).not.toMatch(/heap-oom|OOM-killed|--max-old-space-size/)
	})
	it('node --test "# fail 1" after a heap message is a test failure', () => {
		expect(classifyMemoryFailure(NODE_TEST_FAIL, 'test gate')).toBeNull()
		expect(parseDeployFailure(gate(NODE_TEST_FAIL, '[test-gate]', 1)).errorSummary).toMatch(/^test-failure: /)
	})
	it('the run aborted on the heap crash (after the failures): heap-oom', () => {
		expect(classifyMemoryFailure(ASSERTION_THEN_HEAP_ABORT, 'test gate')?.kind).toBe('heap-oom')
	})
	it('a file that failed only because its worker died is the crash: heap-oom', () => {
		expect(classifyMemoryFailure(WORKER_CRASH_ONLY, 'test gate')?.kind).toBe('heap-oom')
	})
	it('"# fail 0" is no failure: heap-oom', () => {
		expect(classifyMemoryFailure(NODE_TEST_PASS_COUNT, 'test gate')?.kind).toBe('heap-oom')
	})
	it('an npm test as BuildKit prints it (tests in a RUN step, "#16 84.84 " prefixes): test-failure', () => {
		const log = [
			`── ${BUILD_STEP} ──`,
			'#16 [build 6/8] RUN npm run lint && npm run docs:check && npm test',
			'#16 12.03 > shop@1.0.0 test',
			'#16 12.03 > vitest run',
			'#16 40.11  ✓ __tests__/a.test.ts (12 tests) 40ms',
			'#16 84.84 FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
			'#16 85.02  ✓ __tests__/b.test.ts (3 tests) 10ms',
			'#16 90.50  FAIL  __tests__/pipeline-content.test.ts > pipeline > renders the summary',
			"#16 90.50 AssertionError: expected 'a' to be 'b'",
			'#16 91.08  Test Files  1 failed | 233 passed (244)',
			'#16 91.08       Tests  1 failed | 2301 passed (2302)',
			'#16 ERROR: process "/bin/sh -c npm run lint && npm run docs:check && npm test" did not complete successfully: exit code: 1',
			`__POWDER_FAIL__ step=${BUILD_STEP} code=1`,
		].join('\n')
		const s = parseDeployFailure(log).errorSummary
		expect(s).toMatch(/^test-failure: /)
		expect(s).toMatch(/^test-failure: first failing file: __tests__\/pipeline-content\.test\.ts, /)
		expect(s).not.toMatch(/heap-oom|OOM-killed|--max-old-space-size/)
	})
	it('BuildKit-prefixed "Test Files  0 failed" then a heap abort stays heap-oom', () => {
		const log = [
			`── ${BUILD_STEP} ──`,
			'#16 60.00  Test Files  0 failed | 10 passed (10)',
			'#16 61.20 FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
			'#16 ERROR: process "/bin/sh -c npm test" did not complete successfully: exit code: 134',
			`__POWDER_FAIL__ step=${BUILD_STEP} code=1`,
		].join('\n')
		expect(parseDeployFailure(log).errorSummary).toMatch(/^heap-oom: /)
	})
	it('jest worker deaths are the crash, not assertions: heap-oom', () => {
		for (const crash of [
			'A jest worker process (pid=4242) was terminated by another process: signal=SIGABRT',
			'Call retries were exceeded',
		]) {
			const text = `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nFAIL src/big.test.ts\n  ● Test suite failed to run\n    ${crash}\nTest Suites: 1 failed, 20 passed, 21 total`
			expect(classifyMemoryFailure(text, 'test gate')?.kind).toBe('heap-oom')
		}
	})
	it('the existing heap-oom cases still win', () => {
		expect(parseDeployFailure(gate(TSC_HEAP)).errorSummary).toMatch(/^heap-oom: /)
		expect(parseDeployFailure(build(TSC_HEAP)).errorSummary).toMatch(/^heap-oom: /)
	})
})
