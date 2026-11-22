// The clone scripts and the preview dir removal, run for real in temp dirs. The
// command runner is replaced by a local bash with stubs: `git clone` (every other git
// command is the real git, hermetic env, GIT_CEILING_DIRECTORIES at the temp root),
// `flock`, `docker`, and logging wrappers around `rm` and `mv`, so every destructive
// command a script runs is recorded.
//
// The invariant for the whole class: for every refusal the code can produce, the tree
// under the apps root is byte-identical before and after, and no `rm -r`, `mv` or
// `docker rm` ran. The one exception is named per case: a link-guard refusal comes
// after the temp clone exists, and removes only this run's own marked temp dir.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathWithout } from './hermetic'

const mode = { capture: false }
// replaces the stdin runCommand was given (a missing or malformed nonce)
const stdinOverride: { value: string | undefined } = { value: undefined }
const captured: string[] = []
const capturedStdin: (string | undefined)[] = []
let extraEnv: Record<string, string> = {}
let pathVar = ''
// the local runner: stdin as runCommand's stdin option, stdout and stderr apart (as
// over ssh). FORGE hands the call's nonce to the stub git (as a process reading the
// host's /proc could).
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string, _t?: number, _c?: unknown, opts?: { stdin?: string }) => {
		captured.push(cmd)
		capturedStdin.push(opts?.stdin)
		if (mode.capture) return { code: 0, stdout: '', stderr: '' }
		const forge = extraEnv.FORGE ? { FORGE_NONCE: (opts?.stdin ?? '').trim() } : {}
		const stdin = stdinOverride.value ?? opts?.stdin ?? ''
		const r = spawnSync('bash', ['-c', cmd], {
			env: { ...process.env, PATH: pathVar, ...extraEnv, ...forge },
			input: stdin,
			encoding: 'utf8',
			timeout: 60_000,
		})
		return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
	},
}))

import { CLONE_LOCK_WAIT_SEC, CloneError, cloneIntoAppSrc, cloneLockPath, cloneNonce, gitCloneRepo, nonceReadShell, parseCloneStatus } from '../ssh/git'
import { parsePreviewDirStatus, previewDirRemoveShell, previewRemovalNote } from '../preview-deploys'
import { cloneTargetOk } from '../clone-marker'
import { CLONE_KEY_TMP_PREFIX, randomTempPath } from '../temp-path'

