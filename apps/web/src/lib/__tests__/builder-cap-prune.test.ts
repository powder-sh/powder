import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
	BUILDER_PRUNE_PATHS,
	BUILD_CACHE_TOTAL_MB_SHELL,
	builderCacheCapGb,
	builderCapPruneShell,
	builderDiskRisk,
	parseBuilderPruneResult,
} from '../builder-prune'
import { buildBuilderScript, builderDirCleanupShell } from '../builder'
import { buildLockShell, rootOrHomePathShell } from '../build-lock'
import { needTool } from './need-tool'

// `--max-used-space` counts private bytes only, so with shared records the `docker buildx du`
// Total can sit far above a cap that never bites. The cap
// prune checks the Total and prunes by age in steps until it is under the cap.

// The prune runs only on Linux build hosts and calls GNU `timeout` (coreutils), which
// macOS does not ship: without it every `docker buildx du` reads as -1, so the tests
// that run the script skip there (and fail on the Linux gate if timeout is missing).
const HAS_TIMEOUT = needTool(
	'builder-cap-prune',
	spawnSync('timeout', ['--version']).status === 0,
	'GNU timeout (coreutils) is not installed; the cap prune script needs it',
)

const root = mkdtempSync(join(tmpdir(), 'bcp-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A stub docker whose cache Total is `start`; each `until=<age>` prune leaves
 *  `after[age]` (unchanged when absent). Logs every call. */
function stub(name: string, start: string, after: Record<string, string> = {}, du = true) {
	const dir = join(root, name)
	const bin = join(dir, 'bin')
	mkdirSync(bin, { recursive: true })
	const state = join(dir, 'total')
	const log = join(dir, 'docker.log')
	writeFileSync(state, start)
	writeFileSync(log, '')
	const cases = Object.entries(after)
		.map(([age, v]) => `*until=${age}*) echo ${v} > ${JSON.stringify(state)};;`)
		.join(' ')
	writeFileSync(
		join(bin, 'docker'),
		`#!/bin/bash\necho "$*" >> ${JSON.stringify(log)}\n` +
			`case "$*" in "buildx du") ${du ? `printf 'ID\\tRECLAIMABLE\\tSIZE\\nabc\\ttrue\\t1GB\\nShared:\\t\\t1GB\\nPrivate:\\t\\t1GB\\nReclaimable:\\t%s\\nTotal:\\t\\t%s\\n' "$(cat ${JSON.stringify(state)})" "$(cat ${JSON.stringify(state)})"` : 'exit 1'};; ` +
			`"builder prune"*) case "$*" in ${cases} *) ;; esac;; esac\nexit 0\n`,
	)
	writeFileSync(join(bin, 'ps'), '#!/bin/bash\nexit 0\n')
	writeFileSync(join(bin, 'df'), '#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 300 150 150 61%% /\\n"\n')
	for (const f of ['docker', 'ps', 'df']) chmodSync(join(bin, f), 0o755)
	return { bin, log, dir }
}

// the clone sweep only ever sees this temp dir, never /opt/builds; no busy wait.
const buildsRoot = join(root, 'builds')
mkdirSync(buildsRoot)
// the real flock; every lock and state file lives in the stub's dir.
const shell = (capGb = 30, dir = join(root, 'none')) =>
	builderCapPruneShell({
		capGb,
		buildsRoot,
		busyWaitSec: 1,
		pullWaitSec: 0,
		lockPath: join(dir, 'prune.lock'),
		slotLockPrefix: join(dir, 'slot.'),
		stateFile: join(dir, 'state', 'last'),
	})

function run(s: { bin: string; log: string; dir: string }, capGb = 30) {
	writeFileSync(s.log, '')
	const r = spawnSync('bash', ['-c', shell(capGb, s.dir)], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` },
	})
	return { code: r.status, out: r.stdout, calls: readFileSync(s.log, 'utf8') }
}

describe('build host cap prune', () => {
	it.skipIf(!HAS_TIMEOUT)('prunes by age in steps until the Total (shared included) is under the cap', () => {
		const s = stub('over', '207.2GB', { '24h': '120GB', '12h': '60GB', '6h': '25.5GB', '3h': '1GB' })
		const r = run(s)
		expect(r.code).toBe(0)
		expect(r.calls).toContain('builder prune -af --max-used-space 30GB')
		expect(r.calls).toContain('until=24h')
		expect(r.calls).toContain('until=12h')
		expect(r.calls).toContain('until=6h')
		expect(r.calls).not.toContain('until=3h')
		const p = parseBuilderPruneResult(r.out)
		expect(p).toMatchObject({ cacheMb: 25500, capMb: 30000, rootPct: 61, pruned: true, skip: null })
		// real clock: the prune and the marker may fall in different seconds.
		expect(p?.lastPruneAgeSec).toBeLessThanOrEqual(1)
	})
	it.skipIf(!HAS_TIMEOUT)('never prunes by age when the cache is under the cap', () => {
		const r = run(stub('under', '12.3GB'))
		expect(r.calls).not.toContain('until=')
		expect(parseBuilderPruneResult(r.out)?.cacheMb).toBe(12300)
	})
	it.skipIf(!HAS_TIMEOUT)('stops at cache unused for 1h, never prunes everything', () => {
		const s = stub('stuck', '500GB')
		const r = run(s)
		expect(r.calls).toContain('until=1h')
		expect(r.calls).not.toMatch(/until=(0|30m)/)
		expect(r.calls.match(/until=/g)?.length).toBe(5)
		const p = parseBuilderPruneResult(r.out)
		// the first prune has no earlier one to compare with.
		expect(p).toMatchObject({ beforeMb: 500000, stuckPrunes: 0 })
		expect(p && builderDiskRisk(p)).toBeNull()
		expect(readFileSync(join(s.dir, 'state', 'builder-prune.after'), 'utf8').trim()).toBe('500000')
	})
	it.skipIf(!HAS_TIMEOUT)('a runaway cache counts even when every prune reclaims some: 63 -> 90 -> 120 -> 150 GB left warns', () => {
		const left = [63, 90, 120, 150]
		let p = null as ReturnType<typeof parseBuilderPruneResult>
		left.forEach((gb, i) => {
			// each run finds 20 GB more than its prune leaves (the prune reclaims).
			const s = stub('runaway', `${gb + 20}GB`, { '1h': `${gb}GB` })
			rmSync(join(s.dir, 'state', 'builder-prune.attempt'), { force: true })
			p = parseBuilderPruneResult(run(s).out)
			expect(p).toMatchObject({ cacheMb: gb * 1000, beforeMb: (gb + 20) * 1000, pruned: true, stuckPrunes: i })
			if (i < 3) expect(p && builderDiskRisk(p)).toBeNull()
		})
		expect(p && builderDiskRisk(p)).toBe('build cache 150 GB over the 30 GB cap and larger after each of 3 prunes in a row')
	})
	it.skipIf(!HAS_TIMEOUT)('a prune that leaves less than the one before resets the count (72.2 -> 62.9 GB)', () => {
		const s = stub('shrank', '72.16GB', { '1h': '62.89GB' })
		mkdirSync(join(s.dir, 'state'), { recursive: true })
		writeFileSync(join(s.dir, 'state', 'builder-prune.stuck'), '2\n')
		writeFileSync(join(s.dir, 'state', 'builder-prune.after'), '70000\n')
		const r = run(s)
		expect(r.calls).toContain('until=24h')
		expect(r.calls).toContain('until=1h')
		const p = parseBuilderPruneResult(r.out)
		expect(p).toMatchObject({ cacheMb: 62890, beforeMb: 72160, pruned: true, skip: null, stuckPrunes: 0 })
		expect(p && builderDiskRisk(p)).toBeNull()
		expect(readFileSync(join(s.dir, 'state', 'builder-prune.after'), 'utf8').trim()).toBe('62890')
	})
	it.skipIf(!HAS_TIMEOUT)('a run under the cap resets the count', () => {
		const s = stub('under-reset', '12GB')
		mkdirSync(join(s.dir, 'state'), { recursive: true })
		writeFileSync(join(s.dir, 'state', 'builder-prune.stuck'), '2\n')
		writeFileSync(join(s.dir, 'state', 'builder-prune.after'), '90000\n')
		expect(parseBuilderPruneResult(run(s).out)?.stuckPrunes).toBe(0)
		expect(readFileSync(join(s.dir, 'state', 'builder-prune.stuck'), 'utf8').trim()).toBe('0')
		expect(readFileSync(join(s.dir, 'state', 'builder-prune.after'), 'utf8').trim()).toBe('0')
	})
	it.skipIf(!HAS_TIMEOUT)('streak file not writable: said in the output', () => {
		const s = stub('streak-ro', '90GB', { '1h': '80GB' })
		for (const f of ['state/builder-prune.stuck', 'state/builder-prune.after']) mkdirSync(join(s.dir, f), { recursive: true })
		const r = run(s)
		expect(r.out).toContain(`${join(s.dir, 'state', 'builder-prune.stuck')} is not writable: the cache growth streak is not kept`)
		expect(parseBuilderPruneResult(r.out)).toMatchObject({ pruned: true, stuckPrunes: 0 })
	})
	it.skipIf(!HAS_TIMEOUT)('an unreadable Total never escalates (no blind prune)', () => {
		const r = run(stub('nodu', '500GB', {}, false))
		expect(r.calls).not.toContain('until=')
		expect(parseBuilderPruneResult(r.out)?.cacheMb).toBe(-1)
	})
	it.skipIf(spawnSync('flock', ['--version']).status !== 0)('no image or cache prune at all while a build holds a slot; only measures', () => {
		expect(run(stub('idle', '500GB')).calls).toContain('image prune -f')
		expect(run(stub('idle-under', '1GB')).calls).not.toContain('prune')
		const s = stub('img', '500GB', { '24h': '1GB' })
		const hold = spawn('flock', [join(s.dir, 'slot.1'), 'sleep', '10'], { stdio: 'ignore' })
		hold.on('error', () => {})
		try {
			spawnSync('bash', ['-c', `for i in $(seq 50); do flock -n ${JSON.stringify(join(s.dir, 'slot.1'))} true || exit 0; sleep 0.1; done`])
			const busy = run(s)
			expect(busy.calls).not.toContain('prune')
			expect(busy.calls).toContain('buildx du')
			expect(busy.out).toContain('cache and image prune skipped')
			expect(parseBuilderPruneResult(busy.out)).toMatchObject({ cacheMb: 500000, pruned: false, skip: 'locked' })
		} finally {
			hold.kill()
		}
		expect(shell()).not.toMatch(/image prune -a|docker rmi/)
	})
	it('the prune holds every build slot, each waited for a share of busyWaitSec', () => {
		const s = builderCapPruneShell({ busyWaitSec: 600, slots: 2 })
		const pull = `flock -o -x -w 60 -E 215 ${rootOrHomePathShell(BUILDER_PRUNE_PATHS.pull.root, BUILDER_PRUNE_PATHS.pull.user, 'builder-prune')}`
		expect(s).toContain(`flock -o -w 300 -E 213 ${buildLockShell('.0')} flock -o -w 300 -E 213 ${buildLockShell('.1')} ${pull} timeout -k 10 900 sh -c`)
		expect(builderCapPruneShell({ slots: 3, busyWaitSec: 0 })).toContain(`flock -o -w 1 -E 213 ${buildLockShell('.2')} ${pull} timeout -k 10 900 sh -c`)
	})
	// A prune that overlaps a builder script's image pull fails the pull inside dockerd
	// ("failed to lease content: NotFound: lease ... not found"): the test gate then
	// refuses and the deploy falls back to a local build.
	it.skipIf(!HAS_TIMEOUT || spawnSync('flock', ['--version']).status !== 0)('no prune while a builder script pull holds the pull lock; it runs once the pull ends', async () => {
		const s = stub('pull', '50GB', { '24h': '20GB' })
		const sh = builderCapPruneShell({ capGb: 30, buildsRoot, busyWaitSec: 1, pullWaitSec: 0, pullLockWaitSec: 1, lockPath: join(s.dir, 'prune.lock'), slotLockPrefix: join(s.dir, 'slot.'), stateFile: join(s.dir, 'state', 'last') })
		const go = () => {
			writeFileSync(s.log, '')
			const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` } })
			return { out: r.stdout, calls: readFileSync(s.log, 'utf8') }
		}
		// what builderPullGuardFunctions does around `docker pull` (-o: killing flock frees the lock)
		const hold = spawn('flock', ['-s', '-o', join(s.dir, 'prune.lock.pull'), 'sleep', '10'], { stdio: 'ignore' })
		try {
			spawnSync('bash', ['-c', `for i in $(seq 50); do flock -n ${JSON.stringify(join(s.dir, 'prune.lock.pull'))} true || exit 0; sleep 0.1; done`])
			const r = go()
			expect(r.out).toContain('pruned=0 skip=busy')
			expect(r.calls).not.toMatch(/image prune|builder prune/)
		} finally {
			hold.kill()
		}
		await new Promise((res) => hold.once('exit', res))
		// the busy skip held the slots, so the 1h gate is on: clear it for the second run.
		rmSync(join(s.dir, 'state', 'builder-prune.attempt'), { force: true })
		const r2 = go()
		expect(r2.calls).toMatch(/image prune -f/)
		expect(r2.out).toContain('pruned=1')
	})
	it('sweeps clones older than a week under the builds root only', () => {
		const old = join(buildsRoot, 'aaaa-old')
		const fresh = join(buildsRoot, 'bbbb-new')
		mkdirSync(join(old, 'src'), { recursive: true })
		mkdirSync(fresh)
		const t = new Date('2000-01-01T00:00:00Z')
		utimesSync(old, t, t)
		run(stub('sweep', '1GB'))
		expect(existsSync(old)).toBe(false)
		expect(existsSync(fresh)).toBe(true)
		expect(builderCapPruneShell()).toContain("find '/opt/builds' -mindepth 1")
		expect(() => builderCapPruneShell({ buildsRoot: '/opt/../' })).toThrow()
		expect(() => builderCapPruneShell({ buildsRoot: 'rel' })).toThrow()
	})
	it.skipIf(!HAS_TIMEOUT)('parses the Total in every unit docker prints', () => {
		const total = (v: string) => {
			const s = stub(`u-${v.replace(/\./g, '_')}`, v)
			return spawnSync('bash', ['-c', BUILD_CACHE_TOTAL_MB_SHELL], { encoding: 'utf8', env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` } }).stdout.trim()
		}
		expect(total('0B')).toBe('0')
		expect(total('512MB')).toBe('512')
		expect(total('207.2GB')).toBe('207200')
		expect(total('1.5TB')).toBe('1500000')
		expect(total('900kB')).toBe('0')
		expect(total('12XB')).toBe('-1')
	})
	it('reports a host only for 3 growing prunes in a row over the cap or the disk 75% full', () => {
		// 62.9 GB after a prune that shrank it, cap 30 GB, root 29%.
		expect(builderDiskRisk({ cacheMb: 62890, capMb: 30000, rootPct: 29, stuckPrunes: 0 })).toBeNull()
		expect(builderDiskRisk({ cacheMb: 500000, capMb: 30000, rootPct: 70, stuckPrunes: 2 })).toBeNull()
		expect(builderDiskRisk({ cacheMb: -1, capMb: 30000, rootPct: 70, stuckPrunes: 5 })).toBeNull()
		expect(builderDiskRisk({ cacheMb: 61000, capMb: 30000, rootPct: 70, stuckPrunes: 3 })).toContain('build cache 61 GB over the 30 GB cap and larger after each of 3 prunes')
		expect(builderDiskRisk({ cacheMb: 1000, capMb: 30000, rootPct: 75, stuckPrunes: 0 })).toBe('root disk 75% full')
		expect(builderDiskRisk({ cacheMb: 1000, capMb: 30000, rootPct: 74, stuckPrunes: 0 })).toBeNull()
		expect(parseBuilderPruneResult('[builder-prune] another prune is running, skipped\n')).toBeNull()
	})
	it('the cap defaults to 30 GB and is clamped', () => {
		expect(builderCacheCapGb({})).toBe(30)
		expect(builderCacheCapGb({ POWDER_BUILDER_CACHE_CAP_GB: '60' })).toBe(60)
		expect(builderCacheCapGb({ POWDER_BUILDER_CACHE_CAP_GB: '1' })).toBe(5)
		expect(builderCacheCapGb({ POWDER_BUILDER_CACHE_CAP_GB: 'x' })).toBe(30)
	})
	it('one prune at a time: a held lock skips the run', () => {
		const s = stub('locked', '500GB')
		writeFileSync(join(s.bin, 'flock'), '#!/bin/bash\nexit 1\n')
		chmodSync(join(s.bin, 'flock'), 0o755)
		const r = run(s)
		expect(r.out).toContain('another prune is running, skipped')
		expect(r.calls).toBe('')
	})
})

describe('builder clone cleanup', () => {
	it('the EXIT trap removes the clone after a successful build too, the image only after a failure', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/s-demoapp',
			keyPath: '/opt/builds/s-demoapp.k.x',
			repoUrl: 'git@github.com:example-org/demoapp.git',
			branch: 'main',
			sha: null,
			image: 'demoapp:latest',
			uniq: 'demoapp:latest-b42',
			ctx: '/opt/builds/s-demoapp/src',
			df: '/opt/builds/s-demoapp/src/Dockerfile',
			buildArgs: '',
			app: 'demoapp',
		})
		const trap = s.slice(s.indexOf('trap '), s.indexOf(' EXIT; '))
		const success = trap.slice(trap.indexOf('else :; '))
		expect(success).toContain("rm -rf -- '\\''/opt/builds/s-demoapp'\\''")
		expect(success).not.toContain('rmi')
		expect(builderDirCleanupShell('/opt/builds')).toBe('')
		expect(builderDirCleanupShell('/opt/builds/..')).toBe('')
		expect(builderDirCleanupShell('/opt/builds/a/b')).toBe('')
	})
})
