// Writer/reader contract of the failure summary (deploy-failure.ts): every line
// powder's deploy code prints for the reader, taken from the code that prints it
// (the rendered scripts, the exported constants), must still be recognised. A
// reworded script line fails here instead of turning into "failed during: <step>".
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBuilderScript } from '../builder'
import { classifyBuilderFailure } from '../builder-failure'
import { failedDeployCopyBlock } from '../deploy-copy'
import { errorToStore } from '../deploy-log'
import { terminalCommitStatuses } from '../github-commit-status'
import {
	DeployStepError,
	TOOL_VERDICT_LINE_RE,
	deployFailureFromError,
	failureStepKind,
	isToolCauseLine,
	maskedFailedStep,
	opsEventErrorText,
	opsEventFailureFields,
	parseDeployFailure,
	stepOnlySummary,
	summarizeDeployFailure,
} from '../deploy-failure'
import { testGateShell } from '../deploy/fragments'
import { builtShaMarkerFor, stabilityMarkerFilter, stabilityMarkerFor, stripStabilityMarkers, syncedShaMarkerFor } from '../deploy/stability'
import { GIT_REMOTE_UNREADABLE } from '../deploy/tool-lines'
import { safeFailedStep, summaryBeyondStep } from '../notify-text'
import { redactSecrets } from '../secret-text'
import { buildDeployScript, composeFileArgs } from '../ssh'
import { DEPLOY_FAILURE_LOG_CASES } from './fixtures/deploy-failure-logs'
import { FX } from './fixtures/secret-corpus'

const LIB = join(__dirname, '..')
const src = (rel: string) => readFileSync(join(LIB, rel), 'utf8')

const WD = '/opt/apps/demo'
const NONCE = 'abcdef0123456789abcdef01'
const render = (over: Partial<Parameters<typeof buildDeployScript>[0]> = {}) =>
	buildDeployScript({
		workingDir: WD,
		configFile: `${WD}/docker-compose.yml`,
		service: 'app',
		cf: composeFileArgs(`${WD}/docker-compose.yml`),
		declaredMode: 'build',
		prebuilt: false,
		migrateApp: 'demo',
		infra: ['db'],
		wantBranch: 'main',
		wantSha: null,
		shaIsStrict: false,
		swapOrdinal: 1700000000000,
		stageId: 'dep_x',
		shaNonce: NONCE,
		composeHash: 'a'.repeat(64),
		composeGuardEnforce: true,
		swapCheck: { path: '/api/health', strict: true, host: 'demo.example.com' },
		...over,
	})

/** Every deploy script powder can render for an app (the paths that print different lines). */
const SCRIPTS = [
	render(),
	render({ prebuilt: true, stageImage: 'demo:build-x' }),
	render({ declaredMode: 'registry' }),
	render({ declaredMode: 'auto', composeGuardEnforce: false, composeGuardRecheck: true }),
	render({ swapCheck: { skip: 'no health url' }, swapOrdinal: undefined }),
	render({ drain: true }),
]
const BUILDER = buildBuilderScript({
	dir: '/opt/builds/demo',
	keyPath: '/opt/builds/demo.k',
	repoUrl: 'git@github.com:example-org/demo.git',
	branch: 'main',
	sha: null,
	image: 'demo:latest',
	uniq: 'demo:builder-x',
	ctx: '/opt/builds/demo/src',
	df: 'Dockerfile',
	buildArgs: '',
	shaNonce: NONCE,
})