const root = mkdtempSync(join(tmpdir(), 'clone-scripts-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const which = (b: string) => execFileSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).trim()
const REAL_GIT = which('git')
const REAL_RM = which('rm')
const REAL_MV = which('mv')
const URL_ = 'git@github.com:acme/shop.git'
const APPS = join(root, 'apps')
const LOCKS = join(root, 'locks')
const LOG = join(root, 'destructive.log')
const at = (n: string) => join(APPS, n)
// a real temp key file of the clone action's shape (in /tmp, removed in afterAll)
const tempKeys: string[] = []
const tempKey = () => {
	const k = randomTempPath(CLONE_KEY_TMP_PREFIX)
	writeFileSync(k, 'PRIVATE', { mode: 0o600 })
	tempKeys.push(k)
	return k
}
afterAll(() => {
	for (const k of tempKeys) rmSync(k, { force: true })
})
mkdirSync(APPS)

const stubs = join(root, 'stubs')
mkdirSync(stubs)
const stub = (name: string, body: string) => {
	writeFileSync(join(stubs, name), `#!/bin/sh\n${body}`)
	chmodSync(join(stubs, name), 0o755)
}
// git clone: FAIL_CLONE fails without creating anything (as git does); SLOW_CLONE
// writes a partial tree, records its pid and waits; HOSTILE_NAMES (newline separated)
// commits symlinks to /etc/passwd under those names
stub(
	'git',
	`# SLOW_GUARD_NAME: any git command on the checkout of that name (the post-placement
# symlink guard) records its pid and waits
if [ -n "$SLOW_GUARD_NAME" ]; then case " $* " in *"--git-dir="*"/$SLOW_GUARD_NAME/.git"*) echo $$ > "$SLOW_GUARD_PID"; exec sleep 30 ;; esac; fi
case " $* " in *" clone "*) ;; *) exec ${REAL_GIT} "$@" ;; esac
for a; do t=$a; done
# FORGE: a background child that outlives the script and prints a forged status
# line with the right nonce, on stdout and on fd 3
if [ -n "$FORGE" ]; then ( sleep 1; printf '__PC_%s__ rc=0 placed=1 kept=- reason=ok\n' "$FORGE_NONCE"; printf '__PC_%s__ rc=0 placed=1 kept=- reason=ok\n' "$FORGE_NONCE" >&3 ) 2>/dev/null & fi
# EXTRA_IN_TMP: leave a foreign file in the temp dir, so its rmdir fails
[ -n "$EXTRA_IN_TMP" ] && echo x > "$(dirname "$t")/extra"
[ -n "$FAIL_CLONE" ] && { echo "fatal: could not read from remote repository"; exit 128; }
if [ -n "$SLOW_CLONE" ]; then mkdir -p "$t/.git" && echo partial > "$t/file" && echo $$ > "$SLOW_CLONE" && exec sleep 30; fi
${REAL_GIT} init -q "$t" || exit 1
if [ -n "$HOSTILE_NAMES" ]; then printf '%s\\n' "$HOSTILE_NAMES" | while IFS= read -r n; do [ -n "$n" ] && ln -s /etc/passwd "$t/$n"; done; ${REAL_GIT} -C "$t" add -A; fi
${REAL_GIT} -C "$t" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
`,
)
// rm and mv log every destructive call; mv also emulates GNU -T (the servers' mv)
stub('rm', `for a; do case "$a" in --) break ;; -*[rR]*) echo "rm $*" >> "$DESTRUCT_LOG"; break ;; esac; done\nexec ${REAL_RM} "$@"\n`)
stub(
	'mv',
	`echo "mv $*" >> "$DESTRUCT_LOG"
if [ "$1" = -T ]; then shift; [ "$1" = -- ] && shift; if [ -d "$2" ] && [ ! -L "$2" ]; then echo "mv: cannot overwrite directory $2" >&2; exit 1; fi; exec ${REAL_MV} -- "$1" "$2"; fi
exec ${REAL_MV} "$@"
`,
)
stub('flock', '[ -n "$FLOCK_FAIL" ] && exit 1\nexit 0\n')
// docker: rm-like calls are logged; ps prints $DOCKER_PS (ids); DOCKER_FAIL fails
stub('docker', '[ -n "$DOCKER_FAIL" ] && exit 1\ncase "$1 $2" in "rm "*|"network rm"|"container rm") echo "docker $*" >> "$DESTRUCT_LOG" ;; esac\n[ "$1" = ps ] && printf "%s" "$DOCKER_PS"\nexit 0\n')
// the same stubs without flock, on a PATH without the system flock
const stubsNoFlock = join(root, 'stubs-noflock')
mkdirSync(stubsNoFlock)
for (const n of ['git', 'rm', 'mv', 'docker']) symlinkSync(join(stubs, n), join(stubsNoFlock, n))
const PATH_ALL = `${stubs}:${process.env.PATH}`
const PATH_NO_FLOCK = `${stubsNoFlock}:${pathWithout(['flock'])}`

beforeEach(() => {
	mode.capture = false
	stdinOverride.value = undefined
	captured.length = 0
	capturedStdin.length = 0
	extraEnv = { DESTRUCT_LOG: LOG, GIT_CEILING_DIRECTORIES: root }
	pathVar = PATH_ALL
	writeFileSync(LOG, '')
})
// destructive commands on anything under the test root (the link guard's own scratch
// dir in $TMPDIR is not an app path)
const destructive = () => readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(root))

/** every path under `dir` with its type and content: equal = untouched */
function tree(dir: string): string[] {
	const out: string[] = []
	const walk = (d: string) => {
		for (const n of readdirSync(d).sort()) {
			const p = join(d, n)
			const st = lstatSync(p)
			if (st.isSymbolicLink()) out.push(`${relative(dir, p)} -> ${readlinkSync(p)}`)
			else if (st.isDirectory()) {
				out.push(`${relative(dir, p)}/`)
				walk(p)
			} else out.push(`${relative(dir, p)} ${readFileSync(p, 'utf8')}`)
		}
	}
	walk(dir)
	return out
}
const mark = (d: string, purpose: string) => {
	mkdirSync(join(d, '.git'), { recursive: true })
	writeFileSync(join(d, '.git/powder-clone-target'), `powder-clone-target v1 ${purpose}\n`)
}
const markTmp = (d: string, purpose: string) => {
	mkdirSync(d, { recursive: true })
	writeFileSync(join(d, '.powder-clone-owner'), `powder-clone-target v1 ${purpose}\n`)
}
/** an app's dir: runtime compose, deploy key, data, a .git, no marker */
function appDir(wd: string) {
	mkdirSync(join(wd, 'pgdata'), { recursive: true })
	writeFileSync(join(wd, 'pgdata/PG_VERSION'), '17\n')
	writeFileSync(join(wd, 'docker-compose.yml'), 'services: {}\n')
	writeFileSync(join(wd, '.deploy-key'), 'k')
	mkdirSync(join(wd, '.git'), { recursive: true })
	writeFileSync(join(wd, '.git/HEAD'), 'ref: refs/heads/main\n')
}
const clone = (wd: string, purpose: string) =>
	gitCloneRepo({} as never, wd, URL_, 'main', join(root, 'key'), purpose, { lockDir: LOCKS, appsRoot: APPS })
const caught = async (p: Promise<unknown>): Promise<CloneError> => {
	try {
		await p
	} catch (e) {
		if (e instanceof CloneError) return e
		throw e
	}
	throw new Error('expected a CloneError')
}

// ── the invariant ──────────────────────────────────────────────────────────────

describe('every refusal leaves the apps tree byte-identical and runs nothing destructive', () => {
	type Case = {
		name: string
		reason: string
		purpose?: string
		setup: (wd: string) => void
		env?: Record<string, string>
		path?: () => string
		/** the one destructive command allowed: removing this run's own marked temp */
		ownTempRemoved?: boolean
	}
	const own = (wd: string) => {
		appDir(wd)
		mark(wd, 'preview:pv_1')
	}
	const cases: Case[] = [
		{ name: 'pv-foreign', reason: 'foreign', setup: appDir },
		{ name: 'shop-foreign', reason: 'foreign', setup: appDir },
		{ name: 'pv-other-owner', reason: 'foreign', setup: (wd) => { appDir(wd); mark(wd, 'preview:pv_other') } },
		{ name: 'pv-app-owner', reason: 'foreign', setup: (wd) => mark(wd, 'app:pv-app-owner') },
		{ name: 'shop', reason: 'exists', purpose: 'app:shop', setup: (wd) => { appDir(wd); mark(wd, 'app:shop') } },
		{ name: 'pv-link', reason: 'foreign', setup: (wd) => { own(`${wd}-real`); symlinkSync(`${wd}-real`, wd) } },
		{ name: 'pv-locked', reason: 'lock', setup: own, env: { FLOCK_FAIL: '1' } },
		{ name: 'pv-noflock', reason: 'lock', setup: own, path: () => PATH_NO_FLOCK },
		{ name: 'pv-clonefail', reason: 'clone', setup: own, env: { FAIL_CLONE: '1' } },
		{ name: 'pv-linkguard', reason: 'linkguard', setup: own, env: { HOSTILE_NAMES: 'escape' }, ownTempRemoved: true },
		{
			// a refused clone whose link guard prints file names made to look like outcome lines
			name: 'pv-forged',
			reason: 'linkguard',
			setup: own,
			env: { HOSTILE_NAMES: `__POWDER_CLONE_PLACED__\n__PC_${'0'.repeat(32)}__ rc=0 placed=1 kept=- reason=ok` },
			ownTempRemoved: true,
		},
	]
	it.each(cases)('$name: $reason', async (c) => {
		const wd = join(APPS, c.name)
		c.setup(wd)
		const before = tree(APPS)
		Object.assign(extraEnv, c.env ?? {})
		if (c.path) pathVar = c.path()
		const e = await caught(clone(wd, c.purpose ?? 'preview:pv_1'))
		expect(e.reason).toBe(c.reason)
		expect(e.placed).toBe(false)
		expect(e.refused).toBe(true)
		expect(e.keptAt).toBeNull()
		expect(tree(APPS)).toEqual(before)
		if (c.ownTempRemoved) {
			expect(destructive()).toHaveLength(1)
			expect(destructive()[0]).toMatch(new RegExp(`^rm -rf -- ${wd.replace(/[.]/g, '\\.')}\\.clone\\.preview-pv_1\\.\\d+$`))
		} else expect(destructive()).toEqual([])
	})

	it.each(['', APPS, `${APPS}/`, `${APPS}/a/b`, `${APPS}/../etc`, `${APPS}/..`, 'apps/a', '/srv/a', `${APPS}/.hidden`, `${APPS}/a b`, `${APPS}/a'b`, `${APPS}/a\n`, '/opt/apps', '/opt/etc'])(
		'a bad target %j: refused before any command is built',
		async (wd) => {
			const before = tree(APPS)
			const e = await caught(clone(wd, 'preview:pv_1'))
			expect(e.reason).toBe('path')
			expect(captured).toEqual([])
			expect(tree(APPS)).toEqual(before)
			const sh = previewDirRemoveShell('pv-x', wd, 'pv_1', { siblings: true, appsRoot: APPS })
			expect(sh).not.toMatch(/rm -|docker rm|docker network/)
		},
	)

	it('cloneTargetOk is pure on /opt/apps unless a root is passed', () => {
		expect(cloneTargetOk('/opt/apps/shop')).toBe(true)
		for (const p of ['/opt/apps', '/opt/etc', '/opt/apps/a/b', `${APPS}/shop`]) expect(cloneTargetOk(p)).toBe(false)
		expect(cloneTargetOk(`${APPS}/shop`, APPS)).toBe(true)
	})

	it.each([
		['nowd', (_wd: string) => {}],
		['checkout', (wd: string) => { mkdirSync(join(wd, 'src/app'), { recursive: true }) }],
		['checkout', (wd: string) => appDir(wd)], // a .git in the working dir
		['lock', (wd: string) => { mkdirSync(join(wd, 'pgdata'), { recursive: true }); extraEnv.FLOCK_FAIL = '1' }],
		['clone', (wd: string) => { mkdirSync(join(wd, 'pgdata'), { recursive: true }); extraEnv.FAIL_CLONE = '1' }],
	])('the src/ clone refuses before any change: %s', async (reason, setup) => {
		const parent = join(root, 'src-cases')
		mkdirSync(parent, { recursive: true })
		const wd = join(parent, `${reason}${readdirSync(parent).length}`)
		setup(wd)
		const before = tree(parent)
		const e = await caught(cloneIntoAppSrc({} as never, wd, URL_, 'main', join(wd, '.deploy-key'), join(LOCKS, 'app.lock')))
		expect(e.reason).toBe(reason)
		expect(e.placed).toBe(false)
		expect(tree(parent)).toEqual(before)
		expect(destructive()).toEqual([])
	})
})

describe('the outcome comes from the nonce status line only', () => {
	it('parseCloneStatus reads only the exact last line with this call nonce', () => {
		const n = cloneNonce()
		expect(parseCloneStatus(`__PC_${n}__ rc=0 placed=1 kept=- reason=ok\n`, n)).toEqual({ rc: 0, placed: true, kept: null, reason: 'ok' })
		// stdout carries only the status line: anything else on it means refused
		expect(parseCloneStatus(`x\n__PC_${n}__ rc=0 placed=1 kept=- reason=ok\n`, n)).toBeNull()
		expect(parseCloneStatus(`__PC_${n}__ rc=0 placed=0 kept=- reason=clone\n__PC_${n}__ rc=0 placed=1 kept=- reason=ok\n`, n)).toBeNull()
		expect(parseCloneStatus(`__PC_${n}__ rc=0 placed=1 kept=- reason=ok\nmore`, n)).toBeNull()
		expect(parseCloneStatus(`__PC_${'0'.repeat(32)}__ rc=0 placed=1 kept=- reason=ok`, n)).toBeNull()
		expect(parseCloneStatus('__POWDER_CLONE_PLACED__', n)).toBeNull()
		expect(parseCloneStatus(` __PC_${n}__ rc=0 placed=1 kept=- reason=ok`, n)).toBeNull()
	})
})

// ── what a clone does when it is allowed ───────────────────────────────────────

describe('gitCloneRepo: allowed paths', () => {
	it('a new preview dir is cloned and marked, with no leftovers', async () => {
		const wd = join(APPS, 'pv-new')
		const r = await clone(wd, 'preview:pv_1')
		expect(r.keptAt).toBeNull()
		expect(readFileSync(join(wd, '.git/powder-clone-target'), 'utf8')).toBe('powder-clone-target v1 preview:pv_1\n')
		expect(readdirSync(APPS).filter((n) => n.startsWith('pv-new.'))).toEqual([])
		expect(destructive().filter((l) => l.startsWith('rm ') || l.startsWith('docker'))).toEqual([])
	})

	it('re-spins of its own marked dir keep at most one moved-aside copy', async () => {
		const wd = join(APPS, 'pv-respin')
		await clone(wd, 'preview:pv_1')
		writeFileSync(join(wd, 'one'), '1')
		const k1 = (await clone(wd, 'preview:pv_1')).keptAt
		expect(k1).toMatch(/\/pv-respin\.before-powder\.\d+$/)
		expect(existsSync(join(k1 ?? '', 'one'))).toBe(true)
		const k2 = (await clone(wd, 'preview:pv_1')).keptAt
		expect(k2).not.toBe(k1)
		expect(readdirSync(APPS).filter((n) => n.startsWith('pv-respin.')).sort()).toEqual([basename(k2 ?? '')])
	})

	it("dead temps: only this owner's, exact name and temp marker; others stay", async () => {
		const wd = join(APPS, 'pv-sweep')
		markTmp(`${wd}.clone.preview-pv_1.1700000000000`, 'preview:pv_1')
		markTmp(`${wd}.clone.preview-pv_2.1700000000000`, 'preview:pv_2')
		mkdirSync(`${wd}.clone.preview-pv_1.1700000000001/repo/pgdata`, { recursive: true }) // no marker
		appDir(`${wd}.clone.preview-pv_1.backup`) // not the exact shape
		markTmp(`${wd}.clone.preview-pv_1.backup2`, 'preview:pv_1') // marked, not the exact shape
		await clone(wd, 'preview:pv_1')
		expect(readdirSync(APPS).filter((n) => n.startsWith('pv-sweep.')).sort()).toEqual([
			'pv-sweep.clone.preview-pv_1.1700000000001',
			'pv-sweep.clone.preview-pv_1.backup',
			'pv-sweep.clone.preview-pv_1.backup2',
			'pv-sweep.clone.preview-pv_2.1700000000000',
		])
	})

	it('every clone of a target holds one server-side lock, with a short wait', async () => {
		mode.capture = true
		await clone(join(APPS, 'pv-lock'), 'preview:pv_1').catch(() => {})
		expect(captured[0]).toContain(`exec 8>'${cloneLockPath(join(APPS, 'pv-lock'), LOCKS)}'`)
		expect(captured[0]).toContain(`flock -w ${CLONE_LOCK_WAIT_SEC} 8 ||`)
		expect(CLONE_LOCK_WAIT_SEC).toBeLessThanOrEqual(30)
	})
})

function removeStatus(name: string, siblings = false, env: Record<string, string> = {}) {
	const nonce = cloneNonce()
	const r = spawnSync('bash', ['-c', previewDirRemoveShell(name, join(APPS, name), 'pv_1', { siblings, appsRoot: APPS })], {
		env: { ...process.env, PATH: PATH_ALL, DESTRUCT_LOG: LOG, ...env },
		input: `${nonce}\n`,
		encoding: 'utf8',
	})
	expect(r.status).toBe(0)
	return parsePreviewDirStatus(r.stdout, nonce)
}

describe("preview dir removal: only the row's own marked dir and copies", () => {
	const remove = (name: string, siblings = false) => {
		return removeStatus(name, siblings)?.dir
	}
	it.each([
		['pv-r-own', 'preview:pv_1', 'removed'],
		['pv-r-other', 'preview:pv_2', 'left'],
		['pv-r-app', 'app:pv-r-app', 'left'],
		['pv-r-unmarked', null, 'left'],
		['shop-r-unmarked', null, 'left'],
	] as const)('%s (%s): %s', (name, purpose, want) => {
		const wd = join(APPS, name)
		appDir(wd)
		if (purpose) mark(wd, purpose)
		const before = tree(wd)
		expect(remove(name)).toBe(want)
		if (want === 'left') {
			expect(tree(wd)).toEqual(before)
			expect(destructive()).toEqual([])
		} else expect(existsSync(wd)).toBe(false)
	})
	it('a missing dir is absent and nothing runs', () => {
		expect(remove('pv-r-none')).toBe('absent')
		expect(destructive()).toEqual([])
	})
	it("siblings: this row's exact-shape marked copies go; unmarked, other-owner or odd names stay", () => {
		const wd = join(APPS, 'pv-r-sib')
		mark(wd, 'preview:pv_1')
		mark(`${wd}.before-powder.1`, 'preview:pv_1')
		markTmp(`${wd}.clone.preview-pv_1.2`, 'preview:pv_1')
		mark(`${wd}.before-powder.3`, 'preview:pv_2')
		appDir(`${wd}.before-powder.4`)
		mark(`${wd}.before-powder.old`, 'preview:pv_1')
		expect(remove('pv-r-sib', true)).toBe('removed')
		expect(readdirSync(APPS).filter((n) => n.startsWith('pv-r-sib.')).sort()).toEqual([
			'pv-r-sib.before-powder.3',
			'pv-r-sib.before-powder.4',
			'pv-r-sib.before-powder.old',
		])
	})
})

describe('an interrupted clone leaves no temp clone', () => {
	it('src/ clone killed mid-clone: its marked temp dir is removed, nothing else changes', async () => {
		const wd = join(root, 'kill', 'shop')
		mkdirSync(join(wd, 'pgdata'), { recursive: true })
		writeFileSync(join(wd, 'docker-compose.yml'), 'services: {}\n')
		const before = tree(wd)
		const key = tempKey()
		mode.capture = true
		await cloneIntoAppSrc({} as never, wd, URL_, 'main', key, join(LOCKS, 'kill.lock'), { removeKey: true }).catch(() => {})
		const pidFile = join(root, 'kill', 'clone.pid')
		const child = spawn('bash', ['-c', captured[0] ?? ''], {
			env: { ...process.env, PATH: PATH_ALL, ...extraEnv, SLOW_CLONE: pidFile },
			stdio: ['pipe', 'ignore', 'ignore'],
		})
		child.stdin?.end(capturedStdin[0] ?? '')
		const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)))
		const t0 = Date.now()
		while (!existsSync(pidFile) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50))
		expect(readdirSync(wd).some((n) => n.startsWith('.powder-clone-src.'))).toBe(true)
		child.kill('SIGTERM')
		process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
		expect(await exited).not.toBe(0)
		expect(tree(wd)).toEqual(before)
		// the temp key went with the TERM too
		expect(existsSync(key)).toBe(false)
	})

	it("the next src/ clone removes this owner's dead marked temp and clones into src", async () => {
		const wd = join(root, 'stale', 'shop')
		markTmp(join(wd, '.powder-clone-src.1700000000000'), 'src:shop')
		mkdirSync(join(wd, '.powder-clone-src.1700000000000/repo/.git'), { recursive: true })
		writeFileSync(join(wd, 'docker-compose.yml'), 'services: {}\n')
		await cloneIntoAppSrc({} as never, wd, URL_, 'main', join(wd, '.deploy-key'), join(LOCKS, 'stale.lock'))
		expect(readdirSync(wd).sort()).toEqual(['docker-compose.yml', 'src'])
		expect(existsSync(join(wd, 'src/.git'))).toBe(true)
	})
})

