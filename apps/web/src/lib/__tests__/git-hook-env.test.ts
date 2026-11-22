// Guard: a suite started from a git hook never touches the repository the hook runs in.
// git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the rest of
// `git rev-parse --local-env-vars` to hooks; a test that runs `git init/commit/push`
// in a temp dir with an env built from process.env then acts on the REAL repo
// (a fixture's `git commit` and `git push` then land on the real branch and can replace
// its whole tree). hermetic.ts strips them before any test runs. This file starts a
// nested vitest with those vars pointing at a sentinel repo, runs temp-repo git
// fixtures in it (its own and a real suite test that inherits process.env), and
// checks the sentinel is byte-for-byte unchanged. If it fails, fix hermetic.ts.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_STATE_ENV } from './hermetic'

const INNER = process.env.POWDER_TEST_GIT_HOOK_INNER === '1'
const WEB = resolve(__dirname, '../../..')
const VITEST = join(WEB, 'node_modules/vitest/vitest.mjs')

// as the suite's git tests do: bash with no env option, so it inherits process.env
const sh = (cwd: string, cmd: string) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' })
const COMMIT = 'git -c user.email=a@b.c -c user.name=t commit -qm'

/** Every file under .git and the work tree with its content hash: any write shows. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {}
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n)
			if (statSync(p).isDirectory()) walk(p)
			else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
		}
	}
	walk(dir)
	return out
}

describe.skipIf(INNER)('a suite started from a git hook', () => {
	it('every repository-local git variable is one the hermetic strip removes', () => {
		const r = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
		expect(r.status, r.stderr).toBe(0)
		const vars = r.stdout.split('\n').filter(Boolean)
		expect(vars).toContain('GIT_DIR')
		expect(vars.filter((v) => !HOST_STATE_ENV.test(v))).toEqual([])
	})

	it('leaves the hook repository untouched', { timeout: 180_000 }, () => {
		const sentinel = mkdtempSync(join(tmpdir(), 'sentinel-'))
		writeFileSync(join(sentinel, 'keep.txt'), 'keep\n')
		expect(sh(sentinel, `git init -q -b main && git add -A && ${COMMIT} sentinel`).status).toBe(0)
		const gitDir = join(sentinel, '.git')
		const head = sh(sentinel, 'git rev-parse HEAD').stdout.trim()
		const before = snapshot(sentinel)

		// what git hands a hook, plus the rest of the repo-local vars
		const env = { ...process.env }
		for (const k of Object.keys(env))
			if (k.startsWith('VITEST') || k === 'FORCE_COLOR') delete env[k]
		Object.assign(env, {
			GIT_DIR: gitDir,
			GIT_WORK_TREE: sentinel,
			GIT_INDEX_FILE: join(gitDir, 'index'),
			GIT_COMMON_DIR: gitDir,
			GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'),
			GIT_PREFIX: '',
			GIT_CEILING_DIRECTORIES: '',
			POWDER_TEST_GIT_HOOK_INNER: '1',
			// plain output for the summary match below
			NO_COLOR: '1',
		})
		const r = spawnSync(
			process.execPath,
			[
				VITEST,
				'run',
				'src/lib/__tests__/git-hook-env.test.ts',
				'src/lib/__tests__/testgate-copy.test.ts',
				'-t',
				'(git fixture|git checkout: only committed files)',
			],
			{ cwd: WEB, env, encoding: 'utf8', timeout: 170_000 },
		)
		// the sentinel first: a leak shows as the files it changed, not only as a failed run
		expect(sh(sentinel, 'git rev-parse HEAD').stdout.trim()).toBe(head)
		expect(snapshot(sentinel)).toEqual(before)
		const out = `${r.stdout}\n${r.stderr}`
		expect(r.status, out).toBe(0)
		// both fixtures ran, not filtered out
		expect(out).toMatch(/Tests\s+3 passed/)
	})
})

describe.skipIf(!INNER)('git fixture inside a hook-like env', () => {
	it('git fixture: no repository-local git variable reached the test', () => {
		expect(
			Object.keys(process.env).filter(
				(k) =>
					/^GIT_/.test(k) &&
					k !== 'GIT_CONFIG_NOSYSTEM' &&
					k !== 'GIT_CONFIG_GLOBAL' &&
					k !== 'GIT_CEILING_DIRECTORIES',
			),
		).toEqual([])
	})

	it('git fixture: init, commit, branch and push in a temp repo', () => {
		const root = mkdtempSync(join(tmpdir(), 'fx-'))
		const repo = join(root, 'repo')
		mkdirSync(repo)
		expect(sh(root, 'git init -q --bare remote.git').status).toBe(0)
		writeFileSync(join(repo, 'first.txt'), 'first\n')
		const r = sh(
			repo,
			`git init -q -b main && git add -A && ${COMMIT} first && git branch side && git push -q ../remote.git main`,
		)
		expect(r.status, r.stderr).toBe(0)
		expect(sh(repo, 'git rev-parse --show-toplevel').stdout.trim()).toBe(realpathSync(repo))
	})
})