/** Step names a rendered script reports (`step "<name>"` / `step '<name>'`). */
function renderedSteps(script: string): string[] {
	return [...script.matchAll(/(?:^|[\s;&{(|])step (?:"([^"$]{1,120})"|'([^'$]{1,120})')/g)].map((m) => m[1] ?? m[2] ?? '')
}

/** Lines the target-commit link check prints into a captured variable: the deploy
 *  prints them indented under its own "<who>: refusing the git sync, ...:" line
 *  (target-links.ts), which is the cause line the reader takes, with the first of them.
 *  Shrink-only. */
const CAPTURED = [
	'cannot create a temp dir',
	'cannot list the tree of the target commit',
	'cannot read the symlink 7',
	'cannot read the symlink targets of the target commit',
	'a tracked symlink target holds a control character (NUL)',
]

/** Info lines the extraction finds because a non-zero exit follows within its reach
 *  on another branch; none of them is printed for a failure. Shrink-only. */
const INFO_BEFORE_EXIT = [
	'[git-harden] removed 7/commondir (a checkout powder syncs is never a linked worktree)',
	'swap-check: attempt 7/12: 7',
	'[pages-test-files] all offenders under 7:',
	'[build-cache] WARN cannot write the per-app override dir; using 7 for this deploy',
	'[has-infra] ensuring infra is up (no recreate): 7',
]

/** git's own wording, printed by powder's git wrapper (git-harden.ts) where git would
 *  print it: read in a git step by its `fatal:` rule, not as powder's line. */
const GIT_WORDING = ['fatal: not a git repository: 7']

/** The text of every `echo` the script runs right before a non-zero exit (the
 *  lines written for the reader), with shell expansions replaced by a digit. */
function linesBeforeExit(script: string): string[] {
	const out: string[] = []
	const push = (raw: string) => {
		const line = raw.replace(/\$\([^)]*\)|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*]/g, '7')
		// a run's nonced markers are read by their own parsers, never by the summary;
		// a bare expansion (`printf '%s\n' "$OUT"`) prints captured text, not powder's words
		if (line.startsWith('__POWDER_') || /^7?$/.test(line.trim())) return
		if (!CAPTURED.includes(line) && !INFO_BEFORE_EXIT.includes(line)) out.push(line)
	}
	// the non-zero exit may come a statement or two later (`echo ...; printf ...; CR_RC=1`):
	// up to 240 characters on, with no other echo in between (a printf of captured detail may sit there)
	const exit = (not: string) => String.raw`(?:(?!(?:${not}) )[^\n]){0,240}?(?:(?:exit|return) [1-9]|\b[A-Z][A-Z0-9_]{0,30}_RC=[1-9])`
	for (const m of script.matchAll(new RegExp(String.raw`echo (?:"((?:[^"\\]|\\.){1,1200}?)"|'([^']{1,1200})')${exit('echo')}`, 'g'))) push(m[1] ?? m[2] ?? '')
	// the same for printf: `printf '%s\n' "<text>"` and `printf '<text>\n'`
	for (const m of script.matchAll(new RegExp(String.raw`printf (?:'%s\\n' (?:"((?:[^"\\]|\\.){1,1200}?)"|'([^']{1,1200})')|'((?:[^'%]|%%){1,1200}?)\\n')${exit('echo')}`, 'g')))
		push(m[1] ?? m[2] ?? m[3] ?? '')
	return out
}

describe('step names: every step the scripts report has a kind', () => {
	it('the rendered deploy and builder scripts', () => {
		const steps = new Set([...SCRIPTS, BUILDER].flatMap(renderedSteps))
		expect(steps.size).toBeGreaterThanOrEqual(20)
		for (const s of steps) expect(failureStepKind(s), s).not.toBeNull()
		// the env file link guard's steps are rendered with their place
		expect(failureStepKind('env file links (swap)')).toBe('guard')
	})
	it('the self-deploy script and the trailers powder writes itself', () => {
		const names = new Set<string>()
		for (const f of ['deploy/self-deploy.ts', 'deploy/run.ts', 'deploy-runner.ts', 'deploy/compose-check.ts', 'builder.ts']) {
			const text = src(f)
			for (const s of renderedSteps(text)) names.add(s)
			for (const m of text.matchAll(/__POWDER_FAIL__ step=([a-z][a-z .()/+,-]{0,80}?) code=/g)) names.add(m[1] ?? '')
		}
		expect(names.size).toBeGreaterThanOrEqual(10)
		for (const s of names) expect(failureStepKind(s), s).not.toBeNull()
	})
	it('a step with no evidence keeps its own punctuation, the same name the banner shows', () => {
		const step = 'docker compose build (local build)'
		expect(String(parseDeployFailure(`── ${step} ──\n__POWDER_FAIL__ step=${step} code=1`).errorSummary)).toBe(`failed during: ${step}`)
		expect(stepOnlySummary(step)).toBe(`failed during: ${step}`)
		// a step powder does not print is normalised as before
		expect(stepOnlySummary('@everyone [x](http://evil)')).toMatch(/^failed during: [a-z0-9 _:-]+$/)
	})
})

describe("powder's own lines: every line printed before a non-zero exit is read", () => {
	const all = [...new Set([...SCRIPTS, BUILDER].flatMap(linesBeforeExit))]
	it('finds the lines', () => {
		expect(all.length).toBeGreaterThanOrEqual(40)
		expect(all.some((l) => l.startsWith('preflight: '))).toBe(true)
		expect(all.some((l) => l.startsWith('[build-cache] refusing'))).toBe(true)
		expect(all.some((l) => /guard: refusing/.test(l))).toBe(true)
	})
	it('each is a cause line (the summary) or a verdict line (the reader looks above it)', () => {
		const unread = all.filter((l) => !isToolCauseLine(l, null) && !TOOL_VERDICT_LINE_RE.test(l) && !GIT_WORDING.includes(l))
		expect(unread).toEqual([])
		for (const l of GIT_WORDING)
			expect(String(parseDeployFailure(`── git rev-parse ──\n${l}\n__POWDER_FAIL__ step=git rev-parse code=1`).errorSummary)).toBe(`git failed: ${l}`)
	})
	it('a cause line becomes the summary of a guard step', () => {
		for (const l of all.filter((x) => isToolCauseLine(x, null) && !x.startsWith(GIT_REMOTE_UNREADABLE) && !x.startsWith('swap-check: FAILED ('))) {
			const s = String(summarizeDeployFailure({ step: 'preflight', exitCode: 1, log: `── preflight ──\n${l}\n` }))
			expect(s, l).toBe(String(summarizeDeployFailure({ step: 'preflight', exitCode: 1, log: l.slice(0, 400) })))
			expect(s, l).not.toMatch(/^failed during/)
		}
	})
	it("the captured link-check lines are read under the git sync's own refusal line", () => {
		const head = render().match(/echo "(deploy: refusing the git sync, [^"]{1,300}:)"; printf '%s\\n' "\$TL_OUT" \| head -n 20 \| sed 's\/\^\/ {2}\/'/)?.[1]
		expect(head).toBeTruthy()
		for (const detail of CAPTURED) {
			const log = `── git sync (force src/ to GitHub) ──\n${head}\n  ${detail}\n__POWDER_FAIL__ step=git sync (force src/ to GitHub) code=1`
			expect(String(parseDeployFailure(log).errorSummary)).toBe(`${detail} (${head?.slice(0, -1)})`)
		}
	})
	it("powder-migrate's refusals (infra/powder-migrate)", () => {
		const text = readFileSync(join(LIB, '../../../../infra/powder-migrate'), 'utf8')
		const lines = linesBeforeExit(text).filter((l) => l.startsWith('[migrate]'))
		expect(lines.length).toBeGreaterThanOrEqual(10)
		for (const l of lines) {
			const s = String(parseDeployFailure(`── db migrate ──\n${l}\n__POWDER_FAIL__ step=db migrate code=1`).errorSummary)
			expect(s, l).not.toMatch(/^failed during/)
		}
	})
})

