// a git sync must not turn a mount source in the work tree into a symlink.
// docker re-resolves bind sources on every container start, so the check reads the
// TARGET commit's tree BEFORE the checkout and refuses with the work tree untouched.
// Real git, real bash; the mount sources are passed the way the deploy collects them.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builderSymlinkGuardShell } from '../builder'
import { buildDeployScript } from '../deploy/script'
import { gitHardenShellFunctions } from '../git-harden'
import { inTreeComposeFiles, targetLinkGuardShell } from '../target-links'

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV, stdio: 'pipe' }).toString().trim()

type Entry = string | { link: string }
/** A checkout at `root` whose HEAD has `base`, plus a commit `target` (sha returned). */
function repo(root: string, base: Record<string, Entry>, next: Record<string, Entry | null>) {
	mkdirSync(root, { recursive: true })
	git(root, 'init', '-q', '-b', 'main')
	const put = (files: Record<string, Entry | null>) => {
		for (const [p, e] of Object.entries(files)) {
			const f = join(root, p)
			if (existsSync(f) || isLink(f)) execFileSync('rm', ['-rf', '--', f])
			if (e === null) continue
			mkdirSync(join(f, '..'), { recursive: true })
			if (typeof e === 'string') writeFileSync(f, e)
			else symlinkSync(e.link, f)
		}
		git(root, 'add', '-A')
		git(root, 'commit', '-q', '--allow-empty', '-m', 'c')
		return git(root, 'rev-parse', 'HEAD')
	}
	const a = put(base)
	const b = put(next)
	git(root, 'checkout', '-q', '-f', a)
	return b
}
function isLink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink()
	} catch {
		return false
	}
}

function check(o: { dir: string; root?: string; target: string; srcs: string[]; binds?: boolean; compose?: { files: string[]; preserved?: string[] } }) {
	const sh = targetLinkGuardShell({ dir: o.dir, root: o.root, target: o.target, binds: o.binds ?? true, compose: o.compose })
	const r = spawnSync('bash', ['-c', `${gitHardenShellFunctions()}${sh} && echo CHECK_PASSED`], { encoding: 'utf8', env: { ...GIT_ENV, TL_SRCS: o.srcs.join('\n') } })
	return { ok: r.stdout.includes('CHECK_PASSED'), out: r.stdout + r.stderr }
}

const fresh = () => mkdtempSync(join(tmpdir(), 'tl-'))

describe('target-commit link check (src/ layout)', () => {
	it('refuses a bind source turned into a link to / and leaves the work tree untouched', () => {
		const w = fresh()
		const src = join(w, 'src')
		const t = repo(src, { 'aaa/x': 'x', 'b.txt': 'b' }, { 'aaa/x': null, aaa: { link: '/' } })
		const r = check({ dir: src, target: t, srcs: [join(src, 'aaa')] })
		expect(r.ok).toBe(false)
		expect(r.out).toContain('refusing the git sync')
		expect(r.out).toContain('aaa -> /')
		expect(lstatSync(join(src, 'aaa')).isDirectory()).toBe(true)
		expect(readFileSync(join(src, 'aaa', 'x'), 'utf8')).toBe('x')
	})
	it('refuses a bind source turned into a link to .git (in-repo, kept by the post-checkout guard)', () => {
		const w = fresh()
		const src = join(w, 'src')
		const t = repo(src, { 'aaa/x': 'x' }, { 'aaa/x': null, aaa: { link: '.git' } })
		const r = check({ dir: src, target: t, srcs: [join(src, 'aaa')] })
		expect(r.ok).toBe(false)
		expect(r.out).toContain('replaces the mount source aaa')
		expect(r.out).toContain('points into .git')
	})
	it('refuses an in-repo link that replaces a folder above a bind source (rule i alone)', () => {
		const w = fresh()
		const src = join(w, 'src')
		const t = repo(src, { 'aaa/sub/x': 'x', 'bbb/sub/y': 'y' }, { 'aaa/sub/x': null, aaa: { link: 'bbb' } })
		const r = check({ dir: src, target: t, srcs: [`${src}/aaa/sub`] })
		expect(r.ok).toBe(false)
		expect(r.out).toContain('replaces a folder above the mount source aaa/sub')
		// the same tree with no mount source under aaa passes
		expect(check({ dir: src, target: t, srcs: [] }).ok).toBe(true)
	})
	it('maps sources spelled through a linked parent of the root (powder server /opt/apps link)', () => {
		const w = fresh()
		const real = join(w, 'vol')
		const src = join(real, 'shop', 'src')
		const t = repo(src, { 'aaa/x': 'x' }, { 'aaa/x': null, aaa: { link: 'b' }, 'b/y': 'y' })
		symlinkSync(real, join(w, 'apps'))
		const r = check({ dir: join(w, 'apps', 'shop', 'src'), target: t, srcs: [join(src, 'aaa')] })
		expect(r.ok).toBe(false)
		expect(r.out).toContain('replaces the mount source aaa')
	})
	it('passes the monorepo shape: relative in-repo links next to a real bind source', () => {
		const w = fresh()
		const src = join(w, 'src')
		const t = repo(
			src,
			{ 'AGENTS.md': 'a', 'content/c.md': 'c', '.claude/s.md': 's', 'blog/x': 'x', 'shop/.claude/k': 'k' },
			{
				'blog/AGENTS.md': { link: '../AGENTS.md' },
				'blog/README.md': { link: 'AGENTS.md' },
				'shop/.claude/.claude': { link: '../.claude' },
				'api/AGENTS.md': { link: '../AGENTS.md' },
				'content/new.md': 'n',
			},
		)
		const r = check({ dir: src, target: t, srcs: [join(src, 'content'), '/opt/apps/other-uploads', '/var/data'] })
		expect(r.out).not.toContain('refusing')
		expect(r.ok).toBe(true)
	})
	it('rule ii: absolute, escaping, root and chained escapes are refused with no mount sources at all', () => {
		for (const [links, want] of [
			[{ l: { link: '/etc' } }, 'points to an absolute path'],
			[{ l: { link: '../x' } }, 'points to outside the repository'],
			[{ 'a/l': { link: '../../x' } }, 'points to outside the repository'],
			[{ l: { link: '.' } }, 'points to the repository root'],
			[{ 'sub/r': { link: '..' }, e: { link: 'sub/r/..' } }, 'e -> sub/r/.. points to outside the repository'],
			[{ a: { link: 'b' }, b: { link: 'a' } }, 'link loop'],
			[{ l: { link: '.git/hooks' } }, 'points into .git'],
		] as const) {
			const w = fresh()
			const t = repo(join(w, 'src'), { 'sub/f': 'f' }, links as Record<string, Entry>)
			const r = check({ dir: join(w, 'src'), target: t, srcs: [], binds: false })
			expect(r.ok, JSON.stringify(links)).toBe(false)
			expect(r.out).toContain(want)
		}
	})
	it('picks the compose files read from the target tree (workdir-layout runtime compose preserved)', () => {
		const w = fresh()
		const src = join(w, 'src')
		const t = repo(src, { 'aaa/x': 'x', 'docker-compose.yml': 'services: {}\n' }, { 'aaa/x': null, aaa: { link: 'b' }, 'b/y': 'y' })
		expect(inTreeComposeFiles(src, [`${w}/docker-compose.yml`, `${src}/docker-compose.yml`])).toEqual([`${src}/docker-compose.yml`])
		expect(inTreeComposeFiles(w, [`${w}/docker-compose.yml`], ['docker-compose.yml'])).toEqual([])
	})
})

