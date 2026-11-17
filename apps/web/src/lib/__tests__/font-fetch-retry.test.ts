import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildLockShell } from '../build-lock'
import { buildBuilderScript } from '../builder'
import { FONT_FETCH_RETRY_DELAY_SEC, childTimeoutPrefix, fontFetchRetryShellFunctions } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

// A local build that fails on next/font fetching fonts.googleapis.com at build time
// is retried once; every other build
// failure still fails at once with the build's own exit code.

const FONT_FAIL = `#14 10.69 Failed to compile.
#14 10.69 app/layout.tsx
#14 10.69 An error occurred in \`next/font\`.
#14 10.69 TypeError: Cannot read properties of null (reading '1')
#14 10.69     at /app/node_modules/next/dist/compiled/@next/font/dist/google/loader.js:122:78
`
const FETCH_FAIL = `#14 9.1 \`next/font\` error:
#14 9.1 Failed to fetch font \`Inter\`: https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap
#14 9.1 Please check your network connection.
`
const GOOGLE_FAIL = '#14 9.1 `next/font` error:\n#14 9.1 Failed to fetch `Roboto Mono` from Google Fonts.\n'
const TURBO_FAIL =
	'#14 9.1 Error while requesting resource\n#14 9.1 There was an issue establishing a connection while requesting https://fonts.googleapis.com/css2?family=Inter.\n'
const VALIDATION = '#14 9.1 `next/font` error:\n#14 9.1 Unknown font `Intter`\n'
const TYPE_ERROR = "#14 12.0 Failed to compile.\n#14 12.0 ./app/page.tsx:3:7\n#14 12.0 Type error: Type 'string' is not assignable to type 'number'.\n"

const work = mkdtempSync(join(tmpdir(), 'font-retry-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** bash -n on the script as a file (too long for an argv `-c`). */
function syntaxOk(script: string): boolean {
	const f = join(work, `syn-${Math.random().toString(36).slice(2)}.sh`)
	writeFileSync(f, script)
	return spawnSync('bash', ['-n', f]).status === 0
}

// font_retry's mktemp honours TMPDIR: every run here gets this private dir, so another
// suite or checkout writing to the shared /tmp cannot change what these tests count.
const ownTmp = mkdtempSync(join(work, 'tmp-'))
const outFiles = () => readdirSync(ownTmp).filter((f) => f.startsWith('powder-build-out.'))

/** Run font_retry on a fake `docker` that prints OUTS[n] and exits with RCS[n] on call n. */
function run(outs: string[], rcs: number[], opts: { canRetry?: string; beforeRetry?: string } = {}) {
	const dir = mkdtempSync(join(work, 'r-'))
	const bin = join(dir, 'bin')
	spawnSync('mkdir', ['-p', bin])
	outs.forEach((o, i) => writeFileSync(join(dir, `out${i}`), o))
	writeFileSync(
		join(bin, 'docker'),
		`#!/bin/bash
n=$(cat "$W/n" 2>/dev/null || echo 0); echo $((n+1)) > "$W/n"
echo "[docker] $*" >> "$W/calls"
cat "$W/out$n" 2>/dev/null; echo "stderr line $n" >&2
rcs=(${rcs.join(' ')}); exit "\${rcs[$n]:-0}"
`,
	)
	writeFileSync(join(bin, 'sleep'), `#!/bin/bash\necho "$1" >> "$W/sleeps"\n`)
	chmodSync(join(bin, 'docker'), 0o755)
	chmodSync(join(bin, 'sleep'), 0o755)
	const script =
		'set -e; ' +
		'el_guard() { echo guard >> "$W/guards"; }; ' +
		fontFetchRetryShellFunctions(opts.canRetry, opts.beforeRetry) +
		'pb_build() { docker compose build app; } && el_guard && font_retry pb_build; rc=$?; echo "after rc=$rc"'
	const r = spawnSync('bash', ['-c', `${script}`], { encoding: 'utf8', env: { ...process.env, TMPDIR: ownTmp, W: dir, PATH: `${bin}:${process.env.PATH}` } })
	const read = (f: string) => {
		try {
			return readFileSync(join(dir, f), 'utf8')
		} catch {
			return ''
		}
	}
	return { status: r.status, out: r.stdout + r.stderr, calls: read('calls').trim().split('\n').filter(Boolean).length, sleeps: read('sleeps').trim(), guards: read('guards').trim().split('\n').filter(Boolean).length }
}

describe('font_retry (next/font Google Fonts fetch failure)', () => {
	it('a font fetch failure: fails once, retries once after the delay, the deploy goes on', () => {
		const before = outFiles()
		const r = run([FONT_FAIL, 'built\n'], [17, 0])
		expect(r.status).toBe(0)
		expect(r.out).toContain('after rc=0')
		expect(r.calls).toBe(2)
		expect(r.sleeps).toBe(String(FONT_FETCH_RETRY_DELAY_SEC))
		expect(r.out).toMatch(/\[retry\] build failed \(rc=17\) on a next\/font Google Fonts fetch error/)
		// output (stdout and stderr) still streams to the log on both attempts
		expect(r.out).toContain("TypeError: Cannot read properties of null (reading '1')")
		expect(r.out).toContain('stderr line 0')
		expect(r.out).toContain('built')
		expect(r.out).toContain('stderr line 1')
		expect(outFiles()).toEqual(before)
	})
	it.each([
		['Failed to fetch font', FETCH_FAIL],
		['Failed to fetch `X` from Google Fonts', GOOGLE_FAIL],
		['a failed request to fonts.googleapis.com', TURBO_FAIL],
	])('retries on %s', (_n, out) => {
		const r = run([out, ''], [1, 0])
		expect(r.status).toBe(0)
		expect(r.calls).toBe(2)
	})
	it('a second font failure fails with the build exit code (one retry only)', () => {
		const before = outFiles()
		const r = run([FONT_FAIL, FONT_FAIL], [17, 23])
		expect(r.status).toBe(23)
		expect(r.calls).toBe(2)
		expect(r.out).not.toContain('after rc=')
		expect(outFiles()).toEqual(before)
	})
	it.each([
		['a type error', TYPE_ERROR],
		['a next/font validation error', VALIDATION],
		['no output at all', ''],
	])('%s fails at once with its own exit code, no retry, no delay', (_n, out) => {
		const before = outFiles()
		const r = run([out], [42])
		expect(r.status).toBe(42)
		expect(r.calls).toBe(1)
		expect(r.sleeps).toBe('')
		expect(r.out).not.toContain('[retry]')
		expect(outFiles()).toEqual(before)
	})
	it('a passing build runs once and keeps rc 0', () => {
		const r = run(['ok\n'], [0])
		expect(r.status).toBe(0)
		expect(r.calls).toBe(1)
		expect(r.out).toContain('ok')
	})
	it('re-runs the guards before the retry; a failing guard stops it', () => {
		expect(run([FONT_FAIL, ''], [1, 0], { beforeRetry: 'el_guard' }).guards).toBe(2)
		const r = run([FONT_FAIL, ''], [1, 0], { beforeRetry: 'false' })
		expect(r.status).not.toBe(0)
		expect(r.calls).toBe(1)
	})
	it('no retry when the budget check says no', () => {
		const r = run([FONT_FAIL, ''], [17, 0], { canRetry: 'false' })
		expect(r.status).toBe(17)
		expect(r.calls).toBe(1)
		expect(r.out).toContain('not enough deploy budget is left')
	})
})

describe('font_retry temp file on a kill', () => {
	it('a deadline TERM during the build: the EXIT trap removes the output file', () => {
		const before = outFiles()
		const dir = mkdtempSync(join(work, 'k-'))
		const bin = join(dir, 'bin')
		spawnSync('mkdir', ['-p', bin])
		writeFakeDocker(bin, '#!/bin/bash\necho building\nls "$TMPDIR"\nkill -TERM "$MAIN"\nexit 1\n')
		const script =
			`set -e; export MAIN=$$; trap 'rm -f "\${__ffo:-}"' EXIT; trap 'exit 124' TERM; ` +
			fontFetchRetryShellFunctions() +
			'font_retry docker build; echo unreachable'
		const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: ownTmp, PATH: `${bin}:${process.env.PATH}` } })
		expect(r.status).toBe(124)
		expect(r.stdout).not.toContain('unreachable')
		// the output file was created in TMPDIR, not in the shared /tmp
		expect(r.stdout).toMatch(/^powder-build-out\./m)
		expect(outFiles()).toEqual(before)
	})
})

