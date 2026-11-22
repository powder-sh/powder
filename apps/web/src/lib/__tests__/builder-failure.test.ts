// A builder phase that fails on the commit itself (a failing RUN test step, a
// missing Dockerfile, a refused ADD) must fail the deploy at the build step
// instead of rebuilding on the app's server, where it fails the same way. A
// build host fault keeps the local fallback (and its warn card on success).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILD_HOST_RUN_FAILURES, runStepFailure } from './fixtures/build-host-run-failures'
import { BUILDER_FAILURE_CASES, CHECK_STEP_HEAP_OOM, LOCKFILE_CASE_REAL_LAST_STEP, lockfileErrorInAPassedStep } from './fixtures/builder-failures'

let result = { code: 1, stdout: '', stderr: '' }
// the builder script as uploaded, and a result built from it (its nonced markers)
let uploaded = ''
let resultFrom: ((script: string) => { code: number; stdout: string; stderr: string }) | null = null

vi.mock('../ssh', async () => {
	const actual = await vi.importActual<typeof import('../ssh')>('../ssh')
	return {
		...actual,
		runCommand: vi.fn(async (_s: unknown, cmd: string) =>
			cmd.includes('powder-builder') && cmd.startsWith('timeout') ? (resultFrom ? resultFrom(uploaded) : result) : { code: 0, stdout: '', stderr: '' },
		),
		writeFileSecret: vi.fn(async () => {}),
		writeFileViaSftp: vi.fn(async (_s: unknown, path: string, content: string) => {
			if (String(path).includes('powder-builder')) uploaded = content
		}),
	}
})
vi.mock('../hq', async () => {
	const actual = await vi.importActual<typeof import('../hq')>('../hq')
	return { ...actual, reportBuildHostDiskToHq: vi.fn(async () => {}) }
})

import { runBuilderPhase } from '../builder'
import { BuilderAppBuildFailedError, builderAppVerdictEnabled, classifyBuilderFailure, isCheckOnlyRunCommand } from '../builder-failure'
import { BuilderTestGateFailedError, DeployStepError } from '../deploy-failure'
import { TEST_GATE_TESTS_FAILED_EXIT } from '../deploy/fragments'
import { extractBuilderFallback } from '../hq'