describe('the test gate', () => {
	const gate = testGateShell({ dir: '"$TG_DIR"', label: 'demo|app', run: 'timeout 900', tag: '[test-gate]', enforce: true, app: 'demo' })
	it('its FAILED line is a verdict (the tests above it are the cause), its refusals are causes in the gate', () => {
		const lines = linesBeforeExit(gate)
		const failed = gate.match(/echo "(\[test-gate\] FAILED \(exit )\$TG_RC(\)[^"]*)"/)
		expect(failed).not.toBeNull()
		expect(TOOL_VERDICT_LINE_RE.test(`${failed?.[1]}1${failed?.[2]}`)).toBe(true)
		const refusals = lines.filter((l) => l.startsWith('[test-gate] refusing'))
		expect(refusals.length).toBeGreaterThanOrEqual(4)
		for (const l of refusals) expect(isToolCauseLine(l, 'test'), l).toBe(true)
		// the app's own output in the gate is not read as a tool line
		expect(isToolCauseLine('deploy: the test suite logs this', 'test')).toBe(false)
	})
	it('the builder gate prints the same banner the reader cuts the region at', () => {
		expect(BUILDER).toContain("echo '── test gate ──'")
		expect(BUILDER).toMatch(/\[builder test-gate\] FAILED \(exit \$TG_RC\)/)
	})
})

