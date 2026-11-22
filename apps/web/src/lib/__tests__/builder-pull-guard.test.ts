// The build host's cap prune must never overlap an image pull of a builder
// script: dockerd then fails the pull ("failed to lease content: NotFound:
// lease ... not found") and the test gate refuses as if the registry were down.
// The script's own `docker pull` holds the pull lock shared (the prune takes it
// exclusively) and a failed pull is tried once more.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DFR_PROV_FN } from '../build-cache'
import { buildBuilderScript } from '../builder'
import { BUILDER_PULL_LOCK_WAIT_SEC, builderCapPruneShell, builderPullGuardFunctions } from '../builder-prune'
import { testGateShell } from '../deploy/fragments'
import { gitHardenShellFunctions } from '../git-harden'
import { pathWithout } from './hermetic'

const root = mkdtempSync(join(tmpdir(), 'bpg-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A dir with a stub docker (fails its first `failFirst` pulls) and a stub flock
 *  that logs its arguments and runs the command (`flock: 'broken'` runs nothing). */
function box(name: string, o: { failFirst?: number; flock?: 'ok' | 'broken' | 'none' } = {}) {
	const dir = join(root, name)
	mkdirSync(dir, { recursive: true })
	const log = join(dir, 'calls.log')
	writeFileSync(log, '')
	writeFileSync(join(dir, 'fails'), String(o.failFirst ?? 0))
	writeFileSync(
		join(dir, 'docker'),
		`#!/bin/bash\necho "docker $*" >> ${JSON.stringify(log)}\n` +
			`if [ "$1" = pull ]; then n=$(cat ${JSON.stringify(join(dir, 'fails'))}); if [ "$n" -gt 0 ]; then echo $((n-1)) > ${JSON.stringify(join(dir, 'fails'))}; exit 1; fi; fi\n` +
			`if [ "$1 $2" = "image inspect" ]; then case "$*" in *RepoDigests*) echo 'docker.io/library/node@sha256:${'c'.repeat(64)}'; echo;; *) echo '{}';; esac; fi\nexit 0\n`,
	)
	chmodSync(join(dir, 'docker'), 0o755)
	if (o.flock !== 'none') {
		writeFileSync(
			join(dir, 'flock'),
			o.flock === 'broken'
				? `#!/bin/bash\necho "flock $*" >> ${JSON.stringify(log)}\nexit 1\n`
				: `#!/bin/bash\necho "flock $*" >> ${JSON.stringify(log)}\nwhile [ $# -gt 0 ]; do case "$1" in -w|-E) shift 2;; -*) shift;; *) shift; break;; esac; done\nexec "$@"\n`,
		)
		chmodSync(join(dir, 'flock'), 0o755)
	}
	// a stub `timeout` that logs and runs the command (macOS has none).
	writeFileSync(join(dir, 'timeout'), `#!/bin/bash\necho "timeout $*" >> ${JSON.stringify(log)}\nshift\nexec "$@"\n`)
	chmodSync(join(dir, 'timeout'), 0o755)
	const lock = join(dir, 'pull.lock')
	const run = (script: string, guard = true) => {
		const r = spawnSync('bash', ['-c', `set -e; ${guard ? builderPullGuardFunctions(lock, 0) : ''}${script}`], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${pathWithout(['docker', 'flock'])}` } })
		return { code: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
	}
	return { dir, lock, run }
}

describe('builder pull guard', () => {
	it('a pull holds the pull lock shared; every other docker call passes through', () => {
		const b = box('ok')
		const r = b.run('docker image inspect x >/dev/null; docker pull node:22-alpine; docker run --rm x')
		expect(r.code, r.out).toBe(0)
		expect(r.calls).toEqual(['docker image inspect x', `flock -s -w ${BUILDER_PULL_LOCK_WAIT_SEC} ${b.lock} docker pull node:22-alpine`, 'docker pull node:22-alpine', 'docker run --rm x'])
	})

	it('a pull that fails under the lock is tried once more', () => {
		const b = box('retry', { failFirst: 1 })
		const r = b.run('if docker pull node:22-alpine >/dev/null 2>&1; then echo pulled; else echo refused; fi')
		expect(r.out).toContain('pulled')
		expect(r.calls.filter((c) => c === 'docker pull node:22-alpine').length).toBe(2)
	})

	it('a pull that fails twice fails, with the exit code of docker', () => {
		const b = box('twice', { failFirst: 2 })
		const r = b.run('docker pull node:22-alpine || echo "rc=$?"')
		expect(r.out).toContain('rc=1')
		expect(r.calls.filter((c) => c === 'docker pull node:22-alpine').length).toBe(2)
	})

	it('a lock that cannot be taken, or no flock at all, never fails a pull', () => {
		for (const flock of ['broken', 'none'] as const) {
			const b = box(`flock-${flock}`, { flock })
			const r = b.run('docker pull node:22-alpine && echo pulled')
			expect(r.out, flock).toContain('pulled')
			expect(r.calls.filter((c) => c === 'docker pull node:22-alpine').length, flock).toBe(1)
		}
	})

	it("the test gate's image pull goes through the guard", () => {
		const b = box('gate')
		const ctx = join(b.dir, 'ctx')
		mkdirSync(join(ctx, '.powder'), { recursive: true })
		writeFileSync(join(ctx, '.powder/test.sh'), 'exit 0\n')
		const r = b.run(`${gitHardenShellFunctions()}${testGateShell({ dir: `'${ctx}'`, label: 'l', run: '', tag: '[tg]', app: 'x' })}`)
		expect(r.calls.join('\n'), r.out).toContain(`flock -s -w ${BUILDER_PULL_LOCK_WAIT_SEC} ${b.lock} docker pull node:22-alpine`)
	})

	// the Dockerfile check's base image pulls run under `timeout 300`: a shell function
	// is not something timeout can run, so they reach the guard through dfr_pull.
	it("the Dockerfile check's base image pull holds the lock too, under its time limit", () => {
		const b = box('base')
		const r = b.run(`${DFR_PROV_FN}__pvt="timeout 300"; dfr_pull -q -- node:22-alpine </dev/null`)
		expect(r.code, r.out).toBe(0)
		expect(r.calls).toEqual([`flock -s -w ${BUILDER_PULL_LOCK_WAIT_SEC} ${b.lock} timeout 300 docker pull -q -- node:22-alpine`, 'timeout 300 docker pull -q -- node:22-alpine', 'docker pull -q -- node:22-alpine'])
	})

	it('a base image pull that fails is tried once more, still under its time limit', () => {
		const b = box('base-retry', { failFirst: 1 })
		const r = b.run(`${DFR_PROV_FN}__pvt="timeout 300"; dfr_pull -q -- node:22-alpine && echo pulled`)
		expect(r.out).toContain('pulled')
		expect(r.calls.filter((c) => c === 'timeout 300 docker pull -q -- node:22-alpine').length).toBe(2)
	})

	it('outside a builder script (a local build on the app server) the base image pull is as before', () => {
		const b = box('base-local')
		const r = b.run(`${DFR_PROV_FN}__pvt="timeout 300"; dfr_pull -q -- node:22-alpine; __pvt=""; dfr_pull -q -- node:22-alpine`, false)
		expect(r.code, r.out).toBe(0)
		expect(r.calls).toEqual(['timeout 300 docker pull -q -- node:22-alpine', 'docker pull -q -- node:22-alpine', 'docker pull -q -- node:22-alpine'])
	})

	it('every docker pull of the Dockerfile check goes through dfr_pull', () => {
		expect(DFR_PROV_FN.match(/docker pull/g)?.length).toBe(2) // both inside dfr_pull itself
		expect(DFR_PROV_FN.match(/dfr_pull -/g)?.length).toBe(2)
	})

	it('the builder script defines the guard before anything pulls, and parses', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/x-demoapp',
			repoUrl: 'git@github.com:example-org/demoapp.git',
			branch: 'main',
			sha: null,
			keyPath: '/tmp/k',
			image: 'demoapp:latest',
			uniq: 'demoapp:latest-b1',
			ctx: '/opt/builds/x-demoapp/src',
			df: '/opt/builds/x-demoapp/src/Dockerfile',
			buildArgs: '',
		})
		const guard = builderPullGuardFunctions()
		expect(s).toContain(guard)
		expect(s.indexOf(guard)).toBeLessThan(s.indexOf('docker pull'))
		expect(spawnSync('bash', ['-n', '-c', s], { encoding: 'utf8' }).stderr).toBe('')
	})

	it('the guard and the prune name the same lock', () => {
		const word = builderPullGuardFunctions().match(/^__PULL_LOCK=("\$\(.*?\)"); /)?.[1] ?? ''
		expect(word).toContain('/run/powder-builder-pull.lock')
		expect(builderCapPruneShell()).toContain(`-E 215 ${word.replace('[builder-pull]', '[builder-prune]')} timeout`)
	})
})
