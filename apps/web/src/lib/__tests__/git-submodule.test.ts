import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GIT_HARDEN_FLAGS, gitHardenShellFunctions } from '../git-harden'

// a populated submodule's own config (.git/modules/<n>/config) is not
// scrubbed; a filter driver there ran as root when `status` looked into the submodule.
// powder_git ignores submodules entirely (diff.ignoreSubmodules=all).
const HAS_GIT = spawnSync('git', ['--version']).status === 0
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, args: string) {
	const r = spawnSync(
		'bash',
		['-c', `git -c user.email=a@example.com -c user.name=a -c protocol.file.allow=always ${args}`],
		{
			cwd,
			encoding: 'utf8',
			env: ENV,
		},
	)
	if (r.status !== 0) throw new Error(`git ${args}: ${r.stderr}`)
	return r.stdout
}

/** app repo with a populated submodule `mods` whose module config carries a hostile filter. */
function setup() {
	const root = mkdtempSync(join(tmpdir(), 'powder-sm-'))
	const sub = join(root, 'sub')
	const app = join(root, 'app')
	for (const d of [sub, app]) mkdirSync(d)
	git(sub, 'init -q')
	writeFileSync(join(sub, 'x.txt'), 'x\n')
	git(sub, 'add x.txt')
	git(sub, 'commit -qm s')
	git(app, 'init -q -b main')
	writeFileSync(join(app, 'a.txt'), 'a\n')
	git(app, 'add a.txt')
	git(app, `submodule add -q ${sub} mods`)
	git(app, 'commit -qm a')
	const mod = join(app, '.git', 'modules', 'mods')
	appendFileSync(
		join(mod, 'config'),
		`[filter "x"]\n\tclean = "sh -c 'touch ${root}/PWN_clean; cat'"\n\tsmudge = "sh -c 'touch ${root}/PWN_smudge; cat'"\n[core]\n\tfsmonitor = "touch ${root}/PWN_fsmonitor; false"\n`,
	)
	mkdirSync(join(mod, 'info'), { recursive: true })
	writeFileSync(join(mod, 'info', 'attributes'), '* filter=x\n')
	// A modified file in the submodule makes `status` run the clean filter there.
	writeFileSync(join(app, 'mods', 'x.txt'), 'y\n') // same size, new mtime: git must hash it (clean filter)
	return { root, app, pwned: () => readdirSync(root).filter((f) => f.startsWith('PWN_')) }
}

const OPS = [
	'status --porcelain',
	'diff --no-ext-diff --no-textconv --quiet HEAD',
	'diff HEAD',
	'checkout -q -f -B main HEAD',
	'reset -q --hard HEAD',
	'clean -fdxq',
	'fetch -q origin',
]

describe.skipIf(!HAS_GIT)('submodules are ignored by powder_git', () => {
	it('status, diff, checkout, reset, clean and fetch never run the submodule config', () => {
		const { app, pwned } = setup()
		git(app, `remote add origin ${app}`)
		const script = `${gitHardenShellFunctions()} ${OPS.map((o) => `GIT_ALLOW_PROTOCOL=file powder_git ${o} >/dev/null 2>&1`).join('; ')}; true`
		spawnSync('bash', ['-c', script], { cwd: app, env: ENV })
		expect(pwned()).toEqual([])
	})

	it('the flag is what stops it: the pins without diff.ignoreSubmodules run the filter', () => {
		const { app, pwned } = setup()
		const without = GIT_HARDEN_FLAGS.replace('-c diff.ignoreSubmodules=all', '')
		expect(without).not.toBe(GIT_HARDEN_FLAGS)
		spawnSync('bash', ['-c', `git ${without} status --porcelain >/dev/null 2>&1; true`], {
			cwd: app,
			env: ENV,
		})
		expect(pwned().length).toBeGreaterThan(0)
	})

	it('with all pins, plain git status does not either', () => {
		const { app, pwned } = setup()
		spawnSync('bash', ['-c', `git ${GIT_HARDEN_FLAGS} status --porcelain >/dev/null 2>&1; true`], {
			cwd: app,
			env: ENV,
		})
		expect(pwned()).toEqual([])
	})
})