describe('font_retry wiring', () => {
	const base = {
		workingDir: '/opt/apps/app',
		configFile: '/opt/apps/app/docker-compose.yml',
		service: 'app',
		cf: "-f '/opt/apps/app/docker-compose.yml'",
		declaredMode: 'build',
		prebuilt: false,
		infra: [],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
	}
	it('the local build runs under font_retry, gated on the deploy budget, guards re-run', () => {
		const s = buildDeployScript(base)
		expect(s).toContain('font_retry() { ')
		expect(s).toContain('if [ "$(left 240)" -ge 300 ]; then ')
		expect(s).toContain('el_guard || return $?')
		const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		expect(s).toMatch(
			new RegExp(`${esc(`pb_build() { flock -w "$(left 300)" ${buildLockShell()} env DL="$DEADLINE" bash -c `)}.* build (--pull )?'app' 2>&1; \\} && `),
		)
		expect(s).toContain('el_guard &&   font_retry pb_build; ')
		expect(s).toContain('rm -f "${__ffo:-}"; tg_stop;')
		expect(syntaxOk(s)).toBe(true)
	})
	it('a prebuilt (builder) deploy has no local build to retry', () => {
		expect(buildDeployScript({ ...base, prebuilt: true, stageImage: 'app:build-x' })).not.toContain('font_retry pb_build')
	})
	it('the builder build runs under the same font_retry, gated on its own budget', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/x',
			keyPath: '/opt/builds/x.k',
			repoUrl: 'git@github.com:o/r.git',
			branch: 'main',
			sha: null,
			image: 'app:latest',
			uniq: 'app:builder-x',
			ctx: '/opt/builds/x/src',
			df: '/opt/builds/x/src/Dockerfile',
			buildArgs: '',
			budgetSec: 1200,
		})
		expect(s).toContain('font_retry() { ')
		expect(s).toMatch(/DEADLINE=\$\(\( \$\(date \+%s\) \+ 1200 \)\)/)
		expect(s).toContain('if [ $(( DEADLINE - $(date +%s) )) -ge 900 ]; then ')
		// each attempt's timeout comes from the builder deadline (minus 60s), after the slot wait
		expect(s).toContain(`font_retry plock 2400 ${childTimeoutPrefix(1800, 60)} docker build --pull `)
		expect(s).not.toContain('timeout 1800 docker build')
		expect(s).toContain('rm -f "${__ffo:-}"')
		expect(syntaxOk(s)).toBe(true)
	})
})
