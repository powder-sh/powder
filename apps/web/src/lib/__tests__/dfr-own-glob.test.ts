import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerfileRewriteFunctions } from '../build-cache'

// dfr_own iterates `for __o in $DFR_OWN` unquoted, so a `*` in an own image
// name would glob against the cwd: globbing is off for the loop and restored after.

const dir = mkdtempSync(join(tmpdir(), 'dfr-own-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
writeFileSync(join(dir, 'other'), '')

function sh(body: string, own: string) {
	const r = spawnSync('bash', ['-c', `${dockerfileRewriteFunctions('app')}${body}`], {
		cwd: dir,
		encoding: 'utf8',
		// DFR_OWNED '*' = no ownership list (the server's build list alone decides)
		env: { ...process.env, DFR_OWN: own, DFR_OWNED: '*' },
	})
	return { rc: r.status, out: r.stdout.trim() }
}

describe('dfr_own does not glob', () => {
	it('a `*` own entry matches only itself, not the files in the cwd', () => {
		expect(sh('dfr_own other:latest', '* shop').rc).toBe(1)
		expect(sh('dfr_own shop:1', '* shop').rc).toBe(0)
		expect(sh('dfr_own registry.example/shop@sha256:ab', 'x registry.example/shop:2').rc).toBe(0)
		expect(sh('dfr_own nope', '').rc).toBe(1)
	})
	it('restores the caller globbing state', () => {
		expect(sh('dfr_own shop; case $- in *f*) echo off;; *) echo on;; esac', 'shop').out).toBe('on')
		expect(
			sh('set -f; dfr_own shop; case $- in *f*) echo off;; *) echo on;; esac', 'shop').out,
		).toBe('off')
	})
})
