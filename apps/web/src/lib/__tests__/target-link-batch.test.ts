// the pre-checkout link check reads every link target of the target tree with
// ONE `git cat-file --batch` (a repo with thousands of links must stay well inside the
// 120s clone cap), and the deploy resolves the sync target (origin/<branch>) to a sha
// once, so the check and the checkout see the same commit. Real git, real bash.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDeployScript } from '../deploy/script'
import { gitHardenShellFunctions } from '../git-harden'
import { shq } from '../shell'
import { gitResolveTarget } from '../ssh/git'
import { targetLinkGuardShell } from '../target-links'

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV, stdio: 'pipe' }).toString().trim()

function repoWith(links: Record<string, string>, files: Record<string, string> = { 'a.txt': 'a' }) {
	const root = mkdtempSync(join(tmpdir(), 'tl-'))
	git(root, 'init', '-q', '-b', 'main')
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(join(root, p, '..'), { recursive: true })
		writeFileSync(join(root, p), c)
	}
	for (const [p, t] of Object.entries(links)) {
		mkdirSync(join(root, p, '..'), { recursive: true })
		symlinkSync(t, join(root, p))
	}
	git(root, 'add', '-A')
	git(root, 'commit', '-q', '-m', 'c')
	return root
}
function check(dir: string) {
	const sh = targetLinkGuardShell({ dir, target: 'HEAD', binds: false })
	const r = spawnSync('bash', ['-c', `${gitHardenShellFunctions()}${sh} && echo CHECK_PASSED`], { encoding: 'utf8', env: GIT_ENV })
	return { ok: r.stdout.includes('CHECK_PASSED'), out: r.stdout + r.stderr }
}

describe('batched link target read', () => {
	it('reads thousands of links in one pass, fast', () => {
		const links: Record<string, string> = {}
		for (let i = 0; i < 3000; i++) links[`l/n${i}`] = '../a.txt'
		const dir = repoWith(links)
		const t0 = Date.now()
		const r = check(dir)
		expect(r.out).not.toContain('refusing')
		expect(r.ok).toBe(true)
		// one git process for the targets: the per-link loop took minutes on 3000 links
		expect(Date.now() - t0).toBeLessThan(20_000)
	})
	it('keeps every link in step: control characters and empty-looking targets around ordinary ones', () => {
		const dir = repoWith({
			'a1': 'a.txt',
			'b2': 'x\ry',
			'c3': 'line1\nline2',
			'd4': 'tail\n',
			'e5': '/etc',
			'f6': 'a.txt',
		})
		const r = check(dir)
		expect(r.ok).toBe(false)
		expect(r.out).toContain('the symlink b2 has an empty target or one with a control character')
		expect(r.out).toContain('the symlink c3 has an empty target or one with a control character')
		expect(r.out).toContain('the symlink d4 has an empty target or one with a control character')
		// the link after them is still read as itself
		expect(r.out).toContain('the symlink e5 -> /etc points to an absolute path')
		expect(r.out).not.toContain('a1 ->')
		expect(r.out).not.toContain('f6 ->')
	})
	it('keeps the non-ASCII targets the per-link read allowed', () => {
		const dir = repoWith({ 'kä': 'a.txt', 'm': 'déjà/../a.txt' })
		const r = check(dir)
		expect(r.out).not.toContain('refusing')
		expect(r.ok).toBe(true)
	})
})

describe('the sync target is resolved to a sha once', () => {
	it('gitResolveTarget leaves TARGET as the commit sha of origin/<branch>', () => {
		const origin = repoWith({}, { 'a.txt': 'a' })
		const work = mkdtempSync(join(tmpdir(), 'tl-clone-'))
		execFileSync('git', ['clone', '-q', origin, join(work, 'c')], { env: GIT_ENV, stdio: 'pipe' })
		const c = join(work, 'c')
		const sh = `cd ${shq(c)} && ${gitHardenShellFunctions()}${gitResolveTarget(shq('*'), 'main', null, false)}echo "TARGET=$TARGET"`
		const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: GIT_ENV })
		expect(r.stdout).toContain(`TARGET=${git(origin, 'rev-parse', 'HEAD')}`)
	})
	it('the deploy script checks and checks out the same "$TARGET" after the resolution', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'shop',
			cf: "-f '/opt/apps/shop/docker-compose.yml'",
			declaredMode: 'build',
			prebuilt: false,
			infra: [],
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
			swapOrdinal: 1700000000000,
			stageId: 'dep_x',
		})
		const resolve = s.indexOf('rev-parse -q --verify "$TARGET^{commit}"')
		const guard = s.indexOf('refusing the git sync, the target commit tracks a symlink')
		const checkout = s.indexOf('checkout -f -B "$BR" "$TARGET"')
		expect(resolve).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(resolve)
		expect(checkout).toBeGreaterThan(guard)
	})
})
