import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { builderFailCleanupShell, buildBuilderScript } from '../builder'
import { buildDeployScript } from '../deploy/script'
import { BUILDER_PRUNE_DEFAULTS, BUILDER_PRUNE_RUN_TIMEOUT_SEC, BUILDER_PRUNE_STALE_SEC, IMAGE_PULL_ERE, builderCapPruneShell, builderCapPruneWorstSec, builderPruneLogLine, builderPruneVerdict, parseBuilderPruneResult } from '../builder-prune'
import { writeFakeDocker } from './fixtures/fake-docker'

// the builder's EXIT trap removes the unique image and the clone after a failed
// build, and the builder always builds with --pull. The low-disk reclaim only
// prunes build cache unused for 24h.

const root = mkdtempSync(join(tmpdir(), 'bld-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const bin = join(root, 'bin')
mkdirSync(bin)
const log = join(root, 'docker.log')
writeFakeDocker(bin, `#!/bin/bash\necho "$*" >> ${JSON.stringify(log)}\nexit 0\n`)

const script = (pull?: boolean) =>
	buildBuilderScript({
		dir: '/opt/builds/s-demoapp',
		keyPath: join(root, 'key'),
		repoUrl: 'git@github.com:example-org/demoapp.git',
		branch: 'main',
		sha: null,
		image: 'demoapp:latest',
		uniq: 'demoapp:latest-b42',
		ctx: '/opt/builds/s-demoapp/src',
		df: '/opt/builds/s-demoapp/src/Dockerfile',
		buildArgs: '',
		app: 'demoapp',
		...(pull === undefined ? {} : { pull }),
	})

/** Run the script's prologue up to (and with) its EXIT trap, then exit with `rc`. */
function trapRun(rc: number): string {
	const s = script()
	const at = s.indexOf(' EXIT; ')
	writeFileSync(log, '')
	spawnSync('bash', ['-c', `${s.slice(0, at + 7)}exit ${rc}`], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	})
	return readFileSync(log, 'utf8')
}

describe('builder cleanup and pull', () => {
	it('a failed build removes the unique image; a successful one keeps it for the stream', () => {
		expect(trapRun(3)).toContain('rmi -- demoapp:latest-b42')
		expect(trapRun(0)).not.toContain('rmi')
	})
	it('the failure cleanup removes the clone dir, only for /opt/builds/<slug> and <image>-b<id>', () => {
		expect(script()).toContain("rm -rf -- '\\''/opt/builds/s-demoapp'\\''")
		expect(builderFailCleanupShell('/opt/builds/x', 'x-b1')).toContain("rm -rf -- '/opt/builds/x'")
		expect(builderFailCleanupShell('/opt/builds', 'x-b1')).not.toContain('rm -rf')
		expect(builderFailCleanupShell('/opt/builds/..', 'x-b1')).not.toContain('rm -rf')
		expect(builderFailCleanupShell('/opt/builds/a/b', 'x-b1')).not.toContain('rm -rf')
		expect(builderFailCleanupShell('/opt/builds/x', 'x')).not.toContain('rmi')
	})
	it('builds with --pull even when pull is off', () => {
		expect(script(false)).toContain('docker build --pull ')
		expect(script(false)).toContain('DFR_PULL=1')
	})
	it('the low-disk reclaim prunes only build cache unused for 24h', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/demoapp',
			configFile: '/opt/apps/demoapp/docker-compose.yml',
			service: 'app',
			cf: "-f '/opt/apps/demoapp/docker-compose.yml'",
			declaredMode: 'auto',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		expect(s).toContain('docker builder prune -af --filter unused-for=24h')
		expect(s).not.toMatch(/docker builder prune -af >/)
	})
})

// the cap prune after a builder phase: a run that could not prune (builds held
// the slots, a pull ran, the prune failed) gives no "after the prune" verdict; a
// cache not pruned for 6h does. The clock is a stub `date` (NOW); ages come from
// the state file. Slot holders are real flock processes (util-linux).
const HAS_FLOCK = spawnSync('flock', ['--version']).status === 0

