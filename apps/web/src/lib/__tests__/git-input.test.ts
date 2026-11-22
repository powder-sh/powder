// Repo URL + branch authority (lib/git-input.ts): git option injection via a
// leading '-', and credentials embedded in a repo URL, are refused everywhere
// the values enter powder (createRepo, repo groups, gitCloneRepo, the repo
// connect route), and positional git args sit behind `--`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GIT_REF_RE, REPO_URL_CREDENTIALS_ERROR, branchProblem, repoUrlProblem } from '../git-input'

describe('repoUrlProblem', () => {
	it('accepts the URL shapes powder uses', () => {
		for (const u of [
			'git@github.com:acme/web.git',
			'ssh://git@github.com/acme/web.git',
			'https://github.com/acme/web.git',
			'git@gh-acme:acme/web.git',
		]) {
			expect(repoUrlProblem(u)).toBeNull()
		}
	})
	it('refuses a leading dash (git option injection)', () => {
		expect(repoUrlProblem('--upload-pack=touch /tmp/x')).toBe('unsafe repo url')
		expect(repoUrlProblem('-uevil')).toBe('unsafe repo url')
	})
	it('refuses credentials in the URL', () => {
		for (const u of [
			'https://x-access-token:ghs_abc123@github.com/acme/web.git',
			`https://ghp_${'abcdef'}@github.com/acme/web.git`,
			'https://user:pw@gitlab.example/acme/web.git',
			'ssh://git:secret@github.com/acme/web.git',
			'git:secret@github.com:acme/web.git',
		]) {
			expect(repoUrlProblem(u)).toBe(REPO_URL_CREDENTIALS_ERROR)
		}
	})
	it('refuses shell and percent characters', () => {
		expect(repoUrlProblem('https://github.com/acme/web.git;id')).toBe('unsafe repo url')
		expect(repoUrlProblem('https://u%3Ap@github.com/a/b')).toBe('unsafe repo url')
	})
})

describe('branchProblem', () => {
	it('accepts normal branches, refuses a leading dash and ..', () => {
		expect(branchProblem('main')).toBeNull()
		expect(branchProblem('feature/x-1')).toBeNull()
		expect(branchProblem('--upload-pack=x')).toBe('unsafe branch name')
		expect(branchProblem('a..b')).toBe('unsafe branch name')
		expect(branchProblem('main;id')).toBe('unsafe branch name')
	})
	it('ssh/git re-exports the same GIT_REF_RE', async () => {
		const git = await import('../ssh/git')
		expect(git.GIT_REF_RE).toBe(GIT_REF_RE)
	})
})

describe('one authority: no local copies of the rule', () => {
	const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
	it('repos.ts and ssh/git.ts use git-input', () => {
		for (const f of ['lib/repos.ts', 'lib/ssh/git.ts']) {
			const s = src(f)
			expect(s).toContain('repoUrlProblem')
			expect(s).not.toMatch(/SAFE_REPO_URL = |\[A-Za-z0-9\._@:\/-\]\+\$\/\.test/)
		}
	})
	it('git clone / ls-remote put `--` before positional args', () => {
		expect(src('lib/ssh/git.ts')).toMatch(/\$\{POWDER_GIT_NOREPO\} clone --branch \$\{shq\(branch\)\} --depth 1 -- /)
		expect(src('lib/builder.ts')).toMatch(/\$\{POWDER_GIT_NOREPO\} clone --depth 1 .*-- \$\{shq\(repoUrl\)\}/)
		expect(src('app/api/servers/[id]/containers/[name]/repo/import/route.ts')).toContain(
			'${POWDER_GIT_NOREPO} ls-remote -- ',
		)
	})
})

describe('gitCloneRepo refuses before running anything', () => {
	it('throws on a dash-led branch or credentialed URL, no command runs', async () => {
		const runCommand = vi.fn()
		vi.doMock('../ssh/connection', () => ({ runCommand }))
		const { gitCloneRepo } = await import('../ssh/git')
		const srv = { id: 's', host: 'h' } as never
		await expect(
			gitCloneRepo(srv, '/opt/apps/a', 'git@github.com:a/b.git', '--upload-pack=x', '/k', 'app:a'),
		).rejects.toThrow('unsafe branch name')
		await expect(
			gitCloneRepo(srv, '/opt/apps/a', 'https://u:tok@github.com/a/b.git', 'main', '/k', 'app:a'),
		).rejects.toThrow(REPO_URL_CREDENTIALS_ERROR)
		expect(runCommand).not.toHaveBeenCalled()
		vi.doUnmock('../ssh/connection')
	})
})
