// the builder's fresh clone gets the same symlink authority as every target
// checkout before `docker build` runs on it as root.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBuilderScript, builderCloneShell, builderSymlinkGuardShell } from '../builder'

function repoWith(link: string | null): string {
	const r = mkdtempSync(join(tmpdir(), 'bld-repo-'))
	const git = (...a: string[]) =>
		execFileSync('git', ['-C', r, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
			stdio: 'pipe',
		})
	git('init', '-q', '-b', 'main')
	writeFileSync(join(r, 'Dockerfile'), 'FROM scratch\n')
	if (link) symlinkSync(link, join(r, 'secrets'))
	git('add', '-A')
	git('commit', '-q', '-m', 'x')
	return r
}

function cloneThenGuard(repo: string) {
	const dir = join(mkdtempSync(join(tmpdir(), 'bld-')), 'work')
	mkdirSync(dir)
	return spawnSync(
		'bash',
		[
			'-c',
			`set -e; ${builderCloneShell(dir, repo, null, null)}${builderSymlinkGuardShell(dir)}echo BUILD_REACHED`,
		],
		{ encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } },
	)
}

describe('builder clone symlink guard', () => {
	it('refuses the build when the repo tracks a symlink out of the checkout', () => {
		const r = cloneThenGuard(repoWith('/etc'))
		expect(r.stdout).toMatch(/removed hostile symlink: secrets -> \/etc/)
		expect(r.stdout).not.toMatch(/BUILD_REACHED/)
		expect(r.status).not.toBe(0)
	})
	it('builds a clean repo', () => {
		const r = cloneThenGuard(repoWith(null))
		expect(r.stdout).toMatch(/BUILD_REACHED/)
	})
	it('the builder script runs the guard after the clone and before docker build', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/s-a',
			keyPath: '/tmp/k',
			repoUrl: 'git@github.com:a/b.git',
			branch: 'main',
			sha: null,
			image: 'a',
			uniq: 'a-b1',
			ctx: '/opt/builds/s-a/src',
			df: '/opt/builds/s-a/src/Dockerfile',
			buildArgs: '',
		})
		const guard = s.indexOf(builderSymlinkGuardShell('/opt/builds/s-a'))
		expect(guard).toBeGreaterThan(s.indexOf('clone_all && '))
		expect(guard).toBeLessThan(s.indexOf('docker build'))
	})
})