describe('target-commit link check (workdir layout: the repo is the workdir)', () => {
	it('refuses a link over a bind source and an escaping link; untracked runtime data is not touched', () => {
		const w = join(fresh(), 'shop')
		const t = repo(w, { 'uploads/a': 'a', 'docker-compose.yml': 'services: {}\n' }, { 'uploads/a': null, uploads: { link: '.git' } })
		mkdirSync(join(w, 'data'))
		const r = check({ dir: w, target: t, srcs: [join(w, 'uploads'), join(w, 'data')] })
		expect(r.ok).toBe(false)
		expect(r.out).toContain('replaces the mount source uploads')
		expect(lstatSync(join(w, 'uploads')).isDirectory()).toBe(true)
		const w2 = join(fresh(), 'shop')
		const t2 = repo(w2, { 'docker-compose.yml': 'services: {}\n' }, { 'cfg/link': { link: '../../other.env' } })
		expect(check({ dir: w2, target: t2, srcs: [] }).out).toContain('points to outside the repository')
	})
	it('passes a workdir-layout repo with ordinary in-repo links', () => {
		const w = join(fresh(), 'shop')
		const t = repo(w, { 'docker-compose.yml': 'services: {}\n', 'docs/a.md': 'a' }, { 'README.md': { link: 'docs/a.md' } })
		expect(check({ dir: w, target: t, srcs: [join(w, 'uploads')] }).ok).toBe(true)
	})
	it('a clone into a temp dir is checked against the sources of the dir it replaces', () => {
		const w = fresh()
		const tmp = join(w, 'shop.clone.1')
		const t = repo(tmp, { 'aaa/x': 'x' }, { 'aaa/x': null, aaa: { link: 'z' }, 'z/q': 'q' })
		const r = check({ dir: tmp, root: join(w, 'shop'), target: t, srcs: [join(w, 'shop', 'aaa')] })
		expect(r.ok).toBe(false)
		expect(r.out).toContain('replaces the mount source aaa')
	})
})

describe('wiring: the check runs before every checkout that changes a work tree', () => {
	const script = buildDeployScript({
		workingDir: '/opt/apps/shop',
		configFile: '/opt/apps/shop/docker-compose.yml',
		service: 'shop',
		cf: "-f '/opt/apps/shop/docker-compose.yml'",
		declaredMode: 'auto',
		prebuilt: false,
		infra: null,
		wantBranch: 'main',
		wantSha: null,
		shaIsStrict: false,
	})
	it('deploy: sources collected before the sync, guard before checkout in both layouts', () => {
		const src = script.indexOf('if [ -d src/.git ] && [ ! -L src ]; then')
		expect(script.indexOf('TL_IDS=$(docker ps -aq')).toBeGreaterThan(0)
		expect(script.indexOf('TL_IDS=$(docker ps -aq')).toBeLessThan(src)
		const checkouts = [...script.matchAll(/checkout -f -B "\$BR" "\$TARGET"/g)].map((m) => m.index ?? 0)
		expect(checkouts).toHaveLength(2)
		for (const c of checkouts) {
			const g = script.lastIndexOf('refusing the git sync, the target commit tracks a symlink', c)
			const prev = script.lastIndexOf('fetch origin 2>&1', c)
			expect(g).toBeGreaterThan(prev)
		}
	})
	it('builder: the (ii) check follows the clone', () => {
		expect(builderSymlinkGuardShell('/opt/builds/s-a')).toContain('[builder]: refusing the git sync')
	})
})