describe('classifyBuilderFailure on real builder outputs', () => {
	for (const c of BUILDER_FAILURE_CASES) {
		it(`${c.kind}: ${c.name}`, () => {
			expect(classifyBuilderFailure(c.output, c.exit).kind).toBe(c.kind)
		})
	}

	it('every build host fault whose local build passed keeps the fallback', () => {
		const saved = BUILDER_FAILURE_CASES.filter((c) => c.localBuild === 'passed' && c.kind === 'builder')
		expect(saved.length).toBeGreaterThanOrEqual(6)
		for (const c of saved) expect(classifyBuilderFailure(c.output, c.exit)).toEqual({ kind: 'builder' })
	})

	it('names the failed step', () => {
		const v = classifyBuilderFailure(BUILDER_FAILURE_CASES[0]?.output ?? '', 1)
		expect(v).toEqual({
			kind: 'app',
			reason:
				'[mail-relay] ses error name=MessageRejected message=rej | ❯ tests/feedback-widget.test.ts (10 tests | 10 failed) 49ms | AssertionError: expected 502 to be 200 (the Dockerfile step RUN npm test)',
		})
	})

	it('no verdict against the app without an exit code, on exit 0 or on a kill / ssh exit code', () => {
		const out = BUILDER_FAILURE_CASES[0]?.output ?? ''
		for (const code of [null, 0, 124, 128, 137, 143, 255]) expect(classifyBuilderFailure(out, code).kind).toBe('builder')
	})

	it('a build or install step with no proof against the commit keeps the fallback, whatever it printed', () => {
		for (const lines of [[], ['compiling'], ['Error: something went wrong'], ['error Command failed with exit code 1.']])
			for (const cmd of ['npm run build', 'npm ci', 'pnpm build', 'make'])
				expect(classifyBuilderFailure(runStepFailure(cmd, lines), 1), `${cmd}: ${lines}`).toEqual({ kind: 'builder' })
	})

	it(`${BUILD_HOST_RUN_FAILURES.length + 1} build host failures in a RUN step all keep the fallback`, () => {
		expect(BUILD_HOST_RUN_FAILURES.length).toBe(58)
		for (const [label, cmd, lines] of BUILD_HOST_RUN_FAILURES) expect(classifyBuilderFailure(runStepFailure(cmd, lines), 1), label).toEqual({ kind: 'builder' })
		expect(classifyBuilderFailure(runStepFailure('npm run build', ['...'], 137), 1)).toEqual({ kind: 'builder' })
	})

	it('the proof lines: a rejected lockfile and a TypeScript error', () => {
		const app = (cmd: string, lines: string[]) => classifyBuilderFailure(runStepFailure(cmd, lines), 1)
		expect(app('npm ci', ['npm error code EUSAGE', 'npm error', 'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'])).toEqual({
			kind: 'app',
			reason: 'npm ci rejected the lockfile: package.json and package-lock.json are not in sync (the Dockerfile step RUN npm ci)',
		})
		// EUSAGE alone is any npm usage error
		expect(app('npm ci', ['npm error code EUSAGE']).kind).toBe('builder')
		expect(app('pnpm install --frozen-lockfile', [' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json']).kind).toBe('app')
		expect(app('pnpm install --frozen-lockfile', [' ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.']).kind).toBe('app')
		expect(app('npm run build', ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."])).toEqual({
			kind: 'app',
			reason: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'. (the Dockerfile step RUN npm run build)",
		})
		expect(app('npm run build', ['Failed to type check.']).kind).toBe('app')
	})

	it('BuildKit store errors (what a prune under a build leaves) are not a missing file', () => {
		for (const line of [
			'failed to compute cache key: failed to get state for index 0 on [deps 2/3] COPY package.json ./: snapshot sha256:abc does not exist: not found',
			'failed to compute cache key: failed to mount /var/lib/docker/tmp/buildkit-mount123: lease "abc": not found',
			'failed to compute cache key: failed to copy: httpReadSeeker: failed open: content at https://registry-1.docker.io/v2/library/node/blobs/sha256:abc not found: not found',
			'node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: docker.io/library/node:22-alpine: not found',
		])
			expect(classifyBuilderFailure(`ERROR: failed to build: failed to solve: ${line}\n`, 1), line).toEqual({ kind: 'builder' })
		expect(classifyBuilderFailure('ERROR: failed to build: failed to solve: failed to compute cache key: failed to calculate checksum of ref a::b: "/package-lock.json": not found\n', 1)).toEqual({
			kind: 'app',
			reason: 'the Dockerfile copies "/package-lock.json", which is not there (not in the repo, or not produced by the build stage it is copied from)',
		})
	})

	it('a missing COPY source is worded by where it was copied from', () => {
		const err = (path: string) => `ERROR: failed to build: failed to solve: failed to compute cache key: failed to calculate checksum of ref a::b: "${path}": not found\n`
		expect(classifyBuilderFailure(`  41 | >>> COPY --from=builder /app/public ./public\n${err('/app/public')}`, 1)).toEqual({
			kind: 'app',
			reason: 'the Dockerfile copies "/app/public" from an earlier build stage, which did not produce it',
		})
		expect(classifyBuilderFailure(`   7 | >>> COPY package.json package-lock.json ./\n${err('/package-lock.json')}`, 1)).toEqual({
			kind: 'app',
			reason: 'the Dockerfile copies "/package-lock.json", which the repo does not have',
		})
	})

	// The proof must be in the output of the step that failed. A step before it can print
	// the same line and pass (`npm ci || npm install`, `tsc --noEmit || true`).
	describe('a proof line convicts only the step that printed it', () => {
		const S = (n: number, cmd: string, lines: string[], code?: number) =>
			`#${n} [s ${n}/9] RUN ${cmd}\n${lines.map((l) => `#${n} 12.34 ${l}`).join('\n')}\n` +
			(code === undefined ? `#${n} DONE 3.1s\n` : `#${n} ERROR: process "/bin/sh -c ${cmd}" did not complete successfully: exit code: ${code}\n------\nERROR: failed to build: failed to solve: process "/bin/sh -c ${cmd}" did not complete successfully: exit code: ${code}\n`)
		const TS = "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."

		it('real build: the lockfile error of a passed install step is not the reason; the type errors of the failed step are', () => {
			expect(classifyBuilderFailure(lockfileErrorInAPassedStep(LOCKFILE_CASE_REAL_LAST_STEP), 1)).toEqual({
				kind: 'app',
				reason: 'tests/integration/api-profile.test.ts(47,25): error TS2554: Expected 1 arguments, but got 0. (the Dockerfile step RUN npm run build)',
			})
		})

		it('the same build with a build host fault in the last step keeps the fallback', () => {
			for (const lines of [['Killed'], ['Error: read ECONNRESET'], ['Error: ENOSPC: no space left on device, write'], [], ['Error: connect ECONNREFUSED 127.0.0.1:5432']])
				expect(classifyBuilderFailure(lockfileErrorInAPassedStep(lines), 1), String(lines)).toEqual({ kind: 'builder' })
		})

		it('an earlier `tsc --noEmit || true` printed a type error, then the build was killed', () => {
			expect(classifyBuilderFailure(S(7, 'npx tsc --noEmit || true', [TS]) + S(8, 'npm run build', ['Killed'], 1), 1)).toEqual({ kind: 'builder' })
		})

		it("a dependency's postinstall printed a type error before the install died on the network", () => {
			expect(classifyBuilderFailure(S(7, 'npm ci', ['> some-dep@1.0.0 postinstall', "lib/x.ts(3,1): error TS2304: Cannot find name 'foo'.", 'npm error code ECONNRESET', 'npm error network aborted'], 1), 1)).toEqual({ kind: 'builder' })
		})

		it('a type error before the cut of a long output, another step failed after it', () => {
			const out = `${S(6, 'npm run typecheck || echo skip', [TS])}[... output truncated ...]\n${S(9, 'npm run build', ['Error: read ECONNRESET'], 1)}`
			expect(classifyBuilderFailure(out, 1)).toEqual({ kind: 'builder' })
		})

		it('the failed step cannot be told apart (no "#N ERROR" line): no proof', () => {
			expect(classifyBuilderFailure(`#8 1.0 ${TS}\n[... output truncated ...]\n: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1`, 1)).toEqual({ kind: 'builder' })
			expect(classifyBuilderFailure(`[builder] HEAD fix: ${TS}\n${S(8, 'npm run build', ['compiling'], 1)}`, 1)).toEqual({ kind: 'builder' })
		})

		it('a type error needs a file position; a compiler I/O error is the disk', () => {
			const one = (line: string) => classifyBuilderFailure(S(8, 'npm run build', [line], 2), 1).kind
			expect(one("error TS5033: Could not write file '/app/dist/index.js': ENOSPC: no space left on device, write")).toBe('builder')
			expect(one("error TS5033: Could not write file '/app/dist/index.js': EACCES")).toBe('builder')
			expect(one(TS)).toBe('app')
			expect(one("src/a.ts:3:7 - error TS2322: Type 'string' is not assignable to type 'number'.")).toBe('app')
		})

		it('a package that cannot be found is the state of node_modules, a relative module is the commit', () => {
			const one = (line: string) => classifyBuilderFailure(S(8, 'pnpm build', [line], 1), 1).kind
			expect(one("src/a.ts(1,19): error TS2307: Cannot find module 'zod' or its corresponding type declarations.")).toBe('builder')
			expect(one("a.ts(1,1): error TS7016: Could not find a declaration file for module 'x'.")).toBe('builder')
			expect(one("src/test/orders.test.ts(17,22): error TS2307: Cannot find module './route' or its corresponding type declarations.")).toBe('app')
			expect(one("tests/spawn.test.ts(7,27): error TS2307: Cannot find module '../runner/src/claude' or its corresponding type declarations.")).toBe('app')
		})

		it('a step that ran out of memory or disk is no proof, whatever else it printed', () => {
			expect(classifyBuilderFailure(S(8, 'npm run build', ['Failed to type check.', 'Next.js build worker exited with code: null and signal: SIGKILL'], 1), 1)).toEqual({ kind: 'builder' })
			expect(classifyBuilderFailure(S(8, 'npm run build', [TS, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'], 1), 1)).toEqual({ kind: 'builder' })
		})
	})

	describe('a check-only step that ran out of memory or disk keeps the fallback', () => {
		const S = (cmd: string, lines: string[]) => runStepFailure(cmd, lines)
		it('real row: yarn typecheck died on the Node heap limit on the build host and passed locally', () => {
			expect(classifyBuilderFailure(CHECK_STEP_HEAP_OOM, 1)).toEqual({ kind: 'builder' })
		})
		it('the signs, in any case, in the lines of the step itself', () => {
			for (const line of ['Killed', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'error Command failed with signal "SIGABRT".', 'worker exited with signal SIGKILL', 'Exit status 137', 'command exited with code 137', 'Error: ENOSPC: no space left on device, write', 'cp: error writing: No space left on device'])
				expect(classifyBuilderFailure(S('npm test', [line]), 1), line).toEqual({ kind: 'builder' })
		})
		it('a failing test that only mentions them elsewhere, or fails plainly, is still the app', () => {
			expect(classifyBuilderFailure(S('npm test', [' FAIL  tests/a.test.ts', 'AssertionError: expected 1 to be 2']), 1).kind).toBe('app')
			// another step's lines do not count
			expect(classifyBuilderFailure(`#5 1.0 Killed\n${S('npm test', [' FAIL  tests/a.test.ts'])}`, 1).kind).toBe('app')
		})
		it('a check piped or chained into something else is not check-only', () => {
			for (const c of ['npx tsc | tee out', 'npm test || true', 'npm test; npm run build', 'npx tsc --build && node x.js']) expect(isCheckOnlyRunCommand(c), c).toBe(false)
		})
	})

	it('Dockerfile check refusals: a rule on the Dockerfile text is the app, one that depends on the server is not', () => {
		const df = '/opt/builds/0123456789abcdef-demoapp/src/Dockerfile'
		for (const why of ['an ADD source that is a URL is not supported (BuildKit fetches it inside dockerd as root on the host)', 'a RUN --security= flag is not supported (insecure runs the step with every capability): --security=insecure', 'a Dockerfile with control characters other than tab is not supported'])
			expect(classifyBuilderFailure(`[build-cache] refusing ${df}: ${why}\n`, 1).kind, why).toBe('app')
		for (const line of [
			`[build-cache] refusing ${df}: it reads the local image foo:latest (a local build), which is not this app's (another app's code and build secrets). Use a public registry image or this app's own`,
			`[build-cache] refusing ${df}: the Dockerfile changed while it was read`,
			`[build-cache] refusing ${df}: cannot resolve the Dockerfile or the build context ${df}`,
			'[build-cache] refusing: the base image node:22-alpine: cannot pull node:22-alpine anonymously (refused in every guard mode)',
			'[build-cache] refusing: the base image node:22-alpine has no registry digest on this server, so the build cannot be pinned to the image powder checked',
			'[build-cache] refusing: cannot inspect the base image node:22-alpine for ONBUILD triggers (refused in every guard mode)',
			'[build-cache] refusing: the build path pins (/tmp/powder-dfr.x/pins) are gone, so the build cannot be checked against them',
		])
			expect(classifyBuilderFailure(`${line}\n`, 1), line).toEqual({ kind: 'builder' })
	})

	it('a build of another commit than the one asked for keeps the fallback (it builds the commit asked for)', () => {
		const out = BUILDER_FAILURE_CASES.find((c) => c.name === 'RUN npm ci rejects the lockfile of the commit')?.output ?? ''
		const head = 'a'.repeat(40)
		const asked = 'b'.repeat(40)
		expect(classifyBuilderFailure(out, 1, { requestedSha: asked, builtSha: head })).toEqual({ kind: 'builder' })
		expect(classifyBuilderFailure(out, 1, { requestedSha: asked, builtSha: null })).toEqual({ kind: 'builder' })
		expect(classifyBuilderFailure(out, 1, { requestedSha: asked, builtSha: asked }).kind).toBe('app')
		expect(classifyBuilderFailure(out, 1, { requestedSha: null, builtSha: head }).kind).toBe('app')
	})

	it('the last failed RUN step decides', () => {
		const out =
			'#9 ERROR: process "/bin/sh -c npm test" did not complete successfully: exit code: 1\n' +
			'#12 1.0 Error: connect ETIMEDOUT 203.0.113.9:443\n' +
			'ERROR: failed to build: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1'
		expect(classifyBuilderFailure(out, 1).kind).toBe('builder')
	})
})

describe('isCheckOnlyRunCommand', () => {
	it('test, lint and type check commands', () => {
		for (const c of [
			'npm test',
			'npm run lint && npm run docs:check && npm test',
			'yarn typecheck && yarn formatcheck && yarn lint',
			'pnpm --filter @demoapp/api test',
			'npx vitest run',
			'pnpm exec tsc --noEmit',
			'npm run test:unit',
		])
			expect(isCheckOnlyRunCommand(c), c).toBe(true)
	})
	it('install and build commands, and a check chained with one, are not', () => {
		for (const c of ['npm run build', 'npm ci', 'npm test && npm run build', 'pnpm install --frozen-lockfile', 'corepack enable && corepack prepare pnpm@10.21.0 --activate', 'npm run testdata:fetch', ''])
			expect(isCheckOnlyRunCommand(c), c).toBe(false)
	})
})

describe('POWDER_BUILDER_APP_VERDICT', () => {
	it('on by default; off, 0, false and no switch it off', () => {
		expect(builderAppVerdictEnabled({})).toBe(true)
		expect(builderAppVerdictEnabled({ POWDER_BUILDER_APP_VERDICT: 'on' })).toBe(true)
		expect(builderAppVerdictEnabled({ POWDER_BUILDER_APP_VERDICT: '' })).toBe(true)
		for (const v of ['off', 'OFF', ' off ', '0', 'false', 'no']) expect(builderAppVerdictEnabled({ POWDER_BUILDER_APP_VERDICT: v }), v).toBe(false)
	})
})

describe('runBuilderPhase: whose failure', () => {
	const server = { id: 's1', name: 'app-server', host: '203.0.113.5', port: 22 } as never
	const opts = { host: '198.51.100.7', repoUrl: 'git@github.com:example-org/demoapp.git', deployKeyPriv: 'k' } as never
	const facts = { image: 'demoapp:latest', context: '/opt/apps/demoapp/src', dockerfile: 'Dockerfile', args: {}, hasSecrets: false, hasAdditionalContexts: false } as never
	const phase = () => runBuilderPhase(server, opts, facts, 's1-demoapp', { branch: 'main', sha: null, deployId: 'dep_x' })

	beforeEach(() => {
		result = { code: 1, stdout: '', stderr: '' }
		resultFrom = null
	})

	// The builder was asked for A but the branch tip was B: it built and tested B.
	const A = 'a'.repeat(40)
	const B = 'b'.repeat(40)
	const builtMarker = (script: string) => script.match(/__POWDER_BUILT_SHA_[A-Za-z0-9]+__/)?.[0] ?? 'none'
	it('a test failure on the builder carries the commit it built (B), not the requested one', async () => {
		resultFrom = (script) => ({ code: TEST_GATE_TESTS_FAILED_EXIT, stdout: `[builder] built-sha ${B}\n${builtMarker(script)} ${B}\n[builder test-gate] FAILED (exit 1)\n`, stderr: '' })
		const err = await runBuilderPhase(server, opts, facts, 's1-demoapp', { branch: 'main', sha: A, deployId: 'dep_x' }).then(
			() => null,
			(e: unknown) => e,
		)
		expect(err).toBeInstanceOf(BuilderTestGateFailedError)
		expect((err as BuilderTestGateFailedError).builtSha).toBe(B)
	})
	it('an unnonced built-sha line is not taken as the built commit', async () => {
		resultFrom = () => ({ code: TEST_GATE_TESTS_FAILED_EXIT, stdout: `[builder] built-sha ${B}\n__POWDER_BUILT_SHA_forged__ ${B}\n`, stderr: '' })
		const err = await runBuilderPhase(server, opts, facts, 's1-demoapp', { branch: 'main', sha: A, deployId: 'dep_x' }).then(
			() => null,
			(e: unknown) => e,
		)
		expect((err as BuilderTestGateFailedError).builtSha).toBeNull()
	})

	it("the app's failure throws BuilderAppBuildFailedError, a build host fault a plain error", async () => {
		for (const c of BUILDER_FAILURE_CASES) {
			result = { code: c.exit, stdout: c.output, stderr: '' }
			const err = await phase().then(
				() => null,
				(e: unknown) => e,
			)
			expect(err instanceof BuilderAppBuildFailedError, c.name).toBe(c.kind === 'app')
			if (c.kind === 'builder') expect((err as Error).message, c.name).toBe(`builder phase failed (exit ${c.exit})`)
		}
	})

	it('with a commit asked for, a build that does not report that commit keeps the fallback', async () => {
		const c = BUILDER_FAILURE_CASES[0]
		result = { code: 1, stdout: c?.output ?? '', stderr: '' }
		const pinned = await runBuilderPhase(server, opts, facts, 's1-demoapp', { branch: 'main', sha: 'b'.repeat(40), deployId: 'dep_x' }).then(
			() => null,
			(e: unknown) => e,
		)
		expect(pinned instanceof BuilderAppBuildFailedError).toBe(false)
		expect((pinned as Error).message).toBe('builder phase failed (exit 1)')
	})

	it('POWDER_BUILDER_APP_VERDICT=off: a failure of the commit falls back like any other, and the log says why', async () => {
		const c = BUILDER_FAILURE_CASES[0]
		result = { code: 1, stdout: c?.output ?? '', stderr: '' }
		const chunks: string[] = []
		const go = () =>
			runBuilderPhase(server, opts, facts, 's1-demoapp', { branch: 'main', sha: null, deployId: 'dep_x' }, (s) => chunks.push(s)).then(
				() => null,
				(e: unknown) => e,
			)
		process.env.POWDER_BUILDER_APP_VERDICT = 'off'
		try {
			const off = await go()
			expect(off instanceof BuilderAppBuildFailedError).toBe(false)
			expect((off as Error).message).toBe('builder phase failed (exit 1)')
			expect(chunks.join('')).toContain("[builder] POWDER_BUILDER_APP_VERDICT=off: falling back although this looks like the commit's own failure ([mail-relay] ses error")
		} finally {
			delete process.env.POWDER_BUILDER_APP_VERDICT
		}
		// read at each failed phase: back on without a restart of this process
		expect((await go()) instanceof BuilderAppBuildFailedError).toBe(true)
	})

	it('failing test gate tests keep their own error', async () => {
		result = { code: TEST_GATE_TESTS_FAILED_EXIT, stdout: BUILDER_FAILURE_CASES[0]?.output ?? '', stderr: '' }
		await expect(phase()).rejects.toBeInstanceOf(BuilderTestGateFailedError)
	})
})

describe('deploy/run.ts: no local rebuild and no builder card for the app\'s failure', () => {
	const run = readFileSync(join(__dirname, '../deploy/run.ts'), 'utf8')

	it('fails the deploy at the build step before the fallback line is printed', () => {
		const at = run.indexOf('err instanceof BuilderAppBuildFailedError')
		const fallback = run.indexOf('[builder] falling back to a LOCAL build')
		expect(at).toBeGreaterThan(0)
		expect(fallback).toBeGreaterThan(at)
		expect(run.slice(at, fallback)).toContain('throw new DeployStepError(`${builderLog}__POWDER_FAIL__ step=build code=1`)')
	})

	it('the failure reads as step build, and its log line is not a builder-fallback card', () => {
		const log = `${BUILDER_FAILURE_CASES[0]?.output}\n[builder] ${new BuilderAppBuildFailedError('the Dockerfile step RUN npm test failed').message} - not falling back to a local build (the same build would fail there)\n`
		const err = new DeployStepError(`${log}__POWDER_FAIL__ step=build code=1`)
		expect(err.failedStep).toBe('build')
		expect(err.exitCode).toBe(1)
		expect(extractBuilderFallback(log)).toBeNull()
	})

	it("the test gate's own no-fallback line keeps its summary", () => {
		const gate = '── test gate ──\n[builder test-gate] FAILED (exit 1) - NOT swapping; the old container keeps serving the previous version\n[builder] the tests in .powder/test.sh failed on the builder - not falling back to a local build (the same tests would fail there)\n__POWDER_FAIL__ step=test gate code=1'
		const err = new DeployStepError(gate)
		expect(err.failedStep).toBe('test gate')
		expect(String(err.errorSummary)).toBe('failed during: test gate')
		expect(String(err.errorSummary)).not.toContain('your build failed')
	})

	it('the summary says it was the commit and shows the failing lines', () => {
		for (const c of BUILDER_FAILURE_CASES.filter((x) => x.kind === 'app')) {
			const v = classifyBuilderFailure(c.output, c.exit)
			if (v.kind !== 'app') throw new Error(c.name)
			const log = `${c.output}\n[builder] ${new BuilderAppBuildFailedError(v.reason).message} - not falling back to a local build (the same build would fail there)\n`
			const s = String(new DeployStepError(`${log}__POWDER_FAIL__ step=build code=1`).errorSummary)
			expect(s, c.name).toBe(`${v.reason}; your commit's own build failure on the builder (the build host is fine, nothing was rebuilt)`)
		}
		const ts = BUILDER_FAILURE_CASES.find((c) => c.name === 'RUN npm run build fails on a type error')
		expect(ts && classifyBuilderFailure(ts.output, 1)).toEqual({
			kind: 'app',
			reason: "scripts/check-db-gate.ts(57,151): error TS2300: Duplicate identifier 'previousValueOf'. (the Dockerfile step RUN npm run build)",
		})
	})
})
