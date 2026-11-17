import { gitHardenShellFunctions } from '../git-harden'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { builderCloneShell } from '../builder'
import { gitResolveTarget } from '../ssh'

const git = (cwd: string, ...a: string[]) =>
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim()

let work = ''
const sha: Record<string, string> = {}

beforeAll(() => {
	const root = mkdtempSync(join(tmpdir(), 'resolve-'))
	const origin = join(root, 'origin')
	git(root, 'init', '-q', '-b', 'main', origin)
	const commit = (name: string) => {
		writeFileSync(join(origin, name), name)
		git(origin, 'add', '.')
		git(origin, 'commit', '-q', '-m', name)
		return git(origin, 'rev-parse', 'HEAD')
	}
	sha.c1 = commit('c1')
	sha.c2 = commit('c2')
	git(origin, 'checkout', '-q', '-b', 'side')
	sha.side = commit('side')
	git(origin, 'checkout', '-q', 'main')
	sha.c3 = commit('c3')
	sha.c4 = commit('c4')
	work = join(root, 'work')
	git(root, 'clone', '-q', origin, work)
	git(work, 'checkout', '-q', (sha.c2 ?? '')) // currently deployed: c2
	git(work, 'fetch', '-q', 'origin')
})

const resolve = (wanted: string | null, strict = false) => {
	const frag = gitResolveTarget("'*'", 'main', wanted, strict)
	const script = `${gitHardenShellFunctions()}retry() { "$@"; }; ${frag} echo "TARGET=$TARGET"`
	const out = execFileSync('bash', ['-c', script], { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } })
	return { target: /TARGET=(.*)/.exec(out)?.[1] ?? '', out }
}

describe('webhook sha pinning', () => {
	it('pins a sha that is on origin/main and ahead of the deployed commit', () => {
		expect(resolve((sha.c3 ?? '')).target).toBe(sha.c3)
	})
	it('replayed older sha (ancestor of the deployed commit) deploys HEAD', () => {
		const r = resolve((sha.c1 ?? ''))
		// origin/main, resolved to its sha once
		expect(r.target).toBe(sha.c4)
		expect(r.out).toContain('requested sha not on branch head path, deploying HEAD')
	})
	it('a commit that is not on the branch deploys HEAD', () => {
		expect(resolve((sha.side ?? '')).target).toBe(sha.c4)
	})
	it('no sha requested -> origin/branch', () => {
		expect(resolve(null).target).toBe(sha.c4)
	})
})

describe('builder clone pins only the branch tip', () => {
	const clone = (wanted: string | null) => {
		const dir = mkdtempSync(join(tmpdir(), 'bclone-'))
		const origin = join(work, '..', 'origin')
		const sh = builderCloneShell(dir, `file://${origin}`, 'main', wanted)
		const out = execFileSync('bash', ['-c', `set -e; ${sh} echo DONE`], { encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } })
		return { out, head: git(join(dir, 'src'), 'rev-parse', 'HEAD') }
	}
	it('stale (replayed) sha builds HEAD and says so', () => {
		const r = clone((sha.c1 ?? ''))
		expect(r.head).toBe(sha.c4)
		expect(r.out).toContain('requested sha not at branch tip, building HEAD')
	})
	it('sha equal to the tip is pinned', () => {
		const r = clone((sha.c4 ?? ''))
		expect(r.head).toBe(sha.c4)
		expect(r.out).toContain('pinned to commit')
	})
})