describe('the status channel cannot be forged or lost', () => {
	it('a child that outlives the script and prints a forged line with the right nonce is not accepted', async () => {
		const wd = join(APPS, 'pv-forge-late')
		appDir(wd)
		mark(wd, 'preview:pv_1')
		const before = tree(APPS)
		Object.assign(extraEnv, { FORGE: '1', FAIL_CLONE: '1' })
		const e = await caught(clone(wd, 'preview:pv_1'))
		expect(e.reason).toBe('clone')
		expect(e.placed).toBe(false)
		expect(tree(APPS)).toEqual(before)
	})

	it('the nonce reaches the script on stdin, never in its command line', async () => {
		mode.capture = true
		await clone(join(APPS, 'pv-argv'), 'preview:pv_1').catch(() => {})
		const nonce = (capturedStdin[0] ?? '').trim()
		expect(nonce).toMatch(/^[0-9a-f]{32}$/)
		expect(captured[0]).not.toContain(nonce)
	})

	it('a cleanup command that fails in the exit trap does not lose the status line', async () => {
		const wd = join(APPS, 'pv-trap-rmdir')
		Object.assign(extraEnv, { FAIL_CLONE: '1', EXTRA_IN_TMP: '1' })
		const e = await caught(clone(wd, 'preview:pv_1'))
		// the status line came through: the real reason, not "failed" (a missing line)
		expect(e.reason).toBe('clone')
		expect(e.placed).toBe(false)
		// the temp dir held a file this run did not make: it stays (unmarked now, only rmdir was tried)
		expect(readdirSync(APPS).filter((n) => n.startsWith('pv-trap-rmdir.clone.'))).toHaveLength(1)
		expect(destructive()).toEqual([])
	})

	it('an owner too long for a file name is refused before any command', async () => {
		const e = await caught(clone(join(APPS, 'pv-long'), `preview:${'x'.repeat(161)}`))
		expect(e.reason).toBe('input')
		expect(e.message).toMatch(/at most 160 characters\); nothing was run/)
		const e2 = await caught(clone(join(APPS, `pv-${'y'.repeat(200)}`), `preview:${'x'.repeat(60)}`))
		expect(e2.reason).toBe('path')
		expect(e2.message).toMatch(/too long for the temp clone's file name \(at most 255 bytes\); nothing was run/)
		expect(captured).toEqual([])
	})
})