describe('the git remote preflight', () => {
	it('both scripts print the line from the constant the reader matches', () => {
		expect(render()).toContain(`echo "${GIT_REMOTE_UNREADABLE} - the deploy would build`)
		expect(src('deploy/self-deploy.ts')).toContain('echo "${GIT_REMOTE_UNREADABLE} - the deploy would build')
	})
	it("reads the printed line, whatever the cut git output holds", () => {
		const printed = render().match(/echo "(preflight: cannot read the git remote[^"]{0,200}?) remote=/)?.[1]
		expect(printed).toBeTruthy()
		for (const tail of ['Please make sure you have the correct access rights and the repository exists.', 'fatal: unable to access the remote', '']) {
			const log = `── preflight git auth ──\n${printed} remote=git@github.com:example-org/demo.git :: ${tail} \npreflight: check the deploy key at /opt/apps/demo/.deploy-key, the ssh-config Host alias, or the token in the remote URL.\n__POWDER_FAIL__ step=preflight git auth code=1`
			expect(String(parseDeployFailure(log).errorSummary), tail).toMatch(/^git auth failed: powder cannot read the git remote/)
		}
	})
})

describe('swap-check', () => {
	it("reads its FAILED line and the candidate's log between the banners it prints", () => {
		const s = render()
		const fn = s.match(/swap_fail\(\) \{ echo "swap-check: FAILED \(\$1\)"; [^}]*echo "(── last 200 log lines of )\$SC_NAME ──"[^}]*echo "(── end of )\$SC_NAME( logs ──)"/)
		expect(fn).not.toBeNull()
		const log = [
			'── swap-check ──',
			'swap-check: FAILED (candidate exited (code 3))',
			`${fn?.[1]}demo-next ──`,
			'Error: listen EADDRINUSE: address already in use :::3000',
			`${fn?.[2]}demo-next${fn?.[3]}`,
			'swap-check: old container untouched, not swapping',
			'__POWDER_FAIL__ step=swap-check code=1',
		].join('\n')
		expect(String(parseDeployFailure(log).errorSummary)).toBe(
			'swap-check: FAILED (candidate exited (code 3)): Error: listen EADDRINUSE: address already in use :::3000',
		)
	})
})

describe('internal marker lines are stripped from the log and the error by one rule', () => {
	const sha = '1'.repeat(40)
	it("the synced-sha marker the deploy script prints, the builder's built-sha marker and the stability marks", () => {
		expect(render()).toContain(`echo "${syncedShaMarkerFor(NONCE)} $(`)
		expect(BUILDER).toContain(`echo "${builtShaMarkerFor(NONCE)} $__bs"`)
		const out = [
			'── git sync ──',
			`${syncedShaMarkerFor(NONCE)} ${sha} main`,
			`${stabilityMarkerFor(NONCE)} test-gate present`,
			`${builtShaMarkerFor(NONCE)} ${sha}`,
			'build ok',
			`${syncedShaMarkerFor('other0123456789')} ${sha} main`,
		].join('\n')
		const want = ['── git sync ──', 'build ok', `${syncedShaMarkerFor('other0123456789')} ${sha} main`].join('\n')
		expect(stripStabilityMarkers(out, NONCE)).toBe(want)
		const got: string[] = []
		const live = stabilityMarkerFilter(NONCE, (c) => got.push(c))
		for (const ch of out.split('')) live.push(ch)
		live.flush()
		expect(got.join('')).toBe(want)
	})
	it('the builder phase streams through the filter, so the stored error built from it is clean too', () => {
		const b = src('builder.ts')
		expect(b).toContain('const live = stabilityMarkerFilter(shaNonce, onChunk)')
		expect(b).toMatch(/sshWallMs\(budgetSec\),\s*live\.push,/)
	})
})