describe('builder cap prune verdict', () => {
	const NOW = 1_800_000_000
	type HostOpts = {
		lastPrune: number | null
		/** when a prune last held the slots (the 1h gate); none by default. */
		lastAttempt?: number
		rootPct?: number
		busyWaitSec?: number
		bodyTimeoutSec?: number
		slowImagePrune?: boolean
		psBusyFrom?: number
		/** the docker process ps shows from psBusyFrom on (default a pull). */
		psLine?: string
		/** the attempt file cannot be written (it is a dir). */
		attemptUnwritable?: boolean
	}
	function host(name: string, cacheGb: number, o: HostOpts) {
		const dir = join(root, `p-${name}`)
		const pbin = join(dir, 'bin')
		mkdirSync(pbin, { recursive: true })
		const log = join(dir, 'docker.log')
		const slot0 = join(dir, 'slot.0')
		writeFileSync(
			join(pbin, 'docker'),
			`#!/bin/bash\necho "$*" >> ${JSON.stringify(log)}\n` +
				// whether slot 0 is held while the image prune runs (by the prune).
				`[ "$*" = "image prune -f" ] && { flock -n ${JSON.stringify(slot0)} true && echo slot0=free || echo slot0=held; } >> ${JSON.stringify(log)}\n` +
				`[ "$*" = "image prune -f" ] && echo "Total reclaimed space: 1.5GB"\n` +
				(o.slowImagePrune ? `case "$*" in *prune*) exec sleep 31.5;; esac\n` : '') +
				`[ "$*" = "buildx du" ] && printf 'Total:\\t\\t${cacheGb}GB\\n'\nexit 0\n`,
		)
		// psBusyFrom: from the Nth ps call on, an image pull is in progress.
		const psCount = join(dir, 'ps.count')
		writeFileSync(
			join(pbin, 'ps'),
			o.psBusyFrom === undefined
				? '#!/bin/bash\nexit 0\n'
				: `#!/bin/bash\nn=$(( $(cat ${JSON.stringify(psCount)} 2>/dev/null || echo 0) + 1 )); echo $n > ${JSON.stringify(psCount)}\n[ "$n" -ge ${o.psBusyFrom} ] && echo "  12 ${o.psLine ?? 'docker pull node:22'}"\nexit 0\n`,
		)
		writeFileSync(join(pbin, 'date'), `#!/bin/bash\necho ${NOW}\n`)
		writeFileSync(join(pbin, 'df'), `#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 300 150 150 ${o.rootPct ?? 61}%% /\\n"\n`)
		for (const f of ['docker', 'ps', 'date', 'df']) chmodSync(join(pbin, f), 0o755)
		writeFileSync(log, '')
		if (o.lastPrune !== null) {
			mkdirSync(join(dir, 'state'), { recursive: true })
			writeFileSync(join(dir, 'state', 'last'), `${o.lastPrune}\n`)
		}
		if (o.attemptUnwritable) {
			mkdirSync(join(dir, 'state', 'builder-prune.attempt'), { recursive: true })
		}
		if (o.lastAttempt !== undefined) {
			mkdirSync(join(dir, 'state'), { recursive: true })
			writeFileSync(join(dir, 'state', 'builder-prune.attempt'), `${o.lastAttempt}\n`)
		}
		const sh = builderCapPruneShell({
			capGb: 30,
			buildsRoot: join(dir, 'builds'),
			busyWaitSec: o.busyWaitSec ?? 1,
			pullWaitSec: 0,
			bodyTimeoutSec: o.bodyTimeoutSec ?? 900,
			lockPath: join(dir, 'prune.lock'),
			slotLockPrefix: join(dir, 'slot.'),
			stateFile: join(dir, 'state', 'last'),
		})
		const run = () => {
			// this run's calls only (a host may run twice; a build may log before).
			const from = readFileSync(log, 'utf8').replace(/build-done\n/g, '').length
			const t0 = Date.now()
			const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: { ...process.env, PATH: `${pbin}:${process.env.PATH}` } })
			const p = parseBuilderPruneResult(r.stdout)
			return { out: r.stdout, ms: Date.now() - t0, p, calls: readFileSync(log, 'utf8').slice(from), state: readFileSync(join(dir, 'state', 'last'), 'utf8').trim() }
		}
		const attempt = () => readFileSync(join(dir, 'state', 'builder-prune.attempt'), 'utf8').trim()
		/** run while a build holds slot 0 for `sec` seconds (a real flock); the
		 *  build logs `build-done` as it ends. */
		const runBusy = (sec = 10) => {
			const hold = spawn('flock', [slot0, 'sh', '-c', `sleep ${sec}; echo build-done >> ${JSON.stringify(log)}`], { stdio: 'ignore' })
			hold.on('error', () => {})
			try {
				spawnSync('bash', ['-c', `for i in $(seq 50); do flock -n ${JSON.stringify(slot0)} true || exit 0; sleep 0.1; done`])
				return run()
			} finally {
				hold.kill()
			}
		}
		const slotFree = () => spawnSync('flock', ['-n', slot0, 'true']).status === 0
		/** forget the last prune that held the slots (the 1h gate). */
		const clearGate = () => rmSync(join(dir, 'state', 'builder-prune.attempt'), { force: true })
		return { run, runBusy, slotFree, attempt, clearGate }
	}

	it.skipIf(!HAS_FLOCK)('a run skipped because builds held the slots posts no card', () => {
		const h = host('busy', 65, { lastPrune: NOW - 3600 })
		const r = h.runBusy()
		expect(r.calls).not.toContain('prune')
		expect(r.out).toContain('[builder-prune] builds held the build slots')
		expect(r.p).toEqual({ cacheMb: 65000, capMb: 30000, rootPct: 61, pruned: false, skip: 'locked', lastPruneAgeSec: 3600, beforeMb: 65000, stuckPrunes: 0 })
		expect(r.p && builderPruneVerdict(r.p)).toEqual({ post: false })
		expect(r.state).toBe(String(NOW - 3600))
		// the slot wait may have held slot 0 meanwhile: a short gate (15 min).
		expect(h.attempt()).toBe(String(NOW - 2700))
		expect(h.run().p).toMatchObject({ pruned: false, skip: 'recent' })
		const due = host('busy-due', 65, { lastPrune: NOW - 3600, lastAttempt: NOW - 900 - 2700 }).run()
		expect(due.p).toMatchObject({ pruned: true, skip: null })
	})
	it.skipIf(!HAS_FLOCK)('a skipped run whose last real prune is 6h+ old warns that the cache is not pruned', () => {
		const r = host('stale', 65, { lastPrune: NOW - 7 * 3600 }).runBusy()
		expect(r.p?.lastPruneAgeSec).toBe(7 * 3600)
		expect(r.p && builderPruneVerdict(r.p)).toEqual({
			post: true,
			afterPrune: false,
			problem: 'the build cache has not been pruned for 7h because builds never paused; cache 65 GB, cap 30 GB',
		})
		expect(r.p && builderPruneLogLine('5.6.7.8', r.p)).toBe('[builder-prune] 5.6.7.8: cache 65000 MB (found 65000 MB) cap 30000 MB root 61% pruned=0 skip=locked last_prune_age=25200s stuck=0')
	})
	it.skipIf(!HAS_FLOCK)('a host never pruned starts its clock at the first run', () => {
		const r = host('fresh', 65, { lastPrune: null }).runBusy()
		expect(r.p).toMatchObject({ pruned: false, skip: 'locked', lastPruneAgeSec: 0 })
		expect(r.state).toBe(String(NOW))
	})
	it.skipIf(!HAS_FLOCK)('a slot freed during the wait: the prune runs', () => {
		const h = host('freed', 65, { lastPrune: NOW - 7 * 3600, busyWaitSec: 8 })
		const r = h.runBusy(1)
		expect(r.calls).toContain('image prune -f')
		expect(r.p).toMatchObject({ pruned: true, skip: null, lastPruneAgeSec: 0 })
	})
	it.skipIf(!HAS_FLOCK)('a prune that leaves the cache over the cap at the same size each time is no risk: resolves', () => {
		const h = host('over', 65, { lastPrune: NOW - 7 * 3600 })
		const r = h.run()
		expect(r.calls).toContain('builder prune -af --max-used-space 30GB')
		expect(r.calls).toContain('until=1h')
		expect(r.state).toBe(String(NOW))
		expect(r.p).toMatchObject({ pruned: true, lastPruneAgeSec: 0, beforeMb: 65000, stuckPrunes: 0 })
		// over the soft cap with the root disk healthy: resolves.
		expect(r.p && builderPruneVerdict(r.p)).toEqual({ post: true, afterPrune: true, problem: null })
		expect(h.run().p).toMatchObject({ skip: 'recent', stuckPrunes: 0 })
		for (let i = 0; i < 3; i++) {
			h.clearGate()
			const again = h.run()
			expect(again.p).toMatchObject({ pruned: true, stuckPrunes: 0 })
			expect(again.p && builderPruneVerdict(again.p)).toEqual({ post: true, afterPrune: true, problem: null })
		}
	})
	it.skipIf(!HAS_FLOCK)('under the cap: no slot taken, no prune, and the card resolves', () => {
		const h = host('under', 12, { lastPrune: NOW - 60 })
		const r = h.runBusy()
		expect(r.calls).toBe('buildx du\n')
		expect(r.ms).toBeLessThan(5000)
		expect(r.p).toMatchObject({ pruned: true, skip: null })
		expect(r.p && builderPruneVerdict(r.p)).toEqual({ post: true, afterPrune: true, problem: null })
		expect(r.state).toBe(String(NOW))
	})
	it.skipIf(!HAS_FLOCK)('over the cap but pruned under 1h ago: no slot taken, no card', () => {
		const r = host('recent', 40, { lastPrune: NOW - 600, lastAttempt: NOW - 600 }).run()
		expect(r.calls).not.toContain('prune')
		expect(r.out).toContain('a prune took the build slots 600s ago')
		expect(r.p).toMatchObject({ pruned: false, skip: 'recent', lastPruneAgeSec: 600 })
		expect(r.p && builderPruneVerdict(r.p)).toEqual({ post: false })
	})
	it.skipIf(!HAS_FLOCK)('the 1h gate holds over twice the cap and with the root disk at 75%, not at 85%', () => {
		const far = host('recent-2x', 65, { lastPrune: NOW - 600, lastAttempt: NOW - 600 }).run()
		expect(far.calls).not.toContain('prune')
		expect(far.p).toMatchObject({ pruned: false, skip: 'recent' })
		expect(far.p && builderPruneVerdict(far.p)).toEqual({ post: false })
		const warn = host('recent-root', 12, { lastPrune: NOW - 600, lastAttempt: NOW - 600, rootPct: 80 }).run()
		expect(warn.calls).not.toContain('prune')
		expect(warn.p).toMatchObject({ pruned: false, skip: 'recent', rootPct: 80 })
		// 75% already warns, but never as an "after the prune" verdict.
		expect(warn.p && builderPruneVerdict(warn.p)).toEqual({ post: true, afterPrune: false, problem: 'root disk 80% full' })
		// from 85% (about an hour from full) the prune skips the gate.
		const full = host('full-root', 12, { lastPrune: NOW - 600, lastAttempt: NOW - 600, rootPct: 90 }).run()
		expect(full.calls).toContain('image prune -f')
		expect(full.p).toMatchObject({ pruned: true, skip: null, rootPct: 90 })
		expect(full.p && builderPruneVerdict(full.p)).toEqual({ post: true, afterPrune: true, problem: 'root disk 90% full' })
		// but still never while a pull runs.
		const pulling = host('full-root-pull', 12, { lastPrune: NOW - 600, lastAttempt: NOW - 600, rootPct: 90, psBusyFrom: 1 }).run()
		expect(pulling.calls).not.toContain('prune')
		expect(pulling.p).toMatchObject({ pruned: false, skip: 'busy' })
		// under the cap at 75%: the prune runs (no gate) and the card warns.
		const due = host('due-root', 12, { lastPrune: NOW - 600, lastAttempt: NOW - 3600, rootPct: 76 }).run()
		expect(due.calls).toContain('image prune -f')
		expect(due.p).toMatchObject({ pruned: true, skip: null })
		expect(due.p && builderPruneVerdict(due.p)).toEqual({ post: true, afterPrune: true, problem: 'root disk 76% full' })
		const ok = host('ok-root', 12, { lastPrune: NOW - 600, rootPct: 74 }).run()
		expect(ok.calls).not.toContain('prune')
		expect(ok.p && builderPruneVerdict(ok.p)).toEqual({ post: true, afterPrune: true, problem: null })
	})
	it.skipIf(!HAS_FLOCK)('a prune that held the slots gates the next run for 1h, done or failed', () => {
		const h = host('gate', 65, { lastPrune: NOW - 7 * 3600 })
		expect(h.run().p).toMatchObject({ pruned: true })
		expect(h.attempt()).toBe(String(NOW))
		const again = h.run()
		expect(again.calls).not.toContain('prune')
		expect(again.p).toMatchObject({ pruned: false, skip: 'recent', lastPruneAgeSec: 0 })
		const slow = host('gate-failed', 65, { lastPrune: NOW - 7 * 3600, bodyTimeoutSec: 2, slowImagePrune: true })
		expect(slow.run().p).toMatchObject({ skip: 'failed' })
		expect(slow.attempt()).toBe(String(NOW))
		expect(slow.run().p).toMatchObject({ skip: 'recent' })
	})
	it.skipIf(!HAS_FLOCK)('a docker build in ps does not block the prune: it waits for the slot and prunes holding it', () => {
		const r = host('build-ps', 65, { lastPrune: NOW - 7 * 3600, busyWaitSec: 8, psBusyFrom: 1, psLine: 'docker build -t demoapp:latest-b42 --pull .' }).runBusy(1)
		expect(r.p).toMatchObject({ pruned: true, skip: null })
		// the build ended before the prune began, and the prune held slot 0.
		expect(r.calls.indexOf('build-done')).toBeGreaterThanOrEqual(0)
		expect(r.calls.indexOf('build-done')).toBeLessThan(r.calls.indexOf('image prune -f'))
		expect(r.calls).toContain('slot0=held')
		// the reclaimed total docker printed is logged.
		expect(r.out).toContain('[builder-prune] docker image prune -f: Total reclaimed space: 1.5GB')
	})
	it('the pull guard matches pulls, loads and imports, never builds or runs', () => {
		const re = new RegExp(IMAGE_PULL_ERE)
		for (const a of ['docker pull node:22', 'docker image pull x', 'docker load -i a.tar', 'docker image import a.tar', '/usr/bin/docker compose -f a.yml pull', 'docker-compose pull app'])
			expect(a).toMatch(re)
		for (const a of ['docker build --pull -t x .', 'docker buildx build --load -t x .', 'docker compose build --pull', 'docker run --rm x', 'docker compose up -d'])
			expect(a).not.toMatch(re)
	})
	it('powder waits longer for the prune than its worst case', () => {
		expect(builderCapPruneWorstSec()).toBe(BUILDER_PRUNE_DEFAULTS.pullWaitSec + BUILDER_PRUNE_DEFAULTS.busyWaitSec + BUILDER_PRUNE_DEFAULTS.bodyTimeoutSec + 250)
		expect(builderCapPruneWorstSec()).toBeLessThan(BUILDER_PRUNE_RUN_TIMEOUT_SEC)
	})
	it.skipIf(!HAS_FLOCK)('an image pull in progress skips the prune, before or after the slots are taken', () => {
		// ps call 1: the check before the slots; 2: the re-check holding them.
		for (const [name, from] of [
			['pull-before', 1],
			['pull-after', 2],
		] as const) {
			const r = host(name, 65, { lastPrune: NOW - 7 * 3600, psBusyFrom: from }).run()
			expect(r.calls).not.toContain('prune')
			expect(r.p).toMatchObject({ pruned: false, skip: 'busy' })
			expect(r.p && builderPruneVerdict(r.p)).toMatchObject({ problem: expect.stringContaining('because an image pull was in progress every time') })
		}
	})
	it.skipIf(!HAS_FLOCK)('a pull seen while holding the slots gates the next run for 1h; one seen before them does not', () => {
		const after = host('pull-after-gate', 65, { lastPrune: NOW - 7 * 3600, psBusyFrom: 2 })
		expect(after.run().p).toMatchObject({ pruned: false, skip: 'busy' })
		expect(after.attempt()).toBe(String(NOW))
		expect(after.run().p).toMatchObject({ pruned: false, skip: 'recent' })
		// ps call 3: the age loop, after the image and cap prunes ran.
		const mid = host('pull-mid-loop', 500, { lastPrune: NOW - 7 * 3600, psBusyFrom: 3 })
		const r = mid.run()
		expect(r.calls).toContain('image prune -f')
		expect(r.calls).not.toContain('until=')
		expect(r.out).toContain('age prune stopped')
		expect(r.p).toMatchObject({ pruned: false, skip: 'busy' })
		expect(mid.attempt()).toBe(String(NOW))
		expect(mid.run().p).toMatchObject({ skip: 'recent' })
		const before = host('pull-before-nogate', 65, { lastPrune: NOW - 7 * 3600, psBusyFrom: 1 })
		expect(before.run().p).toMatchObject({ skip: 'busy' })
		expect(() => before.attempt()).toThrow()
	})
	it.skipIf(!HAS_FLOCK)('an unwritable attempt file is said in the output', () => {
		const r = host('attempt-ro', 65, { lastPrune: NOW - 7 * 3600, attemptUnwritable: true }).run()
		expect(r.p).toMatchObject({ pruned: true })
		expect(r.out).toContain('builder-prune.attempt is not writable: the prune runs after every build')
	})
	it.skipIf(!HAS_FLOCK)('a prune over its time limit is killed, frees the slots and says it failed', () => {
		const h = host('slow', 65, { lastPrune: NOW - 7 * 3600, bodyTimeoutSec: 2, slowImagePrune: true })
		const r = h.run()
		expect(r.ms).toBeLessThan(15000)
		expect(r.out).toContain('the prune failed or timed out (exit 124)')
		expect(r.p).toMatchObject({ pruned: false, skip: 'failed', lastPruneAgeSec: 7 * 3600 })
		expect(h.slotFree()).toBe(true)
		// the killed docker call is gone too (polled: it may take a moment to be reaped).
		expect(spawnSync('bash', ['-c', 'for i in $(seq 30); do pgrep -f "^sleep 31.5" >/dev/null || exit 0; sleep 0.1; done; exit 1']).status).toBe(0)
		expect(r.p && builderPruneVerdict(r.p)).toMatchObject({ problem: expect.stringContaining('because the prune keeps failing or timing out') })
	})
	it('a skipped run with the root disk 75% full still warns', () => {
		const p = { cacheMb: 1000, capMb: 30000, rootPct: 90, pruned: false, skip: 'locked' as const, lastPruneAgeSec: 60, beforeMb: 1000, stuckPrunes: 0 }
		expect(builderPruneVerdict(p)).toEqual({ post: true, afterPrune: false, problem: 'root disk 90% full' })
		expect(builderPruneVerdict({ ...p, rootPct: 50, lastPruneAgeSec: BUILDER_PRUNE_STALE_SEC - 1 })).toEqual({ post: false })
	})
	it('the old marker parses as a prune that ran, last prune age unknown', () => {
		const p = parseBuilderPruneResult('POWDER_BUILDER_PRUNE cache_mb=90000 cap_mb=30000 root_pct=60\n')
		expect(p).toEqual({ cacheMb: 90000, capMb: 30000, rootPct: 60, pruned: true, skip: null, lastPruneAgeSec: null, beforeMb: null, stuckPrunes: 0 })
		// over the soft cap, no stuck prunes known, root disk healthy: no risk.
		expect(p && builderPruneVerdict(p)).toEqual({ post: true, afterPrune: true, problem: null })
		expect(parseBuilderPruneResult('POWDER_BUILDER_PRUNE cache_mb=1 cap_mb=30000 root_pct=60 pruned=1 last_prune_age_s=-1\n')?.lastPruneAgeSec).toBeNull()
		expect(parseBuilderPruneResult('POWDER_BUILDER_PRUNE cache_mb=1 cap_mb=30000 root_pct=60 pruned=0 skip=busy last_prune_age_s=5\n')?.skip).toBe('busy')
	})
	it('a prune that shrank the cache, still over the soft cap, root disk 29%: resolves', () => {
		const p = parseBuilderPruneResult('POWDER_BUILDER_PRUNE cache_mb=62890 cap_mb=30000 root_pct=29 pruned=1 skip=none last_prune_age_s=0 before_mb=72160 stuck=0\n')
		expect(p).toEqual({ cacheMb: 62890, capMb: 30000, rootPct: 29, pruned: true, skip: null, lastPruneAgeSec: 0, beforeMb: 72160, stuckPrunes: 0 })
		expect(p && builderPruneVerdict(p)).toEqual({ post: true, afterPrune: true, problem: null })
		// 22:45: 100 GB, root 42%, gated (skip=recent): no card either way.
		const gated = parseBuilderPruneResult('POWDER_BUILDER_PRUNE cache_mb=100600 cap_mb=30000 root_pct=42 pruned=0 skip=recent last_prune_age_s=3600 before_mb=100600 stuck=0\n')
		expect(gated && builderPruneVerdict(gated)).toEqual({ post: false })
	})
	it('real risk after a prune: root disk at 75%, or the cache larger after each of 3 prunes in a row', () => {
		const full = parseBuilderPruneResult('POWDER_BUILDER_PRUNE cache_mb=62890 cap_mb=30000 root_pct=88 pruned=1 skip=none last_prune_age_s=0 before_mb=72160 stuck=0\n')
		expect(full && builderPruneVerdict(full)).toEqual({ post: true, afterPrune: true, problem: 'root disk 88% full' })
		const stuck = parseBuilderPruneResult('POWDER_BUILDER_PRUNE cache_mb=140000 cap_mb=30000 root_pct=55 pruned=1 skip=none last_prune_age_s=0 before_mb=135000 stuck=3\n')
		expect(stuck && builderPruneVerdict(stuck)).toEqual({
			post: true,
			afterPrune: true,
			problem: 'build cache 140 GB over the 30 GB cap and larger after each of 3 prunes in a row',
		})
		// two growing prunes are not yet a trend.
		expect(stuck && builderPruneVerdict({ ...stuck, stuckPrunes: 2 })).toEqual({ post: true, afterPrune: true, problem: null })
	})
})