describe('preview removal: the page is told exactly what was left', () => {
	const NAME = 'pv-n'
	const LIST = `docker ps -a --filter label=com.docker.compose.project=${NAME}`
	const at = (n: string) => join(APPS, n)
	it.each([
		['marked dir, no containers left', 'pv-n-1', 'preview:pv_1', '', {}, null],
		[
			'unmarked dir, no containers',
			'pv-n-2',
			null,
			'',
			{},
			`left ${at('pv-n-2')} in place: powder cannot prove it created it; remove it by hand if it is not needed`,
		],
		[
			'unmarked dir, 2 containers',
			'pv-n-3',
			null,
			'a1\nb2\n',
			{},
			`left ${at('pv-n-3')} in place: powder cannot prove it created it; remove it by hand if it is not needed. 2 containers of project ${NAME} were left too and may still serve the preview's address: stop and remove them by hand if not needed (${LIST})`,
		],
		[
			'unmarked dir, docker unreadable',
			'pv-n-4',
			null,
			'',
			{ DOCKER_FAIL: '1' },
			`left ${at('pv-n-4')} in place: powder cannot prove it created it; remove it by hand if it is not needed. powder could not count the containers of project ${NAME}; check by hand: ${LIST}`,
		],
		['no dir, no containers (a clone that never placed)', 'pv-n-5', 'absent', '', {}, null],
		[
			'no dir, 1 container',
			'pv-n-6',
			'absent',
			'a1\n',
			{},
			`no directory at ${at('pv-n-6')}; 1 container of project ${NAME} was left: powder cannot prove it is this preview's, so remove it by hand if not needed (${LIST})`,
		],
	] as const)('%s', (_n, dir, purpose, ps, env, want) => {
		if (purpose !== 'absent') {
			appDir(at(dir))
			if (purpose) mark(at(dir), purpose)
		}
		const nonce = cloneNonce()
		const r = spawnSync('bash', ['-c', previewDirRemoveShell(NAME, at(dir), 'pv_1', { appsRoot: APPS })], {
			env: { ...process.env, PATH: PATH_ALL, DESTRUCT_LOG: LOG, DOCKER_PS: ps, ...env },
			input: `${nonce}\n`,
			encoding: 'utf8',
		})
		const st = parsePreviewDirStatus(r.stdout, nonce)
		expect(previewRemovalNote(NAME, at(dir), st)).toBe(want)
	})
})