describe('one reader of the BuildKit failure line', () => {
	it('only buildkit-log.ts matches "did not complete successfully"', () => {
		const files = readdirSync(LIB, { recursive: true, encoding: 'utf8' }).filter(
			(f) => /\.tsx?$/.test(f) && !f.includes('__tests__') && !f.includes('node_modules'),
		)
		const readers = files.filter((f) => /did not complete successfully/.test(src(f)))
		expect(readers).toEqual(['buildkit-log.ts'])
	})
})

describe('where the summary goes', () => {
	it('every fixture summary fits a GitHub commit status with its cause (one line, at most 140 chars)', () => {
		for (const c of DEPLOY_FAILURE_LOG_CASES) {
			const f = parseDeployFailure(c.log)
			const statuses = terminalCommitStatuses({ ok: false, sha: '1'.repeat(40), failedStep: f.failedStep, errorSummary: f.errorSummary, testGate: f.failedStep === 'test gate' ? 'failed' : null })
			expect(statuses.length, c.name).toBeGreaterThanOrEqual(1)
			for (const st of statuses) {
				expect(st.description.length, c.name).toBeLessThanOrEqual(140)
				expect(st.description, c.name).not.toContain('\n')
				// the cause survives the cut
				expect(st.description, c.name).toContain(c.cause)
			}
		}
	})
})

describe('the ops endpoint event keeps the step where receivers read it', () => {
	/** how a receiver reads the step out of the event text (up to the `·`, trimmed) */
	const RECEIVER_STEP_RE = /failed during:\s*([^·\n]+)/i
	const stepOf = (text: string) => RECEIVER_STEP_RE.exec(text)?.[1]?.trim() ?? null
	const steps = () => {
		const names = new Set([...SCRIPTS, BUILDER].flatMap(renderedSteps))
		for (const f of ['deploy/self-deploy.ts', 'deploy/run.ts', 'deploy-runner.ts', 'deploy/compose-check.ts', 'builder.ts']) {
			const text = src(f)
			for (const s of renderedSteps(text)) names.add(s)
			for (const m of text.matchAll(/__POWDER_FAIL__ step=([a-z][a-z .()/+,-]{0,80}?) code=/g)) names.add(m[1] ?? '')
		}
		names.add('env file links (swap)')
		return [...names]
	}
	it('for every step name the scripts print, the step reads as the old step-only summary printed it', () => {
		const all = steps()
		expect(all.length).toBeGreaterThanOrEqual(30)
		for (const step of all) {
			const before = `failed during: ${safeFailedStep(step)}` // what a step-only summary read before
			const was = stepOf(before)
			expect(was, step).toBeTruthy()
			const cause = redactSecrets('the Dockerfile step RUN npm test failed')
			expect(stepOf(opsEventErrorText(step, cause)), step).toBe(was)
			// a step-only summary is sent as before, with no second "failed during"
			expect(String(opsEventErrorText(step, redactSecrets(stepOnlySummary(step)))), step).toBe(before)
			expect(String(opsEventErrorText(step, redactSecrets(`${stepOnlySummary(step)} (exit 124: a time limit stopped it)`))), step).toBe(`${before} · (exit 124: a time limit stopped it)`)
		}
	})
	it('the event text carries the summary after the step; no step: the summary as it is', () => {
		const s = redactSecrets('test-failure: first failing file: src/a.test.ts')
		expect(String(opsEventErrorText('test gate', s))).toBe('failed during: test gate · test-failure: first failing file: src/a.test.ts')
		expect(String(opsEventErrorText('docker compose build (local build)', s))).toBe('failed during: docker compose build local build · test-failure: first failing file: src/a.test.ts')
		expect(opsEventErrorText(null, s)).toBe(s)
	})
	it('the runner sends it, with the step and exit code as fields', () => {
		const r = src('deploy-runner.ts')
		expect(r).toContain('...opsEventFailureFields(fail.failedStep, fail.exitCode, fail.errorSummary),')
		const f = opsEventFailureFields('docker compose build (local build)', 17, redactSecrets('x failed'))
		expect(f).toEqual({ error: 'failed during: docker compose build local build · x failed', failedStep: 'docker compose build local build', exitCode: 17 })
		expect(opsEventFailureFields(null, undefined, redactSecrets('x failed'))).toEqual({ error: 'x failed', failedStep: null, exitCode: null })
	})
})

