import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeViolations } from '../compose-safety'
import { deployGuardContext } from '../deploy/compose-check'
import { GIT_HARDEN_FLAGS, gitHardenShellFunctions } from '../git-harden'

// powder's git must not run anything a repo-local .git/config names.
const HAS_GIT = spawnSync('git', ['--version']).status === 0

function sh(script: string, cwd: string) {
	const r = spawnSync('bash', ['-c', script], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd },
	})
	return { out: r.stdout + r.stderr, stdout: r.stdout, rc: r.status }
}

/** A repo with one committed file, a hostile config and `* filter=x` attributes. */
function hostileRepo(): { root: string; repo: string; pwned: () => string[] } {
	const root = mkdtempSync(join(tmpdir(), 'powder-gh-'))
	const repo = join(root, 'w')
	mkdirSync(repo)
	const g = (args: string) => {
		const r = spawnSync('bash', ['-c', `git ${args}`], {
			cwd: repo,
			encoding: 'utf8',
			env: { ...process.env, HOME: root },
		})
		if (r.status !== 0) throw new Error(r.stderr)
	}
	g('init -q')
	writeFileSync(join(repo, 'a.txt'), 'hi\n')
	g('add a.txt')
	g('-c user.email=a@example.com -c user.name=a commit -qm init')
	const hooks = join(root, 'hooks')
	mkdirSync(hooks)
	for (const h of ['post-checkout', 'reference-transaction', 'pre-auto-gc']) {
		writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${root}/PWN_hook_${h}\n`)
		chmodSync(join(hooks, h), 0o755)
	}
	const t = (n: string) => `touch ${root}/PWN_${n}`
	writeFileSync(
		join(repo, '.git/config'),
		`${readFileSync(join(repo, '.git/config'), 'utf8')}[core]\n\tfsmonitor = "${t('fsmonitor')}; false"\n\thooksPath = ${hooks}\n\tsshCommand = ssh -oProxyCommand=x\n\taskPass = ${root}/askpass\n[filter "x"]\n\tsmudge = "sh -c '${t('smudge')}; cat'"\n\tclean = "sh -c '${t('clean')}; cat'"\n[diff "x"]\n\tcommand = "${t('diffdrv')}"\n\ttextconv = "${t('textconv')}"\n[credential "https://example.com"]\n\thelper = "!${t('cred')}"\n[credential]\n\thelper = store\n[include]\n\tpath = ${root}/more\n[remote "origin"]\n\turl = git@github.com:acme/web.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`,
	)
	writeFileSync(join(root, 'more'), `[core]\n\tfsmonitor = "${t('include')}; false"\n`)
	mkdirSync(join(repo, '.git/info'), { recursive: true })
	writeFileSync(join(repo, '.git/info/attributes'), '* filter=x diff=x\n')
	return {
		root,
		repo,
		pwned: () => readdirSync(root).filter((f) => f.startsWith('PWN_')),
	}
}

describe.skipIf(!HAS_GIT)('powder_git (real git)', () => {
	it('checkout, status and diff run none of the repo config programs, and the config is scrubbed', () => {
		const { repo, pwned } = hostileRepo()
		const fns = gitHardenShellFunctions()
		const r = sh(
			`${fns} rm -f a.txt; echo changed > b.txt; powder_git -c safe.directory='*' checkout -f HEAD -- . && echo more >> a.txt && powder_git status --porcelain && powder_git diff --no-ext-diff --no-textconv --quiet HEAD -- a.txt; powder_git reset -q --hard HEAD && powder_git clean -fdxq && powder_git rev-parse --abbrev-ref HEAD`,
			repo,
		)
		expect(pwned()).toEqual([])
		expect(r.out).toContain('[git-harden] removed repo-local git config')
		const cfg = readFileSync(join(repo, '.git/config'), 'utf8')
		for (const bad of [
			'fsmonitor',
			'hooksPath',
			'ProxyCommand',
			'askPass',
			'smudge',
			'textconv',
			'!touch',
			'[include]',
		])
			expect(cfg).not.toContain(bad)
		// data keys stay
		for (const ok of [
			'url = git@github.com:acme/web.git',
			'merge = refs/heads/main',
			'helper = store',
			'repositoryformatversion',
		])
			expect(cfg).toContain(ok)
		expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hi\n')
	})

	it('without the scrub (a container racing it), the -c pins still stop hooks, fsmonitor and askpass', () => {
		const { repo, pwned } = hostileRepo()
		// No filter attributes here: drivers are the scrub's job (no -c wildcard exists).
		writeFileSync(join(repo, '.git/info/attributes'), '')
		const cmd = (f: string) =>
			`rm -f a.txt; git ${f} checkout -q -f -B main HEAD && git ${f} status --porcelain && git ${f} reset -q --hard HEAD`
		sh(cmd(GIT_HARDEN_FLAGS), repo)
		expect(pwned()).toEqual([])
		// Sanity: the same commands with plain git do run the planted programs.
		sh(cmd(''), repo)
		expect(pwned().length).toBeGreaterThan(0)
	})

	it('keeps a plain ssh key command and the stock git-lfs filter, drops a hostile one', () => {
		const { repo } = hostileRepo()
		writeFileSync(
			join(repo, '.git/config'),
			'[core]\n\trepositoryformatversion = 0\n\tsshCommand = ssh -i /opt/apps/x/.deploy-key -o IdentitiesOnly=yes\n' +
				'[filter "lfs"]\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n\tclean = sh -c evil\n',
		)
		writeFileSync(join(repo, '.git/info/attributes'), '')
		const r = sh(
			`${gitHardenShellFunctions()} powder_git rev-parse HEAD >/dev/null && echo "ssh=$__pgssh"`,
			repo,
		)
		expect(r.out).toContain('ssh=ssh -i /opt/apps/x/.deploy-key -o IdentitiesOnly=yes')
		const cfg = readFileSync(join(repo, '.git/config'), 'utf8')
		expect(cfg).toContain('git-lfs smudge -- %f')
		expect(cfg).toContain('git-lfs filter-process')
		expect(cfg).not.toContain('sh -c evil')
	})

	it('repo-level credential helpers: bare store / cache stay, any argument is scrubbed', () => {
		const { repo } = hostileRepo()
		writeFileSync(
			join(repo, '.git/config'),
			'[core]\n\trepositoryformatversion = 0\n[credential]\n\thelper = cache\n[credential "https://example.com"]\n\thelper = store --file=/opt/apps/other/.git-credentials\n',
		)
		writeFileSync(join(repo, '.git/info/attributes'), '')
		sh(`${gitHardenShellFunctions()} powder_git rev-parse HEAD`, repo)
		const cfg = readFileSync(join(repo, '.git/config'), 'utf8')
		expect(cfg).toContain('helper = cache')
		expect(cfg).not.toContain('--file')
	})

	it('ignores a planted commondir and refuses a symlinked or gitfile .git', () => {
		const { root, repo, pwned } = hostileRepo()
		// commondir would move config/hooks to a dir the attacker controls.
		const evil = join(root, 'evilcommon')
		mkdirSync(evil)
		writeFileSync(
			join(evil, 'config'),
			`[core]\n\tfsmonitor = "touch ${root}/PWN_commondir; false"\n`,
		)
		writeFileSync(join(repo, '.git/commondir'), evil)
		const a = sh(
			`${gitHardenShellFunctions()} rm -f a.txt; powder_git checkout -f HEAD -- . && powder_git status --porcelain && echo OK`,
			repo,
		)
		expect(a.out, a.out).toContain('OK')
		expect(pwned()).toEqual([])

		const linked = join(root, 'linked')
		mkdirSync(linked)
		symlinkSync(join(repo, '.git'), join(linked, '.git'))
		const b = sh(`${gitHardenShellFunctions()} powder_git -C ${linked} status`, root)
		expect(b.rc).not.toBe(0)
		expect(b.out).toContain('.git is a symlink')

		const gitfile = join(root, 'gitfile')
		mkdirSync(gitfile)
		writeFileSync(join(gitfile, '.git'), `gitdir: ${evil}\n`)
		const c = sh(`${gitHardenShellFunctions()} powder_git -C ${gitfile} status`, root)
		expect(c.rc).not.toBe(0)
		expect(c.out).toContain('.git is not a directory')
	})

	it('a subdirectory resolves to the checkout top (test gate: --show-prefix)', () => {
		const { repo } = hostileRepo()
		mkdirSync(join(repo, 'sub'))
		const r = sh(`${gitHardenShellFunctions()} powder_git -C sub rev-parse --show-prefix`, repo)
		expect(r.stdout.trim()).toBe('sub/')
	})

	it('a directory with no checkout fails like git does (no discovery of a parent repo)', () => {
		const d = mkdtempSync(join(tmpdir(), 'powder-gh-none-'))
		const r = sh(`${gitHardenShellFunctions()} powder_git ls-files; echo rc=$?`, d)
		expect(r.out).toContain('not a git repository')
		expect(r.out).toContain('rc=128')
	})

	it('a clean config and a scrub under set -e never abort the caller', () => {
		const { repo } = hostileRepo()
		writeFileSync(join(repo, '.git/info/attributes'), '')
		const r = sh(
			`set -e; ${gitHardenShellFunctions()} powder_git rev-parse HEAD >/dev/null; echo ONE; powder_git rev-parse HEAD >/dev/null; echo TWO`,
			repo,
		)
		expect(r.stdout).toContain('ONE')
		expect(r.stdout).toContain('TWO')
	})

	it('the definitions parse under sh too', () => {
		const r = spawnSync('sh', ['-n', '-c', gitHardenShellFunctions()], { encoding: 'utf8' })
		expect(r.status).toBe(0)
	})
})

// Guard: no generated shell runs a bare git on a server. Every repo command goes through
// powder_git, every repo-less one through powder_git_norepo (lib/git-harden.ts).
describe('no bare git in generated shell', () => {
	const root = join(__dirname, '..', '..')
	const files: string[] = []
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n)
			if (n === '__tests__' || n === 'node_modules') continue
			if (statSync(p).isDirectory()) walk(p)
			else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p)
		}
	}
	walk(join(root, 'lib'))
	walk(join(root, 'app'))
	const BARE =
		/(^|\$\(\s*|&&\s*|;\s*|\|\s*|\{\s*|\(\s*|(?<!\\)`|\bretry\s+|\bthen\s+|\bif\s+!?\s*|\bdo\s+)git (-c|-C|clone|ls-remote|fetch|reset|checkout|rev-parse|ls-files|archive|status|diff|clean|cat-file|config|branch|remote|show-ref|symbolic-ref|merge-base)\b/
	it('finds none outside lib/git-harden.ts', () => {
		const hits: string[] = []
		for (const f of files) {
			if (f.endsWith('git-harden.ts')) continue
			readFileSync(f, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					const t = line.trim()
					if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
					if (/detail:|summary:|message:/.test(line)) return // user-facing text
					if (BARE.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${t.slice(0, 120)}`)
				})
		}
		expect(hits.join('\n')).toBe('')
	})
	it('the scan covers the known call sites', () => {
		expect(files.some((f) => f.endsWith('deploy/script.ts'))).toBe(true)
		expect(files.some((f) => f.endsWith('repo/import/route.ts'))).toBe(true)
		expect(existsSync(join(root, 'lib', 'git-harden.ts'))).toBe(true)
	})
})

describe('compose: binds that expose git metadata are high findings', () => {
	const ctx = deployGuardContext(
		{ resolved: { name: 'myapp' }, raw: null, hash: 'x', containers: [] },
		{
			appName: 'myapp',
			workingDir: '/opt/apps/myapp',
			composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
			serverId: 's1',
			routeHosts: null,
		},
	)
	const binds = (vols: unknown[]) =>
		composeViolations(
			{ name: 'myapp', services: { myapp: { image: 'myapp:latest', volumes: vols } } },
			ctx,
		).filter((v) => v.code === 'bind')
	it.each(['./src:/app', './src/.git:/x', './.git:/x', '/opt/apps/myapp/src:/app'])(
		'flags %s',
		(v) => {
			const f = binds([v])
			expect(f.length).toBeGreaterThan(0)
			expect(f[0]?.message).toContain('.git')
		},
	)
	it('a long-form bind of ./src is flagged too', () => {
		expect(binds([{ type: 'bind', source: './src', target: '/app' }]).length).toBeGreaterThan(0)
	})
	it.each(['./src/public:/app/public', './data:/data', './uploads:/app/uploads', './src:/app:ro'])(
		'allows %s',
		(v) => {
			expect(binds([v])).toEqual([])
		},
	)
	it('a read-only long-form bind of ./src is allowed (it cannot write .git)', () => {
		expect(binds([{ type: 'bind', source: './src', target: '/app', read_only: true }])).toEqual([])
	})
})
