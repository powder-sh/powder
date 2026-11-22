// One authority for "where is this app's git checkout" (lib/app-checkout.ts):
// the shell fragment the deploy runs and the TypeScript rule the dashboard uses
// must give the same answer for the same directory tree. Only `sh` and `test` run
// here (no git); the env is the hermetic one from vitest.setup.ts.
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
	APP_SRC_LINK_TEST,
	appCheckoutDirShell,
	appCheckoutProbeShell,
	cloneRefusal,
	parseCheckoutFacts,
	resolveAppCheckout,
} from '../app-checkout'

const root = mkdtempSync(join(tmpdir(), 'app-checkout-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = { ...process.env, GIT_CEILING_DIRECTORIES: root }
const sh = (script: string, cwd = root) => {
	const r = spawnSync('sh', ['-c', script], { cwd, env, encoding: 'utf8', timeout: 20_000 })
	expect(r.status, r.stderr).toBe(0)
	return r.stdout
}

type Layout = { name: string; make: (wd: string) => void; expect: string }
const LAYOUTS: Layout[] = [
	{ name: 'empty working dir', make: () => {}, expect: 'none' },
	{ name: 'standard: src/.git', make: (wd) => mkdirSync(join(wd, 'src/.git'), { recursive: true }), expect: 'src' },
	{ name: 'older layout: .git in the working dir', make: (wd) => mkdirSync(join(wd, '.git')), expect: 'workdir' },
	{
		name: 'stale .git in the working dir plus src/.git',
		make: (wd) => {
			mkdirSync(join(wd, '.git'))
			mkdirSync(join(wd, 'src/.git'), { recursive: true })
		},
		expect: 'src',
	},
	{ name: 'src/ without .git', make: (wd) => mkdirSync(join(wd, 'src/app'), { recursive: true }), expect: 'none' },
	{ name: 'src is a file', make: (wd) => writeFileSync(join(wd, 'src'), 'x'), expect: 'none' },
	{
		name: 'src/.git is a file (gitfile)',
		make: (wd) => {
			mkdirSync(join(wd, 'src'))
			writeFileSync(join(wd, 'src/.git'), 'gitdir: /elsewhere\n')
		},
		expect: 'none',
	},
	{
		name: 'src is a symlink to a checkout',
		make: (wd) => {
			mkdirSync(join(wd, 'elsewhere/.git'), { recursive: true })
			symlinkSync(join(wd, 'elsewhere'), join(wd, 'src'))
		},
		expect: 'src-link',
	},
	{ name: 'src is a dangling symlink', make: (wd) => symlinkSync('/nonexistent-target', join(wd, 'src')), expect: 'src-link' },
	{
		name: 'src/.git plus a data dir and runtime files',
		make: (wd) => {
			mkdirSync(join(wd, 'src/.git'), { recursive: true })
			mkdirSync(join(wd, 'pgdata'))
			writeFileSync(join(wd, 'docker-compose.yml'), 'services: {}\n')
			writeFileSync(join(wd, '.deploy-key'), 'k')
		},
		expect: 'src',
	},
]

// the deploy's preflight: refuse a src symlink, then the fragment
const deployAnswer = (wd: string) =>
	sh(`cd '${wd}' && if ${APP_SRC_LINK_TEST}; then echo src-link; else ${appCheckoutDirShell('PF_GITDIR')}; echo "[$PF_GITDIR]"; fi`).trim()
const DEPLOY_TOKEN: Record<string, string> = { src: '[src]', workdir: '[.]', none: '[]', 'src-link': 'src-link' }

describe('app checkout: shell fragment and TypeScript rule agree', () => {
	it.each(LAYOUTS)('$name', ({ name, make, expect: want }) => {
		const wd = join(root, name.replace(/[^a-z0-9]+/gi, '-'))
		mkdirSync(wd)
		make(wd)
		const facts = parseCheckoutFacts(sh(appCheckoutProbeShell(wd)))
		const co = resolveAppCheckout(wd, facts)
		expect(co.kind).toBe(want)
		expect(deployAnswer(wd)).toBe(DEPLOY_TOKEN[co.kind])
		if (co.kind === 'src') expect(co.dir).toBe(`${wd}/src`)
		if (co.kind === 'workdir') expect(co.dir).toBe(wd)
		if (name.startsWith('stale')) expect(co).toEqual({ kind: 'src', dir: `${wd}/src`, staleWorkdirGit: true })
	})

	it('a working dir that cannot be entered is unknown, and the probe does not move the caller', () => {
		const out = sh(`${appCheckoutProbeShell(join(root, 'missing'))}pwd`)
		expect(parseCheckoutFacts(out)).toBeNull()
		expect(resolveAppCheckout('/opt/apps/x', null)).toEqual({ kind: 'unknown' })
		expect(out.trim().split('\n').pop()).toBe(sh('pwd').trim())
	})

	it('the clone action is allowed only with no checkout and no src', () => {
		const wd = '/opt/apps/shop'
		expect(cloneRefusal(wd, { kind: 'none', srcExists: false })).toBeNull()
		for (const co of [
			{ kind: 'none', srcExists: true },
			{ kind: 'src', dir: `${wd}/src`, staleWorkdirGit: false },
			{ kind: 'src', dir: `${wd}/src`, staleWorkdirGit: true },
			{ kind: 'workdir', dir: wd },
			{ kind: 'src-link' },
			{ kind: 'unknown' },
		] as const)
			expect(cloneRefusal(wd, co)).toMatch(/\S/)
	})
})

// ── guards ───────────────────────────────────────────────────────────────────

const WEB_SRC = join(__dirname, '../..')
const read = (p: string) => readFileSync(join(WEB_SRC, p), 'utf8')
const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((n) => {
		const p = join(dir, n)
		return statSync(p).isDirectory() ? walk(p) : [p]
	})

const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l)
const codeLines = (f: string) =>
	readFileSync(f, 'utf8')
		.split('\n')
		.filter((l) => !isComment(l))
const countIn = (base: string, sub: string, count: (lines: string[]) => number, skip: (rel: string) => boolean = () => false) => {
	const out: Record<string, number> = {}
	for (const f of walk(join(base, sub))) {
		const rel = relative(base, f)
		if (!/\.tsx?$/.test(f) || rel.includes('__tests__') || skip(rel)) continue
		const n = count(codeLines(f))
		if (n) out[rel] = n
	}
	return out
}

/** `.git` tokens in every route, page, layout and server action under app/. */
const appGitTokens = (base: string) =>
	countIn(base, 'app', (ls) => ls.reduce((k, l) => k + (l.match(/\.git\b/g) ?? []).length, 0))
/** Lines in lib/ that test or build a `.git` path: `[ -d|-e|-f|-L ... .git`, `test ...
 *  .git`, `${dir}/.git`, a quoted `/.git` or `.git` (`join(wd, '.git')`), `+ '/.git'`,
 *  `find ... -name .git` (and -iname, -path). */
const GIT_PATH_LINE = /(-[defL]\s|\btest\s|\}\/\.git|['"`]\/\.git|['"`]\.git['"`/]|\+\s*['"`]\/?\.git|-i?(name|path|wholename)\s+['"]?[^\s'"]*\.git)/
// every file under src/ outside app/ (lib, components, the worker and its scripts);
// app/ has the stricter token rule above
const libGitPathLines = (base: string) =>
	countIn(base, '', (ls) => ls.filter((l) => /\.git\b/.test(l) && GIT_PATH_LINE.test(l)).length, (r) => r.startsWith('app/'))
/** git's own "is this a checkout / where is it" probes, anywhere under lib/ and app/
 *  outside the authority. */
const PROBE = /rev-parse\s+[^\n]*--(is-inside-work-tree|git-dir|git-common-dir|show-toplevel|absolute-git-dir|show-cdup|show-prefix)\b/
const checkoutProbes = (base: string) =>
	countIn(base, '', (ls) => ls.filter((l) => PROBE.test(l)).length, (r) => r === 'lib/app-checkout.ts')

// Shrink-only allowlists of today's legitimate uses. app/: repo URLs (`<repo>.git`), the
// `(\.git)?` of URL parsers and the container page's text about an ignored old .git; no
// route tests a checkout path itself.
const APP_ALLOWED: Record<string, number> = {
	'app/(dashboard)/projects/[id]/_lib/project-context.tsx': 2,
	'app/(dashboard)/servers/[id]/[name]/page.tsx': 2,
	'app/(dashboard)/servers/page.tsx': 2,
	'app/api/apps/route.ts': 2,
	'app/api/servers/[id]/containers/[name]/repo/import/route.ts': 1,
}
// lib/: the authority (app-checkout.ts) and the marker (clone-marker.ts); git-harden's
// checkout walk; the deploy's sync, reset and guard branches, which run after the
// preflight that uses the authority; the clone and status reads in ssh/git.ts on a
// directory the authority chose; the protected-path lists of the compose checks; the
// the .dockerignore, env-target and test-scan lists that
// name `.git` to keep it out; target-links' rule against links into .git. A new reader of "where is the checkout" goes through the
// authority instead.
const LIB_ALLOWED: Record<string, number> = {
	'lib/app-checkout.ts': 2,
	'lib/app-runtime-files.ts': 2,
	'lib/clone-marker.ts': 3,
	'lib/compose-safety.ts': 3,
	'lib/deploy/compose-check.ts': 3,
	'lib/deploy/fragments.ts': 1,
	'lib/deploy/run.ts': 2,
	'lib/deploy/script.ts': 3,
	'lib/deploy/self-deploy.ts': 2,
	'lib/deploy/stability.ts': 1,
	'lib/env-target.ts': 1,
	'lib/git-harden.ts': 3,
	'lib/repo-symlinks.ts': 1,
	'lib/ssh/git.ts': 2,
	'lib/target-links.ts': 1,
}
const PROBE_ALLOWED: Record<string, number> = { 'lib/deploy/fragments.ts': 1 }

describe('app checkout: every reader uses the authority', () => {
	it('no route, page or server action tests a .git path itself', () => {
		expect(appGitTokens(WEB_SRC)).toEqual(APP_ALLOWED)
	})

	it('.git path tests in lib/ do not grow', () => {
		expect(libGitPathLines(WEB_SRC)).toEqual(LIB_ALLOWED)
	})

	it('git checkout probes (rev-parse --is-inside-work-tree and the like) do not grow', () => {
		expect(checkoutProbes(WEB_SRC)).toEqual(PROBE_ALLOWED)
	})

	it('the deploy, self-deploy and auto-rollback preflight take the checkout from the authority', () => {
		for (const f of ['lib/deploy/script.ts', 'lib/deploy/self-deploy.ts', 'lib/auto-rollback.ts']) {
			expect(read(f)).toContain('appCheckoutDirShell(')
			expect(read(f)).not.toMatch(/PF_GITDIR="";|G="\$PWD\/src"; \[/)
		}
		expect(appCheckoutDirShell('PF_GITDIR')).toBe(
			'PF_GITDIR=""; if [ -d src/.git ]; then PF_GITDIR=src; elif [ -d .git ]; then PF_GITDIR=.; fi',
		)
	})

	// The guards catch the known bypass shapes: each is planted in a copy of the tree.
	const D = '$'
	it.each([
		['a containers-API route building the .git path by concatenation', 'app/api/servers/[id]/containers/[name]/repo/route.ts', `\nconst probe = \`[ -e ${D}{wd}\` + \`/.git ]\`\n`],
		['a lib helper testing the working dir .git (called from a route)', 'lib/checkout-helper.ts', `export const isRepo = (wd: string) => \`test -d ${D}{wd}/.git\`\n`],
		['a test-command form in the deploy script', 'lib/deploy/script.ts', "\nconst x = 'if test -d src/.git; then :; fi'\n"],
		['join(wd, .git) in a lib helper', 'lib/checkout-join.ts', "import { join } from 'node:path'\nexport const g = (wd: string) => join(wd, '.git')\n"],
		['test -d on the .git of a dir in /new', 'app/api/apps/route.ts', `\nconst probe2 = (wd: string) => \`test -d ${D}{wd}/.git\`\n`],
		['find -name .git in a new lib file', 'lib/checkout-find.ts', `export const f = (wd: string) => \`find ${D}{wd} -maxdepth 1 -name .git -type d\`\n`],
		['a rev-parse --git-common-dir probe in a new lib file', 'lib/checkout-common.ts', `export const p = (wd: string) => \`git -C ${D}{wd} rev-parse --git-common-dir\`\n`],
		['test -d on the .git of a dir in the worker', 'worker.ts', `\nconst probe3 = (wd: string) => \`test -d ${D}{wd}/.git\`\n`],
		['a rev-parse checkout probe in a new lib file', 'lib/checkout-probe.ts', `export const p = (wd: string) => \`git -C ${D}{wd} rev-parse --is-inside-work-tree\`\n`],
	])('the guard fails on %s', (_n, file, add) => {
		const copy = mkdtempSync(join(tmpdir(), 'guard-copy-'))
		try {
			cpSync(WEB_SRC, copy, { recursive: true })
			const all = () => [appGitTokens(copy), libGitPathLines(copy), checkoutProbes(copy)]
			const ok = [APP_ALLOWED, LIB_ALLOWED, PROBE_ALLOWED]
			expect(all()).toEqual(ok)
			appendFileSync(join(copy, file), add)
			expect(all()).not.toEqual(ok)
		} finally {
			rmSync(copy, { recursive: true, force: true })
		}
	})
})
