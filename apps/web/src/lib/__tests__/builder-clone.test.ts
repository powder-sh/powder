import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builderCloneShell } from '../builder'

// Runs the generated clone shell under bash with a stub git that fails the first
// FAILS attempts with MSG (exit 128) and a stub sleep that records the backoff.
function run(o: { fails: number; msg?: string; rc?: number; sha?: string | null }) {
	const d = mkdtempSync(join(tmpdir(), 'powder-clone-'))
	const bin = join(d, 'bin')
	mkdirSync(bin)
	writeFileSync(join(d, 'n'), '0')
	writeFileSync(join(d, 'log'), '')
	writeFileSync(
		join(bin, 'git'),
		`#!/bin/bash\necho "git $*" >> "${d}/log"\nisclone=0; case " $* " in *" clone "*) isclone=1;; esac\nif [ "$isclone" = 1 ]; then for a in "$@"; do t=$a; done; mkdir -p "$t/.git"; n=$(( $(cat "${d}/n") + 1 )); echo $n > "${d}/n"; if [ "$n" -le ${o.fails} ]; then echo "${o.msg ?? 'git@github.com: Permission denied (publickey).'}" >&2; exit ${o.rc ?? 128}; fi; fi\nexit 0\n`,
	)
	writeFileSync(join(bin, 'sleep'), `#!/bin/bash\necho "sleep $*" >> "${d}/log"\n`)
	for (const n of ['git', 'sleep']) chmodSync(join(bin, n), 0o755)
	const sh = builderCloneShell(join(d, 'b'), 'git@github.com:o/r.git', 'main', o.sha ?? null)
	const r = spawnSync('bash', ['-c', `set -e; ${sh} echo CLONED`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
	return { out: r.stdout + r.stderr, rc: r.status, log: readFileSync(join(d, 'log'), 'utf8') }
}

describe('builderCloneShell', () => {
	it('succeeds first time without retry', () => {
		const r = run({ fails: 0 })
		expect(r.rc).toBe(0)
		expect(r.out).toContain('CLONED')
		expect(r.out).not.toContain('retrying')
	})
	it('retries a publickey failure twice with 5s then 15s backoff, then succeeds', () => {
		const r = run({ fails: 2 })
		expect(r.rc).toBe(0)
		expect(r.out).toContain('[builder] clone attempt 1 failed, retrying')
		expect(r.out).toContain('[builder] clone attempt 2 failed, retrying')
		expect(r.log.match(/^sleep .*/gm)).toEqual(['sleep 5', 'sleep 15'])
		expect(r.out).toContain('CLONED')
	})
	it('gives up after 3 attempts and returns the git exit code', () => {
		const r = run({ fails: 9 })
		expect(r.rc).toBe(128)
		expect(r.log.match(/^git .* clone --depth/gm)).toHaveLength(3)
		expect(r.out).not.toContain('CLONED')
	})
	it('retries "Could not read from remote repository"', () => {
		const r = run({ fails: 1, msg: 'fatal: Could not read from remote repository.' })
		expect(r.rc).toBe(0)
		expect(r.out).toContain('clone attempt 1 failed')
	})
	it('does not retry other errors (e.g. branch not found) or other exit codes', () => {
		const a = run({ fails: 1, msg: 'fatal: Remote branch x not found' })
		expect(a.rc).toBe(128)
		expect(a.out).not.toContain('retrying')
		const b = run({ fails: 1, rc: 1 })
		expect(b.rc).toBe(1)
		expect(b.out).not.toContain('retrying')
	})
	it('pinned sha: only the branch tip may be pinned (rev-parse inside the retried unit, no fetch of arbitrary shas)', () => {
		const r = run({ fails: 1, sha: 'a'.repeat(40) })
		expect(r.rc).toBe(0)
		expect(r.log).toContain('rev-parse HEAD')
		expect(r.log).not.toContain('fetch --depth 1 origin')
		expect(r.log).not.toContain('checkout -q --detach')
	})
})