describe('the summary is read from the whole step log, before the stored error is cut to its tail', () => {
	it('a cause far above the stored tail still names the summary', () => {
		const step = 'docker compose build (local build)'
		const log = [
			`── ${step} ──`,
			'#14 [builder 6/8] RUN npm run build',
			"#14 1.002 src/lib/cart.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
			...Array.from({ length: 200 }, (_, i) => `#14 2.${i} emitting chunk ${i}`),
			'#14 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 2',
			`__POWDER_FAIL__ step=${step} code=17`,
		].join('\n')
		const fail = deployFailureFromError(new DeployStepError(log))
		expect(String(fail.errorSummary)).toContain('error TS2322')
		// what the runner stores (deploy-runner.ts failDeploy): the tail only, without the cause
		const stored = errorToStore(fail.error, redactSecrets(log))
		expect(stored.length).toBeLessThan(log.length)
		expect(stored).not.toContain('error TS2322')
	})
	it('failDeploy cuts only the error: the summary it stores and sends is the one computed from the whole log', () => {
		const r = src('deploy-runner.ts')
		const body = r.slice(r.indexOf('async function failDeploy('), r.indexOf('\n}\n', r.indexOf('async function failDeploy(')))
		expect(body).toContain('const error = errorToStore(fail.error, redactSecrets(fail.output))')
		expect(body).toContain("finishDeploy(deploy.id, { status: 'failed', ...fail, error, builtSha: commitSha })")
		expect(body).not.toMatch(/parseDeployFailure|summarizeDeployFailure/)
	})
})

describe('a step and its summary are shown together without repeating the step', () => {
	it('summaryBeyondStep drops a summary that only names the step', () => {
		expect(summaryBeyondStep('test gate', 'failed during: test gate')).toBe('')
		expect(summaryBeyondStep('docker compose build (local build)', 'failed during: docker compose build (local build)')).toBe('')
		expect(summaryBeyondStep('docker compose build (local build)', 'failed during: docker compose build local build')).toBe('')
		expect(summaryBeyondStep('test gate', 'failed during: test gate (exit 124: a time limit stopped it)')).toBe('(exit 124: a time limit stopped it)')
		expect(summaryBeyondStep('test gate', 'test-failure: # fail 1')).toBe('test-failure: # fail 1')
	})
	it('no GitHub status, copy block or event reads "failed at <step>: failed during: <step>"', () => {
		for (const step of ['test gate', 'docker compose build (local build)', 'swap-check']) {
			const s = redactSecrets(stepOnlySummary(step))
			for (const st of terminalCommitStatuses({ ok: false, sha: '1'.repeat(40), failedStep: step, errorSummary: s, testGate: 'failed' }))
				expect(st.description, step).not.toMatch(/failed during/)
			expect(String(opsEventErrorText(step, s)).match(/failed during/g)?.length, step).toBe(1)
			expect(failedDeployCopyBlock({ app: 'shop', deployId: 'dep_1', failedStep: step, summary: s, error: 'x' })).not.toMatch(/failed during/)
		}
	})
})

describe('a forged trailer step never carries a secret out', () => {
	const TOKEN = FX.GHP
	const forged = `build https://u:${TOKEN}@x.example.com`
	it('is masked where the trailer is first read, so the stored step, summary and event hold none of it', () => {
		const f = deployFailureFromError(new DeployStepError(`── build ──\nok\n__POWDER_FAIL__ step=${forged} code=1`))
		expect(f.failedStep).toBe('unknown')
		expect(String(f.errorSummary)).not.toContain(TOKEN)
		const ev = opsEventFailureFields(forged, 1, f.errorSummary)
		expect(ev.failedStep).toBe('unknown')
		expect(JSON.stringify(ev)).not.toContain(TOKEN)
		expect(JSON.stringify(ev)).not.toContain('x.example')
		expect(maskedFailedStep('test gate')).toBe('test gate')
	})
})

