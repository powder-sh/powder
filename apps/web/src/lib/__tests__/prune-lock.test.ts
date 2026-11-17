import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
	IMAGE_ACTIVITY_ERE,
	IMAGE_BUSY_CHECK,
	PRUNE_LOCK_PATH,
	lockedPruneShell,
} from '../deploy/prune-lock'
import { buildDeployScript } from '../deploy/script'
import { pathWithout } from './hermetic'

// system tools only (no node_modules/.bin, no host extras)
const SYS_PATH = pathWithout([])

// Post-deploy and preflight prunes must take the hourly powder-image-prune lock
// and never run `docker image prune` while an image pull/build is in progress
// (a deploy's cleanup could delete another app's half-unpacked smoke-test image). The hourly script itself carries the same busy check.

const root = mkdtempSync(join(tmpdir(), 'prune-lock-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const HOURLY = join(__dirname, '../../../../../infra/powder-image-prune.sh')

function stubBin(name: string, body: string, dir: string) {
	writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`)
	chmodSync(join(dir, name), 0o755)
}

/** Run the guard with stubbed docker/ps/flock/sleep; returns stdout + the calls in order. */
function run(opts: {
	psOut: string
	flockRc: number
	busyWaitSec?: number
	restOnLockTimeout?: boolean
}) {
	const dir = mkdtempSync(join(root, 'case-'))
	const bin = join(dir, 'bin')
	mkdirSync(bin)
	const log = join(dir, 'calls.log')
	writeFileSync(log, '')
	stubBin('docker', `echo "docker $*" >> ${JSON.stringify(log)}`, bin)
	stubBin(
		'ps',
		`echo "ps $*" >> ${JSON.stringify(log)}; printf '%s' ${JSON.stringify(opts.psOut)}`,
		bin,
	)
	stubBin('flock', `echo "flock $*" >> ${JSON.stringify(log)}; exit ${opts.flockRc}`, bin)
	stubBin('sleep', `echo "sleep $*" >> ${JSON.stringify(log)}`, bin)
	const frag = lockedPruneShell({
		label: '[t]',
		lockWaitSec: 60,
		busyWaitSec: opts.busyWaitSec ?? 10,
		imagePrune: 'docker image prune -f',
		rest: ['docker builder prune -f'],
		...(opts.restOnLockTimeout ? { restOnLockTimeout: true } : {}),
	})
	// Embedded like the deploy script: set -euo pipefail, fd 9 held, inside an && chain.
	// The /run lock is root-only: the test takes the same lock at a path of its own.
	const script = `set -euo pipefail; exec 9>${JSON.stringify(join(dir, 'app.lock'))}; if true; then ${frag.replaceAll(PRUNE_LOCK_PATH, join(dir, 'prune.lock'))}; fi && echo chain-ok`
	const r = spawnSync('bash', ['-c', script], {
		env: { ...process.env, PATH: `${bin}:${SYS_PATH}` },
		encoding: 'utf8',
	})
	return { out: r.stdout, rc: r.status, calls: readFileSync(log, 'utf8') }
}

describe('lockedPruneShell', () => {
	it('uses the exact lock infra/powder-image-prune.sh takes', () => {
		const sh = readFileSync(HOURLY, 'utf8')
		expect(sh).toContain(`exec 9>${PRUNE_LOCK_PATH}`)
		expect(PRUNE_LOCK_PATH.startsWith('/run/')).toBe(true)
	})

	it('the hourly script gates its image prune on the same busy check', () => {
		const sh = readFileSync(HOURLY, 'utf8')
		expect(sh).toContain(`image_busy() { ${IMAGE_BUSY_CHECK}; }`)
		const prune = sh.indexOf('docker image prune -f')
		expect(sh.lastIndexOf('if image_busy; then', prune)).toBeGreaterThan(-1)
	})

	it('idle server: takes the lock, then prunes images and build cache', () => {
		const { out, rc, calls } = run({ psOut: '  12 docker ps -a\n', flockRc: 0 })
		expect(calls).toMatch(/^flock -w 60 7$/m)
		expect(calls).toContain('ps -C docker,docker-compose,docker-buildx -o etimes=,args=')
		expect(calls).toContain('docker image prune -f')
		expect(calls).toContain('docker builder prune -f')
		expect(calls.indexOf('flock')).toBeLessThan(calls.indexOf('docker image prune'))
		expect(calls).not.toContain('sleep')
		expect(out).toContain('chain-ok')
		expect(rc).toBe(0)
	})

	it('pull in progress: waits without the lock, then skips only the image prune', () => {
		const { out, rc, calls } = run({
			psOut: '  40 docker pull -q node:22-alpine\n',
			flockRc: 0,
			busyWaitSec: 10,
		})
		expect(calls).not.toContain('docker image prune')
		expect(calls).toContain('docker builder prune -f')
		expect(calls.match(/^sleep 5$/gm)?.length).toBe(2)
		// the lock is taken only after the wait, so the hourly prune is not blocked by it
		expect(calls.lastIndexOf('sleep 5')).toBeLessThan(calls.indexOf('flock'))
		expect(out).toContain('dangling-image prune skipped')
		expect(out).toContain('chain-ok')
		expect(rc).toBe(0)
	})

	it('a matching process older than the max age does not count as busy', () => {
		const { calls } = run({ psOut: ' 7200 docker run --rm backup-job\n', flockRc: 0 })
		expect(calls).toContain('docker image prune -f')
		expect(calls).not.toContain('sleep')
	})

	it('another prune holds the lock past the wait: runs nothing', () => {
		const { out, rc, calls } = run({ psOut: '', flockRc: 1 })
		expect(calls).not.toContain('docker ')
		expect(out).toContain('another image prune still running')
		expect(out).toContain('chain-ok')
		expect(rc).toBe(0)
	})

	it('restOnLockTimeout: a lock timeout still reclaims build cache, not images', () => {
		const { out, calls } = run({ psOut: '', flockRc: 1, restOnLockTimeout: true })
		expect(calls).toContain('docker builder prune -f')
		expect(calls).not.toContain('docker image prune')
		expect(out).toContain('only build cache reclaimed')
	})

	it('flags pulls, builds and image-starting commands, not the rest', () => {
		const busy = [
			'docker pull -q node:22-alpine',
			'docker run --rm --env-file /x.env node:22-alpine node probe.js',
			'docker image pull ghcr.io/x/y:1',
			'docker compose -f /opt/apps/a/docker-compose.yml up -d --force-recreate app',
			'/usr/libexec/docker/cli-plugins/docker-compose compose pull',
			'docker compose build app',
			'/usr/libexec/docker/cli-plugins/docker-buildx buildx build -t a .',
			'docker build -t a .',
			'docker-compose up -d',
			'docker load -i img.tar',
		]
		const idle = [
			'docker ps -a',
			'docker exec shop-db psql -U app -c select 1',
			'docker logs -f app',
			'docker image prune -f',
			'docker builder prune -f',
			'docker images --format x',
			'docker inspect app',
		]
		// awk is what runs on the servers (gawk/mawk/BSD); grep -E is the ERE reference
		const grep = (line: string) =>
			spawnSync('grep', ['-Eq', IMAGE_ACTIVITY_ERE], { input: `${line}\n` }).status
		const awk = (line: string) =>
			spawnSync('awk', ['-v', `re=${IMAGE_ACTIVITY_ERE}`, '$0 ~ re { f = 1 } END { exit !f }'], {
				input: `${line}\n`,
			}).status
		for (const l of busy) expect([l, grep(l), awk(l)]).toEqual([l, 0, 0])
		for (const l of idle) expect([l, grep(l), awk(l)]).toEqual([l, 1, 1])
	})

	it('the deploy and self-deploy preflight prunes go through the guard', () => {
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
		expect(s).toContain(PRUNE_LOCK_PATH)
		// every `docker image prune` in the generated script sits behind the busy check
		const n = s.split('docker image prune').length - 1
		expect(n).toBeGreaterThan(0)
		expect(s.split('else docker image prune').length - 1).toBe(n)
		for (const f of ['../deploy/self-deploy.ts', '../deploy-runner.ts']) {
			const src = readFileSync(join(__dirname, f), 'utf8')
			expect(src).toContain('lockedPruneShell({')
			expect(src.split('docker image prune').length - 1).toBe(
				src.split("imagePrune: 'docker image prune").length - 1,
			)
		}
	})
})