describe('a missing or malformed nonce: the script refuses before anything else', () => {
	const BAD = [
		['stdin at EOF', ''],
		['an empty line', '\n'],
		['a short value', 'abc123\n'],
		['a non-hex value', `${'g'.repeat(32)}\n`],
		['upper-case hex', `${'A'.repeat(32)}\n`],
	] as const
	it.each(BAD)('the workdir clone (%s): nothing done, no outcome, read as not placed', async (_n, input) => {
		const wd = join(APPS, `pv-nonce-${readdirSync(APPS).length}`)
		appDir(wd)
		mark(wd, 'preview:pv_1')
		const before = tree(APPS)
		stdinOverride.value = input
		const e = await caught(clone(wd, 'preview:pv_1'))
		expect(e.reason).toBe('nostatus')
		expect(e.placed).toBe(false)
		expect(e.message).toMatch(/reported no outcome .* clone refused: no valid call value on stdin, nothing was run/)
		expect(tree(APPS)).toEqual(before)
		expect(destructive()).toEqual([])
		expect(existsSync(LOCKS) ? readdirSync(LOCKS).filter((n) => n.includes('pv-nonce')) : []).toEqual([])
	})
	it.each(BAD)('the src/ clone (%s): nothing done, the temp key stays for the caller to remove', async (_n, input) => {
		const parent = join(root, 'nonce-src')
		mkdirSync(parent, { recursive: true })
		const wd = join(parent, `a${readdirSync(parent).length}`)
		mkdirSync(join(wd, 'pgdata'), { recursive: true })
		const before = tree(parent)
		stdinOverride.value = input
		const e = await caught(cloneIntoAppSrc({} as never, wd, URL_, 'main', randomTempPath(CLONE_KEY_TMP_PREFIX), join(LOCKS, 'n.lock'), { removeKey: true }))
		expect(e.reason).toBe('nostatus')
		expect(tree(parent)).toEqual(before)
		expect(destructive()).toEqual([])
	})
	it.each(BAD)('the preview removal (%s): nothing removed, the note says nothing is known', (_n, input) => {
		const name = `pv-nonce-rm-${readdirSync(APPS).length}`
		appDir(at(name))
		mark(at(name), 'preview:pv_1')
		const before = tree(at(name))
		const r = spawnSync('bash', ['-c', previewDirRemoveShell(name, at(name), 'pv_1', { appsRoot: APPS })], {
			env: { ...process.env, PATH: PATH_ALL, DESTRUCT_LOG: LOG },
			input,
			encoding: 'utf8',
		})
		expect(r.status).toBe(2)
		expect(r.stderr).toContain('preview removal refused: no valid call value on stdin, nothing was run')
		const st = parsePreviewDirStatus(r.stdout, cloneNonce())
		expect(st).toBeNull()
		expect(previewRemovalNote(name, at(name), st)).toBe(
			`the removal did not run or did not answer: nothing is known about ${at(name)} or the preview's containers; check the server`,
		)
		expect(tree(at(name))).toEqual(before)
		expect(destructive()).toEqual([])
	})
	it('stdin left open: the script gives up after 10 s and does nothing', async () => {
		const wd = join(APPS, 'pv-nonce-open')
		appDir(wd)
		mark(wd, 'preview:pv_1')
		const before = tree(APPS)
		mode.capture = true
		await clone(wd, 'preview:pv_1').catch(() => {})
		const child = spawn('bash', ['-c', captured[0] ?? ''], { env: { ...process.env, PATH: PATH_ALL, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
		let out = ''
		let err = ''
		child.stdout?.on('data', (d) => { out += String(d) })
		child.stderr?.on('data', (d) => { err += String(d) })
		const t0 = Date.now()
		const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
		child.stdin?.end()
		expect(code).toBe(2)
		expect(Date.now() - t0).toBeLessThan(20_000)
		expect(out).toBe('')
		expect(err).toContain('clone refused: no valid call value on stdin, nothing was run')
		expect(tree(APPS)).toEqual(before)
		expect(destructive()).toEqual([])
	}, 60_000)
	it('under dash (no read -t): the timeout + head reader takes a valid value and refuses a missing one', () => {
		const dash = spawnSync('sh', ['-c', 'command -v dash'], { encoding: 'utf8' }).stdout.trim()
		if (!dash) return
		// the servers' coreutils timeout; here a stand-in that runs the command
		const tdir = join(root, 'timeout-stub')
		mkdirSync(tdir, { recursive: true })
		writeFileSync(join(tdir, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n')
		chmodSync(join(tdir, 'timeout'), 0o755)
		const sh = `${nonceReadShell('N', 'clone')}echo "got $N"`
		const run = (input: string) =>
			spawnSync(dash, ['-c', sh], { env: { ...process.env, PATH: `${tdir}:${process.env.PATH}` }, input, encoding: 'utf8' })
		const ok = run(`${'a'.repeat(32)}\n`)
		expect(ok.stdout).toBe(`got ${'a'.repeat(32)}\n`)
		for (const input of ['', '\n', 'abc\n', `${'g'.repeat(32)}\n`]) expect(run(input).status).toBe(2)
	})
})

describe('a TERM during the post-placement guard keeps the outcome', () => {
	it('the status line still arrives, with placed=1', async () => {
		const wd = join(APPS, 'pv-term')
		mode.capture = true
		await clone(wd, 'preview:pv_1').catch(() => {})
		// fd 3 is closed only inside subshells (`( exec 3>&-; ... )`), never by a redirection
		// on a `{ }` group or a command in the main shell: bash runs a TERM trap that fires
		// between the commands of such a group with fd 3 still closed, and the status line
		// is lost
		expect(captured[0]).not.toMatch(/[})] 3>&-|[^(] exec 3>&-/)
		expect(captured[0]?.match(/\( exec 3>&-; /g)?.length).toBe(3)
		const pidFile = join(root, 'term.pid')
		const child = spawn('bash', ['-c', captured[0] ?? ''], {
			env: { ...process.env, PATH: PATH_ALL, ...extraEnv, SLOW_GUARD_NAME: 'pv-term', SLOW_GUARD_PID: pidFile },
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		child.stdin?.end(capturedStdin[0] ?? '')
		let out = ''
		child.stdout?.on('data', (d) => { out += String(d) })
		child.stderr?.on('data', () => {})
		const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
		const t0 = Date.now()
		const pidOf = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) || 0 : 0)
		while (!pidOf() && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 50))
		expect(existsSync(join(wd, '.git/powder-clone-target'))).toBe(true) // placed
		expect(pidOf()).toBeGreaterThan(1)
		child.kill('SIGTERM')
		process.kill(pidOf(), 'SIGKILL')
		expect(await exited).not.toBe(0)
		const st = parseCloneStatus(out, (capturedStdin[0] ?? '').trim())
		expect(st).toMatchObject({ placed: true, reason: 'killed' })
	}, 60_000)
})

describe('the src/ clone removes its temp key when it exits', () => {
	it.each([
		['the app deploy key', (wd: string) => join(wd, '.deploy-key')],
		['another file in /tmp', (_wd: string) => '/tmp/powder-clone-key'],
		['a temp key of another shape', (_wd: string) => `${CLONE_KEY_TMP_PREFIX}.tmp.${'g'.repeat(16)}`],
		['a temp key under another dir', (wd: string) => `${wd}/powder-clone-key.tmp.${'a'.repeat(16)}`],
	])('removeKey with %s: refused before any command, the file stays', async (_n, keyOf) => {
		const parent = join(root, 'keyshape')
		mkdirSync(parent, { recursive: true })
		const wd = join(parent, `a${readdirSync(parent).length}`)
		mkdirSync(wd, { recursive: true })
		const key = keyOf(wd)
		if (key.startsWith(wd)) writeFileSync(key, 'PRIVATE')
		const e = await caught(cloneIntoAppSrc({} as never, wd, URL_, 'main', key, join(LOCKS, 'k.lock'), { removeKey: true }))
		expect(e.reason).toBe('input')
		expect(e.message).toMatch(/is not a temp key of the clone action .*nothing was run/)
		expect(captured).toEqual([])
		expect(destructive()).toEqual([])
		if (key.startsWith(wd)) expect(readFileSync(key, 'utf8')).toBe('PRIVATE')
	})
	it('the script checks the shape again before its rm', async () => {
		mode.capture = true
		const key = randomTempPath(CLONE_KEY_TMP_PREFIX)
		await cloneIntoAppSrc({} as never, join(root, 'x'), URL_, 'main', key, join(LOCKS, 'k.lock'), { removeKey: true }).catch(() => {})
		expect(captured[0]).toContain(`__pk='${key}'; case "$__pk" in '${CLONE_KEY_TMP_PREFIX}.tmp.'????????????????) case "\${__pk##*.}" in *[!0123456789abcdef]*) ;; *) rm -f -- "$__pk" ;; esac ;; esac;`)
	})
	it.each([
		['after a refusal', (wd: string) => mkdirSync(join(wd, 'src'), { recursive: true }), 'checkout'],
		['after a clone', (_wd: string) => {}, 'ok'],
	])('%s', async (_n, setup, want) => {
		const parent = join(root, 'keyrm')
		mkdirSync(parent, { recursive: true })
		const wd = join(parent, `a${readdirSync(parent).length}`)
		mkdirSync(wd, { recursive: true })
		setup(wd)
		const key = tempKey()
		const r = await cloneIntoAppSrc({} as never, wd, URL_, 'main', key, join(LOCKS, 'k.lock'), { removeKey: true }).then(
			() => 'ok',
			(e: CloneError) => e.reason,
		)
		expect(r).toBe(want)
		expect(existsSync(key)).toBe(false)
	})
})