describe('a fragment of a log line is cut from the redacted line, never the raw one', () => {
	const PW = '86753091'
	const URL = `postgres://admin:${PW}@db.internal:5432/app`
	const STEP = 'docker compose build (local build)'
	const runStep = (...lines: string[]) =>
		[
			`── ${STEP} ──`,
			'#18 [builder 7/9] RUN npm run build',
			'#18 40.10 Error occurred prerendering page "/blog".',
			...lines.map((l) => `#18 40.11 ${l}`),
			'#18 40.20 Export encountered an error on /blog/page: /blog, exiting the build.',
			'#18 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
			`__POWDER_FAIL__ step=${STEP} code=1`,
		].join('\n')
	it('a numeric password in a connection URL never reads as host:port', () => {
		const s = String(parseDeployFailure(runStep('Error: ECONNREFUSED postgres://admin:12345@db.internal:5432/app')).errorSummary)
		expect(s).toMatch(/^ECONNREFUSED/)
		expect(s).not.toContain('12345')
		expect(s).not.toContain('admin')
	})
	it('a password that looks like a port never reads as host:port', () => {
		const s = String(parseDeployFailure(runStep('Error: ECONNREFUSED postgres://app:6543@db.internal:5432/app')).errorSummary)
		expect(s).not.toContain('6543')
		expect(s).not.toContain('app:')
	})
	it('a line cut for display (at 160 chars) is cut after redaction: the cut never keeps half a credential', () => {
		// the cut point lands inside the password of the raw line
		const line = `Error: ${'x'.repeat(130)} ${URL}`
		const s = String(parseDeployFailure(runStep(line)).errorSummary)
		for (let i = 0; i + 4 <= PW.length; i++) expect(s).not.toContain(PW.slice(i, i + 4))
	})
	it("the builder's verdict reason is cut from the redacted output too", () => {
		const out = [
			'#7 [b 2/3] RUN npm test',
			`#7 1.0 Error: ${'x'.repeat(130)} ${URL}`,
			'#7 ERROR: process "/bin/sh -c npm test" did not complete successfully: exit code: 1',
		].join('\n')
		const v = classifyBuilderFailure(out, 1)
		expect(v.kind).toBe('app')
		const reason = v.kind === 'app' ? v.reason : ''
		for (let i = 0; i + 4 <= PW.length; i++) expect(reason).not.toContain(PW.slice(i, i + 4))
	})
	it('a plain address still shows', () => {
		expect(String(parseDeployFailure(runStep('Error: connect ECONNREFUSED 127.0.0.1:5432')).errorSummary)).toMatch(/^ECONNREFUSED to 127\.0\.0\.1:5432: /)
	})
	it('every extraction rule, fed a credential URL in its own fixture shape, shows no part of the password', () => {
		let fed = 0
		for (const c of DEPLOY_FAILURE_LOG_CASES) {
			const log = c.log.includes(c.cause) ? c.log.split(c.cause).join(`${c.cause} ${URL}`) : `${c.log}\n${URL}`
			fed += c.log.includes(c.cause) ? 1 : 0
			const f = parseDeployFailure(log)
			const texts = [
				String(f.errorSummary),
				String(opsEventErrorText(f.failedStep, f.errorSummary)),
				...terminalCommitStatuses({ ok: false, sha: '1'.repeat(40), failedStep: f.failedStep, errorSummary: f.errorSummary, testGate: 'failed' }).map((st) => st.description),
			]
			for (const t of texts) {
				expect(t, c.name).not.toContain(PW)
				for (let i = 0; i + 4 <= PW.length; i++) expect(t, c.name).not.toContain(PW.slice(i, i + 4))
			}
		}
		expect(fed).toBeGreaterThanOrEqual(30)
	})
})
